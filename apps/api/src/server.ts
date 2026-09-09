import Fastify from "fastify";
import { z } from "zod";
import Stripe from "stripe";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  AuthorizationRequestSchema,
  EMPTY_DIRECTORY,
  buildConfirmation,
  createCompileContext,
  createCompilerFromEnv,
  hashPolicy,
  loadCompilerFixtures,
  loadEvidencePublicKey,
  parsePolicy,
  verifyEvidenceChain,
  POLICY_SCHEMA_VERSION,
  REASON_CODE_DESCRIPTIONS,
  type EvidenceEvent,
  type IntentCompiler,
  type PaymentAdapter,
} from "@waysafe/core";
import { InMemoryAgentKeyRepository } from "./agent-keys/in-memory-repository.js";
import type { AgentKeyRecord, AgentKeyRepository } from "./agent-keys/types.js";
import { InMemoryPrincipalRepository } from "./principals/in-memory-repository.js";
import type { PrincipalRecord, PrincipalRepository } from "./principals/types.js";
import { InMemoryInstrumentRepository } from "./instruments/in-memory-repository.js";
import type { InstrumentRepository } from "./instruments/types.js";
import { authorize, resolveStepUp } from "./authorization/service.js";
import { InMemoryAuthorizationRepository } from "./authorization/in-memory-repository.js";
import type {
  AgentListItem,
  AuthorizationRepository,
  MandateDetail,
  MandateListItem,
  StoredAuthorization,
} from "./authorization/types.js";
import { InMemoryEvidenceRepository } from "./evidence/in-memory-repository.js";
import type { EvidenceRepository } from "./evidence/types.js";
import { loadOrGenerateEvidenceSigningKey } from "./evidence/signing-key.js";
import { asExecutable } from "./execution/executable.js";
import { executePayment } from "./execution/service.js";
import { StripeAdapter } from "./payments/stripe-adapter.js";
import { X402Adapter } from "./payments/x402-adapter.js";
import { probeStripeKey } from "./payments/stripe-key.js";
import { InMemoryProviderEventRepository } from "./webhooks/in-memory-repository.js";
import type { ProviderEventRepository } from "./webhooks/types.js";
import { handleStripeWebhook } from "./webhooks/service.js";
import { StripeIssuingAdapter, handleIssuingAuthorizationRequest } from "./enforcement/stripe-issuing.js";
import { InMemoryWebauthnRepository } from "./webauthn/in-memory-repository.js";
import type { WebauthnRepository } from "./webauthn/types.js";
import {
  beginMandateAuthentication,
  beginRegistration,
  completeMandateAuthentication,
  completeRegistration,
  type WebauthnServiceRepos,
} from "./webauthn/service.js";
import type { WebauthnConfig } from "./webauthn/webauthn.js";

const CompileBodySchema = z.object({
  intent_text: z.string().min(1).max(4000),
  /** Optional overrides; both default from the environment. */
  timezone: z.string().min(1).optional(),
  currency: z.literal("USD").optional(),
  default_ttl_hours: z.number().int().positive().max(8760).optional(),
});

const CreateMandateBodySchema = z.object({
  principal_id: z.string().min(1),
  agent_ids: z.array(z.string().min(1)).min(1),
  /** A policy already validated by /v1/mandates/compile or /v1/policies/validate. */
  policy: z.record(z.unknown()),
  intent_text: z.string().min(1),
  compiler_name: z.string().min(1).default("manual"),
  compiler_model: z.string().optional(),
  assumptions: z.array(z.string()).default([]),
});

const AuthenticateVerifyBodySchema = z.object({
  mode: z.enum(["register", "authenticate"]),
  challenge: z.string().min(1),
  response: z.record(z.unknown()),
});

const CreateAgentBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const CreatePrincipalBodySchema = z.object({
  display_name: z.string().min(1),
  email: z.string().email().optional(),
  type: z.enum(["INDIVIDUAL", "ORGANIZATION"]).optional(),
});

const CreateAgentKeyBodySchema = z.object({
  name: z.string().min(1),
});

const StepUpBodySchema = z.object({
  outcome: z.enum(["approved", "declined"]),
});

const ExecuteBodySchema = z.object({
  rail: z.string().min(1),
  payment_method_ref: z.string().min(1),
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const DEFAULT_LIST_LIMIT = 50;

export interface ServerRepos {
  authorization: AuthorizationRepository;
  agentKeys: AgentKeyRepository;
  evidence: EvidenceRepository;
  webauthn: WebauthnRepository;
  providerEvents: ProviderEventRepository;
  principals: PrincipalRepository;
  instruments: InstrumentRepository;
}

export interface BuildServerOptions {
  compiler?: IntentCompiler;
  logger?: boolean;
  repos?: ServerRepos;
  webauthnConfig?: WebauthnConfig;
  /** Keyed by PaymentAdapter.name ("stripe", "x402"). Defaults to x402
   * always registered, plus stripe when STRIPE_SECRET_KEY looks real
   * (test-mode key, not the .env.example placeholder). */
  adapters?: Record<string, PaymentAdapter>;
  stripeWebhookSecret?: string;
  /** D-32: the signing secret for Stripe's Issuing authorization webhook.
   * Deliberately a separate value from stripeWebhookSecret -- a real Stripe
   * account issues one signing secret per configured webhook endpoint, and
   * /v1/webhooks/stripe and /v1/enforcement/stripe-issuing are two
   * different endpoints; reusing one secret for both would only work by
   * coincidence (both configured with the same value in the dashboard). */
  stripeIssuingWebhookSecret?: string;
}

interface AuthContext {
  organizationId: string;
  /** Null for an org credential; a real agent id for an agent API key (D-18). */
  agentId: string | null;
  apiKey: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    /** Populated for every request by a content-type parser override, so
     * the Stripe webhook route can verify its HMAC signature against the
     * exact bytes Stripe signed -- a re-serialized parsed body would not
     * byte-match and every signature would fail. */
    rawBody?: Buffer;
  }
}

/** Routes that work without any credential -- everything else needs an
 * agent API key or an org credential (Phase 4 auth rule). The Stripe
 * webhook route (and the Stripe Issuing enforcement route, D-32) are exempt
 * for the same reason: neither is a Waysafe caller presenting a Bearer
 * credential -- it's Stripe presenting an HMAC signature over the raw body,
 * checked inside the route itself. This is precisely D-32's point: the
 * enforcement route is the one path in this file no Waysafe credential
 * gates at all, because it must never depend on the agent (or anything
 * holding an agent's credential) cooperating. The evidence
 * public key is exempt because the whole point of D-26/OQ-8 is that a third
 * party -- who by definition has no Waysafe credential -- can verify a chain
 * independently; gating the key that makes that possible behind a Waysafe
 * credential would defeat it. */
const PUBLIC_ROUTES = new Set([
  "/health",
  "/v1/reason-codes",
  "/v1/webhooks/stripe",
  "/v1/enforcement/stripe-issuing",
  "/v1/evidence/public-key",
]);

function zodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: `/${i.path.join("/")}`, message: i.message }));
}

function toReceiptJSON(auth: StoredAuthorization) {
  return {
    id: auth.id,
    organization_id: auth.organization_id,
    // D-35: additive (D-11) -- who acted. agent_id/instrument_id are
    // unchanged in shape (still whichever one was already there for an
    // agent-actor authorization); actor_kind and instrument_id are new.
    actor_kind: auth.actor_kind,
    agent_id: auth.agent_id,
    instrument_id: auth.instrument_id,
    principal_id: auth.principal_id,
    mandate_id: auth.mandate_id,
    mandate_version_id: auth.mandate_version_id,
    policy_hash: auth.policy_hash,
    decision: auth.decision,
    status: auth.status,
    reasons: auth.reasons,
    action: auth.action,
    merchant: auth.merchant,
    idempotency_key: auth.idempotency_key,
    step_up_expires_at: auth.step_up_expires_at,
    created_at: auth.created_at,
    decided_at: auth.decided_at,
  };
}

function toEvidenceJSON(event: EvidenceEvent) {
  return {
    id: event.id,
    organization_id: event.organization_id,
    sequence: event.sequence,
    type: event.type,
    subject_type: event.subject_type,
    subject_id: event.subject_id,
    payload: event.payload,
    previous_hash: event.previous_hash,
    hash: event.hash,
    signature: event.signature,
    created_at: event.created_at.toISOString(),
  };
}

function toMandateListJSON(mandate: MandateListItem) {
  return {
    mandate_id: mandate.mandateId,
    organization_id: mandate.organizationId,
    principal_id: mandate.principalId,
    status: mandate.status,
    policy_hash: mandate.policyHash,
    summary: mandate.summary,
    created_at: mandate.createdAt,
  };
}

function toMandateDetailJSON(mandate: MandateDetail) {
  return {
    ...toMandateListJSON(mandate),
    mandate_version_id: mandate.mandateVersionId,
    policy: mandate.policy,
    intent_text: mandate.intentText,
    assumptions: mandate.assumptions,
    agent_ids: mandate.agentIds,
    authenticated_at: mandate.authenticatedAt,
  };
}

function toAgentJSON(agent: AgentListItem) {
  return {
    agent_id: agent.agentId,
    organization_id: agent.organizationId,
    name: agent.name,
    status: agent.status,
    created_at: agent.createdAt,
  };
}

function toPrincipalJSON(principal: PrincipalRecord) {
  return {
    principal_id: principal.id,
    organization_id: principal.organizationId,
    display_name: principal.displayName,
    email: principal.email,
    type: principal.type,
    created_at: principal.createdAt.toISOString(),
  };
}

function toKeyJSON(key: AgentKeyRecord) {
  return {
    key_id: key.id,
    organization_id: key.organizationId,
    agent_id: key.agentId,
    prefix: key.prefix,
    name: key.name,
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
    created_at: key.createdAt.toISOString(),
  };
}

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            // Nothing that could carry a credential reaches the logs. The list
            // grows as adapters land; it is never allowed to shrink.
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'req.headers["x-api-key"]',
                "req.body.card",
                "req.body.payment_method",
                "res.headers['set-cookie']",
              ],
              censor: "[redacted]",
            },
          },
  });

  // Preserves the exact bytes of every JSON body alongside the normal
  // parsed object -- the webhook route needs the raw bytes for signature
  // verification; re-serializing the parsed JSON would not byte-match what
  // Stripe actually signed, and every signature check would spuriously fail.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, rawBody, done) => {
    const body = rawBody as Buffer;
    request.rawBody = body;
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const compiler = options.compiler ?? createCompilerFromEnv(loadCompilerFixtures());

  const repos: ServerRepos = options.repos ?? {
    authorization: new InMemoryAuthorizationRepository(EMPTY_DIRECTORY),
    agentKeys: new InMemoryAgentKeyRepository(),
    evidence: new InMemoryEvidenceRepository(
      loadOrGenerateEvidenceSigningKey((msg) => app.log.warn(msg)),
    ),
    webauthn: new InMemoryWebauthnRepository(),
    providerEvents: new InMemoryProviderEventRepository(),
    principals: new InMemoryPrincipalRepository(),
    instruments: new InMemoryInstrumentRepository(),
  };

  const webauthnConfig: WebauthnConfig = options.webauthnConfig ?? {
    rpId: process.env.WAYSAFE_RP_ID ?? "localhost",
    origin: process.env.WAYSAFE_RP_ORIGIN ?? "http://localhost:3000",
  };

  const webauthnRepos: WebauthnServiceRepos = {
    webauthn: repos.webauthn,
    authorization: repos.authorization,
    evidence: repos.evidence,
  };

  const adapters: Record<string, PaymentAdapter> =
    options.adapters ??
    (() => {
      const registered: Record<string, PaymentAdapter> = { x402: new X402Adapter() };
      if (probeStripeKey()) {
        registered.stripe = new StripeAdapter(process.env.STRIPE_SECRET_KEY!);
      }
      return registered;
    })();

  // Only used to verify webhook signatures locally (constructEvent/
  // generateTestHeaderString are pure HMAC operations, no network calls) --
  // not tied to whether a real STRIPE_SECRET_KEY is configured. Dev/test
  // default is fine to ship; production deployments should set the real
  // secret from the Stripe dashboard once a live webhook endpoint exists.
  const stripeWebhookSecret =
    options.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_dev_placeholder";
  const stripeForWebhooks = new Stripe("sk_test_unused_for_webhook_verification");

  // Same reasoning as stripeForWebhooks above, reused rather than duplicated:
  // constructEvent/getApiField are local operations, so no real key is
  // needed just to verify a signature or read the library's API version.
  const stripeIssuingWebhookSecret =
    options.stripeIssuingWebhookSecret ??
    process.env.STRIPE_ISSUING_WEBHOOK_SECRET ??
    "whsec_dev_placeholder";
  const stripeIssuingAdapter = new StripeIssuingAdapter();

  /**
   * Phase 4 auth rule: every route except /health and /v1/reason-codes
   * requires a Bearer credential -- an agent API key or an org credential
   * (same table, same verification; D-18's agent-keys module, broadened).
   * No credential at all is a 401 here, at the HTTP layer, before any
   * handler runs. An authenticated credential that turns out not to be the
   * *right* one for what it's trying to do (an agent key that doesn't match
   * the claimed agent, an org credential presented to POST
   * /v1/authorizations) is deliberately NOT rejected here -- it falls
   * through to authorize()'s own key check, which turns it into a recorded
   * DENY_AGENT_NOT_BOUND decision, per D-18. The distinction the rule draws
   * is "no credential" (401, nothing recorded) vs "a credential, just not
   * the one that authorizes this" (a decision, recorded like any other).
   */
  app.addHook("preHandler", async (request, reply) => {
    const routePath = request.routeOptions?.url ?? request.url.split("?")[0];
    if (PUBLIC_ROUTES.has(routePath ?? "")) return;

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "This route requires a Bearer credential (an agent API key or an org credential).",
      });
    }

    const verification = await repos.agentKeys.verifyKey(token, new Date());
    if (!verification.ok) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "The presented credential is invalid or revoked.",
      });
    }

    request.auth = {
      organizationId: verification.organizationId,
      agentId: verification.agentId,
      apiKey: token,
    };
  });

  app.get("/health", async () => ({
    status: "ok",
    policy_schema_version: POLICY_SCHEMA_VERSION,
    compiler: compiler.name,
  }));

  /**
   * Week 1 exit criteria:
   * a developer submits a natural-language mandate and receives a validated
   * structured policy object.
   *
   * This endpoint deliberately does NOT create a mandate. Compiling is a
   * proposal; the mandate exists only once the principal has seen the
   * confirmation and authenticated it. POST /v1/mandates (Phase 4) is the
   * step that persists one, closing the gap D-7 left open.
   */
  app.post("/v1/mandates/compile", async (request, reply) => {
    const body = CompileBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const context = createCompileContext({
      now: new Date(),
      ...(body.data.timezone ? { timezone: body.data.timezone } : {}),
      ...(body.data.currency ? { currency: body.data.currency } : {}),
      ...(body.data.default_ttl_hours
        ? { default_ttl_hours: body.data.default_ttl_hours }
        : {}),
    });

    const result = await compiler.compile({
      intent_text: body.data.intent_text,
      context,
    });

    if (result.status === "failed") {
      return reply.code(422).send({
        status: "failed",
        error: "policy_compilation_failed",
        issues: result.issues,
        diagnostics: result.diagnostics,
      });
    }

    if (result.status === "needs_clarification") {
      // 200, not an error: asking is a valid, expected outcome.
      return reply.code(200).send({
        status: "needs_clarification",
        clarifications: result.clarifications,
        draft: result.draft,
        diagnostics: result.diagnostics,
      });
    }

    return reply.code(200).send({
      status: "compiled",
      policy: result.policy,
      policy_hash: hashPolicy(result.policy),
      confirmation: buildConfirmation(result),
      diagnostics: result.diagnostics,
    });
  });

  /** Validate a hand-authored policy without going through the compiler. */
  app.post("/v1/policies/validate", async (request, reply) => {
    const result = parsePolicy(request.body);
    return reply.code(result.ok ? 200 : 422).send({
      ok: result.ok,
      issues: result.issues,
      ...(result.policy ? { policy_hash: hashPolicy(result.policy) } : {}),
    });
  });

  /** The reason-code dictionary, so SDK and dashboard consumers can render them. */
  app.get("/v1/reason-codes", async () => ({
    reason_codes: Object.entries(REASON_CODE_DESCRIPTIONS).map(
      ([code, description]) => ({ code, description }),
    ),
  }));

  /** Persists a compiled, confirmed policy as a Mandate + first MandateVersion,
   * status PENDING_AUTHENTICATION. Closes the D-7 gap. */
  app.post("/v1/mandates", async (request, reply) => {
    const body = CreateMandateBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const parsed = parsePolicy(body.data.policy);
    if (!parsed.ok || !parsed.policy) {
      return reply.code(422).send({ error: "invalid_policy", issues: parsed.issues });
    }

    const created = await repos.authorization.createMandate(
      {
        organizationId: request.auth!.organizationId,
        principalId: body.data.principal_id,
        agentIds: body.data.agent_ids,
        policy: parsed.policy,
        policyHash: hashPolicy(parsed.policy),
        intentText: body.data.intent_text,
        compilerName: body.data.compiler_name,
        compilerModel: body.data.compiler_model,
        assumptions: body.data.assumptions,
      },
      new Date(),
    );

    return reply.code(201).send({
      mandate_id: created.mandateId,
      mandate_version_id: created.mandateVersionId,
      policy_hash: created.policyHash,
      status: "PENDING_AUTHENTICATION",
    });
  });

  /**
   * Whether the principal needs to register a first passkey or sign with
   * one already on file: registration options (a random challenge) if
   * they've never registered, mandate-authentication options (D-20:
   * challenge = base64url(policy_hash)) once they have.
   */
  app.post("/v1/mandates/:id/authenticate/options", async (request, reply) => {
    const { id: mandateId } = request.params as { id: string };
    const summary = await repos.authorization.getMandateSummary(mandateId);
    if (!summary || summary.organizationId !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const now = new Date();
    const hasCredential = await repos.webauthn.hasCredentialForPrincipal(summary.principalId);

    if (!hasCredential) {
      const { challenge } = await beginRegistration(webauthnRepos, summary.principalId, now);
      return reply.send({
        mode: "register",
        challenge,
        rp_id: webauthnConfig.rpId,
        origin: webauthnConfig.origin,
        principal_id: summary.principalId,
      });
    }

    const { challenge } = await beginMandateAuthentication(
      webauthnRepos,
      summary.principalId,
      summary.policyHash,
      now,
    );
    return reply.send({
      mode: "authenticate",
      challenge,
      rp_id: webauthnConfig.rpId,
      origin: webauthnConfig.origin,
      principal_id: summary.principalId,
    });
  });

  /** Completes whichever ceremony /authenticate/options started. Only the
   * "authenticate" mode can activate a mandate (D-20). */
  app.post("/v1/mandates/:id/authenticate/verify", async (request, reply) => {
    const { id: mandateId } = request.params as { id: string };
    const body = AuthenticateVerifyBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const summary = await repos.authorization.getMandateSummary(mandateId);
    if (!summary || summary.organizationId !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const now = new Date();

    if (body.data.mode === "register") {
      const result = await completeRegistration(
        webauthnRepos,
        webauthnConfig,
        {
          organizationId: summary.organizationId,
          principalId: summary.principalId,
          response: body.data.response as unknown as RegistrationResponseJSON,
          claimedChallenge: body.data.challenge,
        },
        now,
      );
      return reply.code(result.kind === "registered" ? 200 : 401).send(result);
    }

    const result = await completeMandateAuthentication(
      webauthnRepos,
      webauthnConfig,
      {
        organizationId: summary.organizationId,
        principalId: summary.principalId,
        mandateId: summary.mandateId,
        mandateVersionId: summary.mandateVersionId,
        policyHash: summary.policyHash,
        response: body.data.response as unknown as AuthenticationResponseJSON,
        ip: request.ip,
      },
      now,
    );
    return reply.code(result.kind === "activated" ? 200 : 401).send(result);
  });

  /**
   * The real authorize() call. An agent API key is the intended credential
   * (D-18); an org credential presented here isn't rejected at this layer
   * -- authorize()'s own key check rejects it as a mismatched agent,
   * recorded as an ordinary DENY, same as any other agent key that doesn't
   * match what the request claims.
   */
  app.post("/v1/authorizations", async (request, reply) => {
    const body = AuthorizationRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const result = await authorize(
      { authorization: repos.authorization, agentKeys: repos.agentKeys, evidence: repos.evidence },
      {
        organizationId: request.auth!.organizationId,
        request: body.data,
        now: new Date(),
        apiKey: request.auth!.apiKey,
      },
    );

    if (result.kind === "no_mandate") {
      return reply.code(404).send({ error: "no_active_mandate", reasons: result.reasons });
    }
    if (result.kind === "idempotency_conflict") {
      return reply.code(409).send({
        error: "idempotency_conflict",
        existing: toReceiptJSON(result.existing),
      });
    }
    return reply.code(result.replayed ? 200 : 201).send(toReceiptJSON(result.authorization));
  });

  /**
   * A pending step-up past its TTL is expired lazily, on the next thing
   * that looks at it, rather than by a background sweep -- there's no job
   * infrastructure in this build. Releases the reservation the same way an
   * explicit decline does (resolveStepUp's own job); returns the
   * authorization unchanged if there was nothing to expire.
   */
  async function expireIfNeeded(stored: StoredAuthorization, now: Date): Promise<StoredAuthorization> {
    if (stored.status !== "PENDING_STEP_UP") return stored;
    if (!stored.step_up_expires_at) return stored;
    if (new Date(stored.step_up_expires_at).getTime() > now.getTime()) return stored;
    return resolveStepUp(repos.authorization, stored.mandate_id, stored.id, "expired", now);
  }

  /** The receipt. */
  app.get("/v1/authorizations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const stored = await repos.authorization.getAuthorization(id);
    if (!stored || stored.organization_id !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const current = await expireIfNeeded(stored, new Date());
    return reply.send(toReceiptJSON(current));
  });

  /** Approve or decline a pending step-up. Declining (or a stale pending
   * step-up simply being looked at past its TTL) releases the reservation --
   * approving does not execute; POST .../execute is the separate, explicit
   * step for that, same as for a fresh ALLOW. */
  app.post("/v1/authorizations/:id/step-up", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = StepUpBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const stored = await repos.authorization.getAuthorization(id);
    if (!stored || stored.organization_id !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const now = new Date();
    const current = await expireIfNeeded(stored, now);
    if (current.status !== "PENDING_STEP_UP") {
      return reply.code(409).send({ error: "not_pending_step_up", status: current.status });
    }

    const updated = await resolveStepUp(repos.authorization, current.mandate_id, id, body.data.outcome, now);
    return reply.send(toReceiptJSON(updated));
  });

  /**
   * It is structurally impossible to execute a DENIED or PENDING_STEP_UP
   * authorization here: `asExecutable` (execution/executable.ts) is the
   * only way to obtain an `ExecutableAuthorization`, `executePayment` only
   * accepts one, and there is no `as`-cast anywhere on this path. A status
   * that doesn't qualify gets `null` back and a 409, before any adapter is
   * ever called.
   */
  app.post("/v1/authorizations/:id/execute", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = ExecuteBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const stored = await repos.authorization.getAuthorization(id);
    if (!stored || stored.organization_id !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const now = new Date();
    const current = await expireIfNeeded(stored, now);
    const executable = asExecutable(current);
    if (!executable) {
      return reply.code(409).send({
        error: "not_executable",
        status: current.status,
        message: `Authorization status is ${current.status}; only AUTHORIZED or STEP_UP_APPROVED can execute.`,
      });
    }

    const adapter = adapters[body.data.rail];
    if (!adapter) {
      return reply.code(400).send({ error: "unknown_rail", rail: body.data.rail });
    }

    const result = await executePayment(
      { authorization: repos.authorization, evidence: repos.evidence },
      executable,
      adapter,
      body.data.payment_method_ref,
      now,
    );

    if (result.kind === "rejected") {
      return reply.code(402).send({ error: "execution_rejected", reason: result.reason });
    }
    return reply.send(toReceiptJSON(result.authorization));
  });

  /**
   * Stripe webhooks. Not behind the Bearer-credential gate (PUBLIC_ROUTES) --
   * Stripe authenticates itself with an HMAC signature over the raw body,
   * checked here instead. Idempotent: the same event id delivered twice
   * (a provider retry, or an attacker replaying a captured payload) applies
   * its ledger effect once -- see webhooks/service.ts and
   * webhooks/types.ts's ProviderEventRepository.
   */
  app.post("/v1/webhooks/stripe", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      return reply.code(400).send({ error: "missing_signature" });
    }
    if (!request.rawBody) {
      return reply.code(400).send({ error: "missing_body" });
    }

    let event;
    try {
      event = stripeForWebhooks.webhooks.constructEvent(request.rawBody, signature, stripeWebhookSecret);
    } catch (err) {
      return reply.code(400).send({
        error: "invalid_signature",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const result = await handleStripeWebhook(
      { providerEvents: repos.providerEvents, authorization: repos.authorization, evidence: repos.evidence },
      event,
      new Date(),
    );
    return reply.send(result);
  });

  /**
   * D-32: Stripe Issuing's synchronous authorization webhook -- the actual
   * enforcement chokepoint. Stripe waits on this response (~2 second
   * timeout) before the card network's authorization proceeds; a rogue,
   * jailbroken, or credential-stealing agent has no `authorize()` call to
   * skip here, because nothing about this path depends on the agent making
   * one. Same signature-over-raw-body authentication as
   * /v1/webhooks/stripe, a different (D-32) signing secret -- see
   * BuildServerOptions.stripeIssuingWebhookSecret.
   *
   * Every response carries the library's configured Stripe-Version header
   * and a body of exactly `{ approved, reason_codes }`: Stripe reads only
   * `approved`; `reason_codes` is Waysafe's own addition for observability
   * (Stripe ignores unknown fields) and is what lets a caller -- including
   * the bypass test this route is judged by -- see which reason code the
   * decline actually carried without a second round trip to fetch evidence.
   */
  app.post("/v1/enforcement/stripe-issuing", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      return reply.code(400).send({ error: "missing_signature" });
    }
    if (!request.rawBody) {
      return reply.code(400).send({ error: "missing_body" });
    }

    let event: Stripe.Event;
    try {
      event = stripeForWebhooks.webhooks.constructEvent(request.rawBody, signature, stripeIssuingWebhookSecret);
    } catch (err) {
      return reply.code(400).send({
        error: "invalid_signature",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    reply.header("Stripe-Version", stripeForWebhooks.getApiField("version"));

    if (event.type !== "issuing_authorization.request") {
      // Only issuing_authorization.request is a synchronous decision this
      // route owes a same-request answer to. Anything else delivered here
      // is a dashboard misconfiguration (this endpoint registered for more
      // than the one synchronous event type) -- fail closed without
      // fabricating a reason code for a decision evaluate() never made.
      app.log.warn(`unexpected event type on /v1/enforcement/stripe-issuing: ${event.type}`);
      return reply.send({ approved: false, reason_codes: [] });
    }

    const authorization = event.data.object as Stripe.Issuing.Authorization;
    const decision = await handleIssuingAuthorizationRequest(
      { authorization: repos.authorization, evidence: repos.evidence, instruments: repos.instruments },
      stripeIssuingAdapter,
      authorization,
      new Date(),
    );
    return reply.send(decision.response);
  });

  app.post("/v1/agents", async (request, reply) => {
    const body = CreateAgentBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const created = await repos.authorization.createAgent(
      {
        organizationId: request.auth!.organizationId,
        name: body.data.name,
        description: body.data.description,
      },
      new Date(),
    );
    return reply.code(201).send({
      agent_id: created.agentId,
      name: created.name,
      status: created.status,
    });
  });

  /** OQ-9: the route an external developer needs to complete an
   * integration -- without it there is no way to get a `principal_id`
   * that `POST /v1/mandates` will accept, other than seeding the row by
   * hand against Postgres directly. Same auth rule as every other route
   * here: any valid credential for this organization, agent key or org
   * credential alike (D-18) -- creating a principal isn't an agent-scoped
   * action, so nothing about D-18's agentId binding applies. */
  app.post("/v1/principals", async (request, reply) => {
    const body = CreatePrincipalBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const created = await repos.principals.createPrincipal(
      {
        organizationId: request.auth!.organizationId,
        displayName: body.data.display_name,
        email: body.data.email,
        type: body.data.type,
      },
      new Date(),
    );
    return reply.code(201).send(toPrincipalJSON(created));
  });

  app.get("/v1/principals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const principal = await repos.principals.getPrincipal(id, request.auth!.organizationId);
    if (!principal) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(toPrincipalJSON(principal));
  });

  /** Mints an agent API key. The full key is shown exactly once, here. */
  app.post("/v1/agents/:id/keys", async (request, reply) => {
    const { id: agentId } = request.params as { id: string };
    const body = CreateAgentKeyBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(body.error) });
    }

    const created = await repos.agentKeys.createKey(
      { organizationId: request.auth!.organizationId, agentId, name: body.data.name },
      new Date(),
    );
    return reply.code(201).send({
      key_id: created.id,
      prefix: created.prefix,
      api_key: created.fullKey,
      created_at: created.createdAt.toISOString(),
    });
  });

  app.delete("/v1/agents/:id/keys/:keyId", async (request, reply) => {
    const { keyId } = request.params as { id: string; keyId: string };
    const revoked = await repos.agentKeys.revokeKey(keyId, request.auth!.organizationId, new Date());
    if (!revoked) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(204).send();
  });

  /** Dashboard reads (Week 5). Most-recent-first, org-scoped (D-1). */
  app.get("/v1/mandates", async (request, reply) => {
    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(query.error) });
    }
    const mandates = await repos.authorization.listMandates(
      request.auth!.organizationId,
      query.data.limit ?? DEFAULT_LIST_LIMIT,
    );
    return reply.send({ mandates: mandates.map(toMandateListJSON) });
  });

  app.get("/v1/mandates/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mandate = await repos.authorization.getMandateDetail(id);
    if (!mandate || mandate.organizationId !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(toMandateDetailJSON(mandate));
  });

  /** The authorization log. Most-recent-first, org-scoped (D-1). */
  app.get("/v1/authorizations", async (request, reply) => {
    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", issues: zodIssues(query.error) });
    }
    const authorizations = await repos.authorization.listAuthorizations(
      request.auth!.organizationId,
      query.data.limit ?? DEFAULT_LIST_LIMIT,
    );
    return reply.send({ authorizations: authorizations.map(toReceiptJSON) });
  });

  app.get("/v1/agents", async (request, reply) => {
    const agents = await repos.authorization.listAgents(request.auth!.organizationId);
    return reply.send({ agents: agents.map(toAgentJSON) });
  });

  /** Every key in the organization -- agent keys and org credentials alike
   * (D-18: same table). Never includes the full key, only the prefix. */
  app.get("/v1/keys", async (request, reply) => {
    const keys = await repos.agentKeys.listKeysForOrganization(request.auth!.organizationId);
    return reply.send({ keys: keys.map(toKeyJSON) });
  });

  /** The evidence chain for this organization, optionally filtered to one
   * subject (`?subject=<subject_id>`). */
  app.get("/v1/evidence", async (request, reply) => {
    const { subject } = request.query as { subject?: string };
    const events = await repos.evidence.listForOrganization(request.auth!.organizationId);
    const filtered = subject ? events.filter((e) => e.subject_id === subject) : events;
    return reply.send({ events: filtered.map(toEvidenceJSON) });
  });

  /**
   * Verifiable by a third party, not just tamper-evident (D-26, resolves
   * OQ-8): recomputes the chain from stored rows, same as before, and now
   * also checks every event's signature against the published public key --
   * see /v1/evidence/public-key. `result.signed` is `true` only when that
   * check ran and passed; `result.ok` alone doesn't distinguish "verified
   * against a signature" from "internally consistent," so a caller checking
   * only `ok` gets the weaker, still-accurate claim either way.
   */
  app.get("/v1/evidence/verify", async (request, reply) => {
    const events = await repos.evidence.listForOrganization(request.auth!.organizationId);
    const publicKey = loadEvidencePublicKey(repos.evidence.getPublicKey());
    const result = verifyEvidenceChain(events, publicKey);
    return reply.send(result);
  });

  /**
   * The Ed25519 public key every evidence event's `signature` is checked
   * against (D-26/OQ-8). Deliberately public (see PUBLIC_ROUTES) and
   * deliberately not org-scoped: one signing key covers every
   * organization's chain on this deployment, so there's one key to publish,
   * not one per tenant. Base64 SPKI -- see @waysafe/core's
   * `loadEvidencePublicKey` to reconstruct a usable key from it.
   */
  app.get("/v1/evidence/public-key", async (_request, reply) => {
    return reply.send({ algorithm: "Ed25519", public_key: repos.evidence.getPublicKey() });
  });

  return app;
}
