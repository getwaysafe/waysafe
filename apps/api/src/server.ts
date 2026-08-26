import Fastify from "fastify";
import { z } from "zod";
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
  parsePolicy,
  verifyEvidenceChain,
  POLICY_SCHEMA_VERSION,
  REASON_CODE_DESCRIPTIONS,
  type EvidenceEvent,
  type IntentCompiler,
} from "@agentpay/core";
import { InMemoryAgentKeyRepository } from "./agent-keys/in-memory-repository.js";
import type { AgentKeyRepository } from "./agent-keys/types.js";
import { authorize } from "./authorization/service.js";
import { InMemoryAuthorizationRepository } from "./authorization/in-memory-repository.js";
import type { AuthorizationRepository, StoredAuthorization } from "./authorization/types.js";
import { InMemoryEvidenceRepository } from "./evidence/in-memory-repository.js";
import type { EvidenceRepository } from "./evidence/types.js";
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

const CreateAgentKeyBodySchema = z.object({
  name: z.string().min(1),
});

export interface ServerRepos {
  authorization: AuthorizationRepository;
  agentKeys: AgentKeyRepository;
  evidence: EvidenceRepository;
  webauthn: WebauthnRepository;
}

export interface BuildServerOptions {
  compiler?: IntentCompiler;
  logger?: boolean;
  repos?: ServerRepos;
  webauthnConfig?: WebauthnConfig;
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
  }
}

/** Routes that work without any credential -- everything else needs an
 * agent API key or an org credential (Phase 4 auth rule). */
const PUBLIC_ROUTES = new Set(["/health", "/v1/reason-codes"]);

function zodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: `/${i.path.join("/")}`, message: i.message }));
}

function toReceiptJSON(auth: StoredAuthorization) {
  return {
    id: auth.id,
    organization_id: auth.organization_id,
    agent_id: auth.agent_id,
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
    sequence: event.sequence,
    type: event.type,
    subject_type: event.subject_type,
    subject_id: event.subject_id,
    payload: event.payload,
    previous_hash: event.previous_hash,
    hash: event.hash,
    created_at: event.created_at.toISOString(),
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

  const compiler = options.compiler ?? createCompilerFromEnv(loadCompilerFixtures());

  const repos: ServerRepos = options.repos ?? {
    authorization: new InMemoryAuthorizationRepository(EMPTY_DIRECTORY),
    agentKeys: new InMemoryAgentKeyRepository(),
    evidence: new InMemoryEvidenceRepository(),
    webauthn: new InMemoryWebauthnRepository(),
  };

  const webauthnConfig: WebauthnConfig = options.webauthnConfig ?? {
    rpId: process.env.AGENTPAY_RP_ID ?? "localhost",
    origin: process.env.AGENTPAY_RP_ORIGIN ?? "http://localhost:3000",
  };

  const webauthnRepos: WebauthnServiceRepos = {
    webauthn: repos.webauthn,
    authorization: repos.authorization,
    evidence: repos.evidence,
  };

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

  /** The receipt. */
  app.get("/v1/authorizations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const stored = await repos.authorization.getAuthorization(id);
    if (!stored || stored.organization_id !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(toReceiptJSON(stored));
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

  /** The evidence chain for this organization, optionally filtered to one
   * subject (`?subject=<subject_id>`). */
  app.get("/v1/evidence", async (request, reply) => {
    const { subject } = request.query as { subject?: string };
    const events = await repos.evidence.listForOrganization(request.auth!.organizationId);
    const filtered = subject ? events.filter((e) => e.subject_id === subject) : events;
    return reply.send({ events: filtered.map(toEvidenceJSON) });
  });

  /** Tamper-evident, not tamper-proof (D-17): recomputes the chain from
   * stored rows and reports exactly where it stops matching, if anywhere. */
  app.get("/v1/evidence/verify", async (request, reply) => {
    const events = await repos.evidence.listForOrganization(request.auth!.organizationId);
    const result = verifyEvidenceChain(events);
    return reply.send(result);
  });

  return app;
}
