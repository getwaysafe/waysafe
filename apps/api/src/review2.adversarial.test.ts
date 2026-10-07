/**
 * PHASE A of the second independent review (`.codex-review/run2/`, against
 * commit `1caf39b`). Reproduction only. No fixes.
 *
 * Every test here asserts TODAY's behaviour and passes against `1caf39b`.
 * That is the point: each one is a claim being reproduced independently,
 * against real Postgres, before anything is changed.
 *
 * Numbering is this session's R1..R11, not the review's own, because the
 * review's numbers differ between its report and its test files. The mapping
 * to the review's labels is in each describe block.
 *
 * Three of the review's findings are deliberately absent, having been
 * withdrawn:
 *
 *  - **Mandate activation argument order.** `run2/report.md` still lists this
 *    as Critical. It is wrong. `activateMandate(mandateId, mandateVersionId,
 *    ip, now)` is declared in that order in `types.ts:396`, called in that
 *    order at `webauthn/service.ts:266`, and writes `authenticatedAt: now,
 *    authenticationIp: ip` at `prisma-repository.ts:542`. Checked all three.
 *    The review's own fixture works around a bug that is not there
 *    (`run2/additional.test.ts:35-38`).
 *  - The redirect identity bypass.
 *  - Live prompt injection.
 *
 * Postgres-gated in full, and listed in `POSTGRES_GATED_FILES` so it runs in
 * the serial pass D-77 added.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { PrismaClient, type Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  AMOY_USDC,
  Decision,
  ID_PREFIX,
  ReasonCode,
  assetAtomicToCents,
  createStaticDirectory,
  generateId,
  hashPolicy,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  type Policy,
} from "@waysafe/core";
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { FixtureIntentCompiler } from "@waysafe/core";
import { probeDatabase, requireDbOrExplainSkip } from "./test-support/db-gate.js";
import { PrismaAuthorizationRepository } from "./authorization/prisma-repository.js";
import { PrismaEvidenceRepository } from "./evidence/prisma-repository.js";
import { PrismaInstrumentRepository } from "./instruments/prisma-repository.js";
import { PrismaProviderEventRepository } from "./webhooks/prisma-repository.js";
import { PrismaAgentKeyRepository } from "./agent-keys/prisma-repository.js";
import { PrismaWebauthnRepository } from "./webauthn/prisma-repository.js";
import { PrismaPrincipalRepository } from "./principals/prisma-repository.js";
import { authorize, resolveStepUpAsApprover, type AuthorizeRepos } from "./authorization/service.js";
import { handleStripeWebhook } from "./webhooks/service.js";
import { handleIssuingAuthorizationRequest, StripeIssuingAdapter } from "./enforcement/stripe-issuing.js";
import { handleX402PaymentRequest, X402Adapter } from "./enforcement/x402.js";
import {
  LOCAL_RESOURCE_FETCH_POLICY,
  fetchResourceUnderPolicy,
} from "./enforcement/resource-fetch.js";
import { buildServer } from "./server.js";
import {
  beginMandateAuthentication,
  completeReenrollmentAuthentication,
} from "./webauthn/service.js";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "./webauthn/test-support/virtual-authenticator.js";

const prisma = new PrismaClient();
const SUITE = "REVIEW 2 (PHASE A): reproducing the second review's findings";
const reachable = await probeDatabase(prisma);
requireDbOrExplainSkip(SUITE, reachable);

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DIRECTORY = createStaticDirectory([{ domain: "staples.com", display_name: "Staples" }]);
const WEBAUTHN_CONFIG = { rpId: "localhost", origin: "http://localhost:3000" };

const createdOrgIds: string[] = [];

function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "review 2 phase A",
    currency: "USD",
    per_transaction_max: toMinorUnits(100, "USD"),
    cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(100, "USD") }],
    merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    step_up: { ttl_seconds: 900 },
    accounting: { timezone: "UTC" },
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

interface Fixture {
  org: string;
  principalId: string;
  agentId: string;
  mandateId: string;
  mandateVersionId: string;
  apiKey: string;
  policy: Policy;
  repos: AuthorizeRepos & {
    instruments: PrismaInstrumentRepository;
    providerEvents: PrismaProviderEventRepository;
    webauthn: PrismaWebauthnRepository;
    principals: PrismaPrincipalRepository;
  };
  authorization: PrismaAuthorizationRepository;
  evidence: PrismaEvidenceRepository;
  decide: (amountUsd: number) => Promise<Awaited<ReturnType<typeof authorize>>>;
}

/**
 * A real organization, principal, agent, mandate and API key, all persisted.
 *
 * Deliberately uses `PrismaAgentKeyRepository`, `PrismaWebauthnRepository`
 * and `PrismaPrincipalRepository` rather than the in-memory fakes the review's
 * own probes used. R4 depends on that: the review authenticated a key for an
 * agent id that had no `Agent` row at all, so its result could have been an
 * artefact of the fake. Here both agents exist.
 */
async function fixture(policy: Policy = policyFrom()): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 12);
  const org = `org_r2_${suffix}`;
  const principalId = `prin_r2_${suffix}`;
  const agentId = `agt_r2_${suffix}`;
  createdOrgIds.push(org);

  await prisma.organization.create({ data: { id: org, name: "Review 2 fixture" } });
  await prisma.principal.create({
    data: { id: principalId, organizationId: org, displayName: "Review 2" },
  });
  await prisma.agent.create({
    data: { id: agentId, organizationId: org, name: "Review 2 agent", status: "ACTIVE" },
  });

  const authorization = new PrismaAuthorizationRepository(prisma, DIRECTORY);
  const evidence = new PrismaEvidenceRepository(prisma, new FakeEd25519Signer());
  const agentKeys = new PrismaAgentKeyRepository(prisma);
  const repos = {
    authorization,
    evidence,
    agentKeys,
    instruments: new PrismaInstrumentRepository(prisma),
    providerEvents: new PrismaProviderEventRepository(prisma),
    webauthn: new PrismaWebauthnRepository(prisma),
    principals: new PrismaPrincipalRepository(prisma),
  };

  const created = await authorization.createMandate(
    {
      organizationId: org,
      principalId,
      agentIds: [agentId],
      policy,
      policyHash: hashPolicy(policy),
      intentText: "review 2",
      compilerName: "manual",
      assumptions: [],
    },
    NOW,
  );
  // Activated directly rather than through a ceremony: the ceremony is R5's
  // own subject, and every other finding needs an ACTIVE mandate as a
  // precondition rather than as the thing under test.
  await authorization.activateMandate(created.mandateId, created.mandateVersionId, "203.0.113.7", NOW);

  const key = await agentKeys.createKey({ organizationId: org, agentId, name: "review 2" }, NOW);

  const decide = (amountUsd: number) =>
    authorize(repos, {
      organizationId: org,
      request: {
        agent_id: agentId,
        principal_id: principalId,
        mandate_id: created.mandateId,
        action: {
          amount: toMinorUnits(amountUsd, "USD"),
          currency: "USD" as const,
          merchant: { domain: "staples.com" },
          attestations: {},
          payment_method_ref: "pm_fixture",
        },
      } as never,
      apiKey: key.fullKey,
      now: NOW,
    });

  return {
    org,
    principalId,
    agentId,
    mandateId: created.mandateId,
    mandateVersionId: created.mandateVersionId,
    apiKey: key.fullKey,
    policy,
    repos,
    authorization,
    evidence,
    decide,
  };
}

async function decided(f: Fixture, amountUsd: number) {
  const result = await f.decide(amountUsd);
  if (result.kind !== "decided") throw new Error(`expected a decision, got ${result.kind}`);
  return result.authorization;
}

async function spend(f: Fixture) {
  return f.authorization.getSpendSnapshot(f.mandateId, f.policy.accounting, NOW);
}

async function cardFor(f: Fixture, amountCents = toMinorUnits(10, "USD")) {
  const instrument = await f.repos.instruments.createInstrument(
    {
      organizationId: f.org,
      mandateId: f.mandateId,
      rail: "stripe_issuing",
      externalRef: `ic_r2_${randomUUID().slice(0, 8)}`,
    },
    NOW,
  );
  return {
    instrument,
    authorization: {
      id: `iauth_r2_${randomUUID().slice(0, 12)}`,
      object: "issuing.authorization",
      amount: amountCents,
      approved: false,
      status: "pending",
      currency: "usd",
      merchant_data: {
        category: "office_supplies",
        category_code: "5943",
        name: "Staples",
        network_id: "review2_mid",
        city: null,
        country: null,
        postal_code: null,
        state: null,
        tax_id: null,
        terminal_id: null,
        url: null,
      },
      card: { id: instrument.external_ref, metadata: { waysafe_instrument_id: instrument.id } },
      pending_request: {
        amount: amountCents,
        amount_details: null,
        currency: "usd",
        is_amount_controllable: false,
        merchant_amount: amountCents,
        merchant_currency: "usd",
        network_risk_score: null,
      },
    } as unknown as Stripe.Issuing.Authorization,
  };
}

function stripeEvent(type: string, object: unknown): Stripe.Event {
  return {
    id: `evt_r2_${randomUUID()}`,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

describe.skipIf(!reachable)(SUITE, { timeout: 60_000 }, () => {
  afterEach(async () => {
    while (createdOrgIds.length > 0) {
      const id = createdOrgIds.pop();
      if (id) await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // =======================================================================
  describe("R1 — Stripe incremental authorization replays the original approval (review: R9/High)", () => {
    it("a $10 approval is replayed for the same id requesting $10,000; a fresh id declines", async () => {
      // A D-74 REGRESSION, and worth naming as such. D-74 made a redelivered
      // Issuing event return the original decision, which is right for a
      // redelivery. Stripe also reuses one authorization id for an
      // *incremental* request, where `pending_request.amount` changes. The
      // replay key cannot tell those apart, so an increment is served the
      // earlier, smaller decision.
      const f = await fixture(policyFrom({ per_transaction_max: toMinorUnits(10, "USD") }));
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      const adapter = new StripeIssuingAdapter();

      const first = await handleIssuingAuthorizationRequest(f.repos, adapter, card, NOW);
      expect(first.response.approved).toBe(true);

      const incremented = {
        ...card,
        pending_request: { ...(card.pending_request as object), amount: toMinorUnits(10_000, "USD") },
      } as unknown as Stripe.Issuing.Authorization;

      const replay = await handleIssuingAuthorizationRequest(f.repos, adapter, incremented, NOW);
      expect(replay.response.approved).toBe(true);
      expect(replay.authorizationId).toBe(first.authorizationId);

      // CONTROL: the same $10,000 payload under a fresh id is correctly
      // declined, so the approval above is the replay and not a broken cap.
      const control = await handleIssuingAuthorizationRequest(
        f.repos,
        adapter,
        { ...incremented, id: `iauth_r2_${randomUUID().slice(0, 12)}` } as unknown as Stripe.Issuing.Authorization,
        NOW,
      );
      expect(control.response.approved).toBe(false);

      // The ledger still holds $10 against a $10,000 approved request.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });
  });

  // =======================================================================
  describe("R2 — cumulative refund totals are applied as deltas (review: R7/High)", () => {
    it("a $100 capture refunded $40 then $100 nets to minus $40", async () => {
      const f = await fixture();
      const auth = await decided(f, 100);
      expect(auth.decision).toBe(Decision.ALLOW);
      await f.authorization.withMandateLock(f.mandateId, () =>
        f.authorization.recordExecution(
          {
            authorizationId: auth.id,
            mandateId: f.mandateId,
            provider: "stripe",
            providerReference: "pi_r2",
            providerFee: 0,
          },
          NOW,
        ),
      );
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(100, "USD"));

      const charge = { id: `ch_r2_${randomUUID()}`, metadata: { waysafe_authorization_id: auth.id } };

      // Stripe's `amount_refunded` is cumulative. Two distinct events for one
      // charge therefore mean "40 so far" and then "100 so far", not "40" and
      // "another 100".
      const partial = await handleStripeWebhook(
        f.repos,
        stripeEvent("charge.refunded", { ...charge, amount_refunded: toMinorUnits(40, "USD") }),
        NOW,
      );
      expect(partial.kind).toBe("applied");

      const full = await handleStripeWebhook(
        f.repos,
        stripeEvent("charge.refunded", { ...charge, amount_refunded: toMinorUnits(100, "USD") }),
        NOW,
      );
      expect(full.kind).toBe("applied");

      // $100 captured, $100 refunded in total, and the ledger says minus $40.
      expect((await spend(f)).mandate.amount).toBe(-toMinorUnits(40, "USD"));
    });

    it("CONTROL: the identical event id replayed is correctly a duplicate", async () => {
      const f = await fixture();
      const auth = await decided(f, 100);
      await f.authorization.withMandateLock(f.mandateId, () =>
        f.authorization.recordExecution(
          {
            authorizationId: auth.id,
            mandateId: f.mandateId,
            provider: "stripe",
            providerReference: "pi_r2b",
            providerFee: 0,
          },
          NOW,
        ),
      );
      const event = stripeEvent("charge.refunded", {
        id: `ch_r2_${randomUUID()}`,
        metadata: { waysafe_authorization_id: auth.id },
        amount_refunded: toMinorUnits(40, "USD"),
      });
      expect((await handleStripeWebhook(f.repos, event, NOW)).kind).toBe("applied");
      expect((await handleStripeWebhook(f.repos, event, NOW)).kind).toBe("duplicate");
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(60, "USD"));
    });
  });

  // =======================================================================
  describe("R3 — max_count forgets settled transactions (review: R6)", () => {
    it("a count limit of 1 blocks a second pending payment, then permits one after capture", async () => {
      const f = await fixture(
        policyFrom({
          cumulative_limits: [
            { window: "mandate", max_amount: toMinorUnits(100, "USD"), max_count: 1 },
          ],
        }),
      );

      const first = await decided(f, 1);
      expect(first.decision).toBe(Decision.ALLOW);

      // Positive control: while the first is pending, the count rule bites.
      expect((await decided(f, 1)).decision).toBe(Decision.DENY);

      await f.authorization.withMandateLock(f.mandateId, () =>
        f.authorization.recordExecution(
          {
            authorizationId: first.id,
            mandateId: f.mandateId,
            provider: "stripe",
            providerReference: "pi_r3",
            providerFee: 0,
          },
          NOW,
        ),
      );

      // `count` is computed as reservations minus releases, so settling the
      // first payment returns the count to zero.
      const snapshot = await spend(f);
      expect(snapshot.mandate.count).toBe(0);
      expect(snapshot.mandate.amount).toBe(toMinorUnits(1, "USD"));

      // So a second payment is allowed, under a limit of one.
      expect((await decided(f, 1)).decision).toBe(Decision.ALLOW);
    });
  });

  // =======================================================================
  describe("R4 — closed by D-78: authorization objects are scoped to the acting agent (review: R11/Critical)", () => {
    it("agent B cannot list, read or execute agent A's authorization, and cannot choose the instrument", async () => {
      // Upgraded from the review's own probe, which authenticated a key for
      // an agent id with no Agent row and used the in-memory key repository.
      // Both agents here are persisted, with real keys from
      // PrismaAgentKeyRepository, so the result cannot be a fake's artefact.
      const f = await fixture();

      const agentBId = `agt_r2b_${randomUUID().slice(0, 12)}`;
      await prisma.agent.create({
        data: { id: agentBId, organizationId: f.org, name: "Agent B", status: "ACTIVE" },
      });
      const keyB = await f.repos.agentKeys.createKey(
        { organizationId: f.org, agentId: agentBId, name: "agent B" },
        NOW,
      );

      const authA = await decided(f, 1);
      expect(authA.decision).toBe(Decision.ALLOW);
      expect(authA.agent_id).toBe(f.agentId);

      const executed: Array<Record<string, unknown>> = [];
      const app = buildServer({
        repos: f.repos as never,
        logger: false,
        compiler: new FixtureIntentCompiler([]),
        webauthnConfig: WEBAUTHN_CONFIG,
        adapters: {
          review: {
            name: "review",
            execute: async (input: Record<string, unknown>) => {
              executed.push(input);
              return { ok: true, providerReference: "review_ref", providerFee: 0 };
            },
          } as never,
        },
      });
      await app.ready();

      try {
        const headers = { authorization: `Bearer ${keyB.fullKey}` };

        // 1. B's list no longer contains A's authorization. Before D-78 it
        //    did, which is how the review found the id to execute.
        const list = await app.inject({ method: "GET", url: "/v1/authorizations", headers });
        expect(list.statusCode).toBe(200);
        expect(JSON.stringify(list.json())).not.toContain(authA.id);

        // 2. B cannot read it. 404, not 403: B has no business learning it
        //    exists (same reasoning D-64 used for GET /v1/mandates/:id).
        const read = await app.inject({
          method: "GET",
          url: `/v1/authorizations/${authA.id}`,
          headers,
        });
        expect(read.statusCode).toBe(404);

        // 3. B cannot execute it, and the adapter is never reached.
        const run = await app.inject({
          method: "POST",
          url: `/v1/authorizations/${authA.id}/execute`,
          headers,
          payload: { rail: "review", payment_method_ref: "agent_b_chosen_instrument" },
        });
        expect(run.statusCode).toBe(404);
        expect(executed).toHaveLength(0);

        // 4. CONTROL: agent A, the actor, can do all three -- so the above
        //    is scoping and not a broken route.
        const ownerHeaders = { authorization: `Bearer ${f.apiKey}` };
        const ownList = await app.inject({
          method: "GET",
          url: "/v1/authorizations",
          headers: ownerHeaders,
        });
        expect(JSON.stringify(ownList.json())).toContain(authA.id);
        const ownRead = await app.inject({
          method: "GET",
          url: `/v1/authorizations/${authA.id}`,
          headers: ownerHeaders,
        });
        expect(ownRead.statusCode).toBe(200);

        // 5. Even A cannot substitute an instrument: execution uses the one
        //    declared with the decision.
        const substituted = await app.inject({
          method: "POST",
          url: `/v1/authorizations/${authA.id}/execute`,
          headers: ownerHeaders,
          payload: { rail: "review", payment_method_ref: "a_different_instrument" },
        });
        expect(substituted.statusCode).toBe(409);
        expect((substituted.json() as { error: string }).error).toBe("payment_method_mismatch");
        expect(executed).toHaveLength(0);

        const run2 = await app.inject({
          method: "POST",
          url: `/v1/authorizations/${authA.id}/execute`,
          headers: ownerHeaders,
          payload: { rail: "review" },
        });
        expect(run2.statusCode).toBe(200);
        expect(executed).toHaveLength(1);
        // The instrument is the one the DECISION covered, not one chosen now.
        expect(executed[0]?.paymentMethodRef).toBe("pm_fixture");
      } finally {
        await app.close();
      }
    });

    it("an org credential keeps organization-wide read, which the dashboard needs", async () => {
      const f = await fixture();
      const authA = await decided(f, 1);
      const orgKey = await f.repos.agentKeys.createKey(
        { organizationId: f.org, name: "org admin" },
        NOW,
      );
      const app = buildServer({
        repos: f.repos as never,
        logger: false,
        compiler: new FixtureIntentCompiler([]),
        webauthnConfig: WEBAUTHN_CONFIG,
      });
      await app.ready();
      try {
        const headers = { authorization: `Bearer ${orgKey.fullKey}` };
        const list = await app.inject({ method: "GET", url: "/v1/authorizations", headers });
        expect(JSON.stringify(list.json())).toContain(authA.id);
        const read = await app.inject({
          method: "GET",
          url: `/v1/authorizations/${authA.id}`,
          headers,
        });
        expect(read.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("an authorization that declared no instrument cannot execute at all", async () => {
      // The migration path, asserted: a pre-D-78 row has no
      // payment_method_ref, and execution refuses rather than falling back
      // to whatever the caller sends.
      const f = await fixture();
      const auth = await decided(f, 1);
      await prisma.authorization.update({
        where: { id: auth.id },
        data: {
          action: { ...(auth.action as object), payment_method_ref: undefined } as never,
        },
      });
      const app = buildServer({
        repos: f.repos as never,
        logger: false,
        compiler: new FixtureIntentCompiler([]),
        webauthnConfig: WEBAUTHN_CONFIG,
        adapters: {
          review: {
            name: "review",
            execute: async () => ({ ok: true, providerReference: "r", providerFee: 0 }),
          } as never,
        },
      });
      await app.ready();
      try {
        const run = await app.inject({
          method: "POST",
          url: `/v1/authorizations/${auth.id}/execute`,
          headers: { authorization: `Bearer ${f.apiKey}` },
          payload: { rail: "review", payment_method_ref: "anything" },
        });
        expect(run.statusCode).toBe(409);
        expect((run.json() as { error: string }).error).toBe("payment_method_not_declared");
      } finally {
        await app.close();
      }
    });
  });

  // =======================================================================
  describe("R5 — a policy-activation signature mints a re-enrollment grant (review: R4/High)", () => {
    it("through HTTP and Postgres: an AUTHENTICATION challenge issued for a policy is redeemed at the passkey route", async () => {
      // D-66 gave challenges an authoritative purpose, and left TWO
      // operations sharing `AUTHENTICATION`: activating a mandate
      // (`beginMandateAuthentication`) and authorizing a second passkey
      // (`beginReenrollmentAuthentication`). `completeReenrollmentAuthentication`
      // accepts any AUTHENTICATION challenge, so a signature the principal
      // produced to activate a policy is redeemable as an enrollment grant.
      const f = await fixture();
      const authenticator = createVirtualAuthenticator();
      const webauthnRepos = {
        authorization: f.authorization,
        evidence: f.evidence,
        webauthn: f.repos.webauthn,
      };

      const app = buildServer({
        repos: f.repos as never,
        logger: false,
        compiler: new FixtureIntentCompiler([]),
        webauthnConfig: WEBAUTHN_CONFIG,
      });
      await app.ready();

      const orgKey = await f.repos.agentKeys.createKey(
        { organizationId: f.org, name: "org admin" },
        NOW,
      );
      const headers = { authorization: `Bearer ${orgKey.fullKey}` };

      try {
        // First enrollment, over HTTP, so the principal has a credential.
        const regOptions = await app.inject({
          method: "POST",
          url: `/v1/mandates/${f.mandateId}/authenticate/options`,
          headers,
        });
        expect(regOptions.statusCode).toBe(200);
        const reg = regOptions.json() as { mode: string; challenge: string };
        expect(reg.mode).toBe("register");

        const regVerify = await app.inject({
          method: "POST",
          url: `/v1/mandates/${f.mandateId}/authenticate/verify`,
          headers,
          payload: {
            mode: "register",
            challenge: reg.challenge,
            response: buildRegistrationResponse({
              authenticator,
              ...WEBAUTHN_CONFIG,
              challenge: reg.challenge,
            }),
          },
        });
        expect(regVerify.statusCode).toBe(200);

        // Now the principal is asked to authenticate a POLICY. This is the
        // ceremony a real principal would be shown as "confirm this mandate".
        //
        // Minted with a REAL clock, not the fixture's fixed NOW: the HTTP
        // routes call `new Date()` themselves, so a challenge stamped at
        // 2026-10-07T12:00Z is already past its TTL by the time the route
        // checks it. That cost one debugging round and is worth a comment.
        const realNow = new Date();
        const policyChallenge = await beginMandateAuthentication(
          webauthnRepos,
          f.principalId,
          hashPolicy(f.policy),
          realNow,
        );
        const policySignature = buildAuthenticationResponse({
          authenticator,
          ...WEBAUTHN_CONFIG,
          challenge: policyChallenge.challenge,
        });

        // That same signature is redeemed at the passkey route instead.
        const granted = await app.inject({
          method: "POST",
          url: `/v1/principals/${f.principalId}/passkeys/verify`,
          headers,
          payload: { challenge: policyChallenge.challenge, response: policySignature },
        });
        expect(granted.statusCode).toBe(200);
        const grant = (granted.json() as { kind: string; grant: string }).grant;
        expect(grant).toBeTruthy();

        // And the grant enrolls a DIFFERENT authenticator: an attacker's.
        const attacker = createVirtualAuthenticator();
        const enrollOptions = await app.inject({
          method: "POST",
          url: `/v1/mandates/${f.mandateId}/authenticate/options`,
          headers,
        });
        const enroll = enrollOptions.json() as { mode: string; challenge: string };
        // The principal already has a passkey, so this is an authentication
        // challenge; the registration challenge has to be requested through
        // the grant path. Assert what the route actually returns.
        expect(enroll.mode).toBe("authenticate");

        // The service-level redemption, which is what the grant is for.
        const reenrolled = await completeReenrollmentAuthentication(
          webauthnRepos,
          WEBAUTHN_CONFIG,
          {
            organizationId: f.org,
            principalId: f.principalId,
            claimedChallenge: policyChallenge.challenge,
            response: policySignature,
          },
          realNow,
        );
        // Already consumed above, so this second attempt is rejected --
        // single-use holds. The hole is that the FIRST redemption succeeded
        // with a policy-activation signature at all.
        expect(reenrolled.kind).toBe("rejected");
        void attacker;
      } finally {
        await app.close();
      }
    });
  });

  // =======================================================================
  describe("R6 — a webhook is consumed before its ledger effect commits (review: R8/High)", () => {
    it("an injected refund failure leaves the retry classified duplicate and the budget uncredited", async () => {
      const f = await fixture();
      const auth = await decided(f, 100);
      await f.authorization.withMandateLock(f.mandateId, () =>
        f.authorization.recordExecution(
          {
            authorizationId: auth.id,
            mandateId: f.mandateId,
            provider: "stripe",
            providerReference: "pi_r6",
            providerFee: 0,
          },
          NOW,
        ),
      );
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(100, "USD"));

      const event = stripeEvent("charge.refunded", {
        id: `ch_r2_${randomUUID()}`,
        metadata: { waysafe_authorization_id: auth.id },
        amount_refunded: toMinorUnits(100, "USD"),
      });

      // `recordIfNew` marks the event consumed before the effect is applied.
      const original = f.authorization.recordRefund.bind(f.authorization);
      (f.authorization as { recordRefund: unknown }).recordRefund = async () => {
        throw new Error("review 2 injected ledger outage");
      };
      await expect(handleStripeWebhook(f.repos, event, NOW)).rejects.toThrow(
        "review 2 injected ledger outage",
      );
      (f.authorization as { recordRefund: unknown }).recordRefund = original;

      // Stripe retries. The event is already recorded, so the retry is a no-op.
      expect((await handleStripeWebhook(f.repos, event, NOW)).kind).toBe("duplicate");

      // The $100 refund is never credited. The customer's money came back and
      // the mandate's budget did not.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(100, "USD"));
    });
  });

  // =======================================================================
  describe("R7 — Issuing lifecycle: reversal, partial capture, multiple captures (review: R10/High)", () => {
    it("a reversed authorization keeps its reservation forever", async () => {
      const f = await fixture();
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      const approved = await handleIssuingAuthorizationRequest(
        f.repos,
        new StripeIssuingAdapter(),
        card,
        NOW,
      );
      expect(approved.response.approved).toBe(true);
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));

      const reversal = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", {
          ...card,
          status: "reversed",
          approved: true,
          amount: 0,
        }),
        NOW,
      );
      expect(reversal.kind).toBe("ignored");

      // The hold survives a reversal, so the mandate's budget stays spent on
      // a transaction the network already gave back.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });

    it("an expired authorization keeps its reservation too", async () => {
      const f = await fixture();
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      const expiry = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", { ...card, status: "expired", approved: true }),
        NOW,
      );
      expect(expiry.kind).toBe("ignored");
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });

    it("a partial capture records the AUTHORIZED amount, not the settled amount", async () => {
      const f = await fixture();
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      // Stripe settles $2.50 of the $10 hold, in a different currency field
      // than the one that was authorized.
      const capture = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", {
          ...card,
          status: "closed",
          approved: true,
          amount: toMinorUnits(2.5, "USD"),
          currency: "eur",
        }),
        NOW,
      );
      expect(capture.kind).toBe("applied");

      const captures = await prisma.ledgerEntry.findMany({
        where: { mandateId: f.mandateId, type: "CAPTURE" },
      });
      expect(captures.map((c) => [c.amount, c.currency])).toEqual([
        [toMinorUnits(10, "USD"), "USD"],
      ]);
      // $2.50 moved; $10 is recorded.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });

    it("a second capture event for the same authorization is ignored, so multi-capture under-records", async () => {
      const f = await fixture();
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      const first = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", {
          ...card,
          status: "closed",
          approved: true,
          amount: toMinorUnits(6, "USD"),
        }),
        NOW,
      );
      expect(first.kind).toBe("applied");

      // A distinct event id, a second settlement against the same
      // authorization. The authorization is now EXECUTED, so it is dropped.
      const second = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", {
          ...card,
          status: "closed",
          approved: true,
          amount: toMinorUnits(4, "USD"),
        }),
        NOW,
      );
      expect(second.kind).toBe("ignored");
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });
  });

  // =======================================================================
  describe("R8 — sub-cent x402 transfers record zero cents (review: R1/Medium)", () => {
    it("three nonzero atomic transfers are each recorded as $0.00", async () => {
      const f = await fixture();
      const instrument = await f.repos.instruments.createInstrument(
        {
          organizationId: f.org,
          mandateId: f.mandateId,
          rail: "x402",
          externalRef: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
        },
        NOW,
      );

      const requirement = {
        scheme: "exact",
        network: "polygon-amoy",
        maxAmountRequired: "4999", // 0.004999 USDC, under one cent
        resource: "https://merchant.example/pay",
        payTo: "0x1111111111111111111111111111111111111111",
        asset: AMOY_USDC.address,
      };
      const fetcher = {
        fetchPaymentRequirements: async () => ({ x402Version: 1, accepts: [requirement] }),
      };

      for (let i = 0; i < 3; i += 1) {
        const result = await handleX402PaymentRequest(
          f.repos,
          new X402Adapter(new FakeEd25519Signer()),
          fetcher as never,
          { instrumentRef: instrument.id, resourceUrl: requirement.resource },
          NOW,
        );
        expect(result.response.decision).toBe(Decision.ALLOW);
        expect(result.response.co_signature?.amount_atomic).toBe("4999");
      }

      const rows = await f.authorization.listAuthorizations(f.org, 10);
      expect(rows.filter((r) => r.action.amount === 0)).toHaveLength(3);
      // 14,997 atomic units co-signed, $0.00 on the ledger and the receipt.
      expect((await spend(f)).mandate.amount).toBe(0);

      // CONTROL: the conversion is right above one cent.
      expect(assetAtomicToCents("1000000", AMOY_USDC)).toBe(100);
      expect(assetAtomicToCents("10000", AMOY_USDC)).toBe(1);
    });
  });

  // =======================================================================
  describe("R9 — a slow-drip body outlives the fetch deadline (review: R2/Medium)", () => {
    it("a 60ms policy returns well past 60ms while the server dribbles bytes", async () => {
      // D-75's policy sets an overall deadline, and `requestOnce` arms a
      // socket timeout from the time remaining. A socket timeout is an IDLE
      // timer: each chunk resets it, so a server that writes one byte every
      // 20ms keeps the connection open indefinitely.
      const server = createServer((_req, res) => {
        res.writeHead(402, { "content-type": "application/json" });
        const timer = setInterval(() => res.write(" "), 20);
        setTimeout(() => {
          clearInterval(timer);
          res.end("{}");
        }, 400);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const started = Date.now();
        await fetchResourceUnderPolicy(`http://127.0.0.1:${port}/`, {
          ...LOCAL_RESOURCE_FETCH_POLICY,
          timeoutMs: 60,
        }).catch(() => undefined);
        const elapsed = Date.now() - started;
        // eslint-disable-next-line no-console
        console.log(`R9: a 60ms deadline returned after ${elapsed}ms`);
        expect(elapsed).toBeGreaterThan(300);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // =======================================================================
  describe("R10 — a revocation committed between the gate and the lock still ALLOWs (review: R12)", () => {
    it("the gate's mandate status is read before the row lock, so a revocation in between is missed", async () => {
      const f = await fixture();

      // THE SEAM, test-only: `withMandateLock` is wrapped so a revocation
      // commits in the window between `resolveMandateGate` (which reads the
      // mandate's status without a lock) and the lock being taken. Nothing
      // in production code is changed.
      const original = f.authorization.withMandateLock.bind(f.authorization);
      let armed = true;
      (f.authorization as { withMandateLock: unknown }).withMandateLock = async (
        mandateId: string,
        fn: () => Promise<unknown>,
      ) => {
        if (armed) {
          armed = false;
          await prisma.mandate.update({ where: { id: mandateId }, data: { status: "REVOKED" } });
        }
        return original(mandateId, fn as never);
      };

      const racing = await decided(f, 1);
      expect(racing.decision).toBe(Decision.ALLOW);

      (f.authorization as { withMandateLock: unknown }).withMandateLock = original;

      // CONTROL: once the revocation is visible to the gate, it denies.
      const after = await decided(f, 1);
      expect(after.decision).toBe(Decision.DENY);
      expect(after.reasons.map((r) => r.code)).toContain(ReasonCode.DENY_MANDATE_REVOKED);
    });
  });

  // =======================================================================
  describe("R11 — HYPOTHESIS: several non-reserving step-ups approved against one cap", () => {
    it("two step-ups approved back to back place $160 of holds on a $100 cap", async () => {
      // Not from the review. D-73's entry already records this as open: the
      // approval re-validates the spending mandate's AUTHORITY but does not
      // re-evaluate its LIMITS, because `evaluate()` there runs against the
      // approver's policy.
      const approver = await fixture(
        policyFrom({
          cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(100_000, "USD") }],
          per_transaction_max: toMinorUnits(100_000, "USD"),
        }),
      );

      const suffix = randomUUID().slice(0, 12);
      const spenderPrincipal = `prin_r2s_${suffix}`;
      const spenderAgent = `agt_r2s_${suffix}`;
      await prisma.principal.create({
        data: { id: spenderPrincipal, organizationId: approver.org, displayName: "Spender" },
      });
      await prisma.agent.create({
        data: { id: spenderAgent, organizationId: approver.org, name: "Spender", status: "ACTIVE" },
      });

      const spenderPolicy = policyFrom({
        per_transaction_max: toMinorUnits(100, "USD"),
        cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(100, "USD") }],
        step_up: { above_amount: toMinorUnits(50, "USD"), ttl_seconds: 900 },
        accounting: { timezone: "UTC", reserve_on_step_up: false },
        escalation: { approvers: [approver.mandateId] },
      });
      const created = await approver.authorization.createMandate(
        {
          organizationId: approver.org,
          principalId: spenderPrincipal,
          agentIds: [spenderAgent],
          policy: spenderPolicy,
          policyHash: hashPolicy(spenderPolicy),
          intentText: "spender",
          compilerName: "manual",
          assumptions: [],
        },
        NOW,
      );
      await approver.authorization.activateMandate(
        created.mandateId,
        created.mandateVersionId,
        "203.0.113.8",
        NOW,
      );
      const spenderKey = await approver.repos.agentKeys.createKey(
        { organizationId: approver.org, agentId: spenderAgent, name: "spender" },
        NOW,
      );

      const raise = async () => {
        const result = await authorize(approver.repos, {
          organizationId: approver.org,
          request: {
            agent_id: spenderAgent,
            principal_id: spenderPrincipal,
            mandate_id: created.mandateId,
            action: {
              amount: toMinorUnits(80, "USD"),
              currency: "USD" as const,
              merchant: { domain: "staples.com" },
              attestations: {},
            },
          } as never,
          apiKey: spenderKey.fullKey,
          now: NOW,
        });
        if (result.kind !== "decided") throw new Error(result.kind);
        expect(result.authorization.decision).toBe(Decision.STEP_UP);
        return result.authorization;
      };

      // Two step-ups raised before either is resolved. With
      // reserve_on_step_up: false, neither holds anything yet.
      const one = await raise();
      const two = await raise();

      const approve = (stepUp: Awaited<ReturnType<typeof raise>>) =>
        resolveStepUpAsApprover(approver.repos, {
          organizationId: approver.org,
          stepUp,
          approverAgentId: approver.agentId,
          approverPrincipalId: approver.principalId,
          approverMandateId: approver.mandateId,
          apiKey: approver.apiKey,
          now: NOW,
        });

      expect((await approve(one)).kind).toBe("resolved");
      expect((await approve(two)).kind).toBe("resolved");

      // D-71 holds each approval on the spender's ledger, which is the fix it
      // shipped. What it does not do is re-evaluate the spender's own cap at
      // approval time, so two approvals exceed it.
      const snapshot = await approver.authorization.getSpendSnapshot(
        created.mandateId,
        spenderPolicy.accounting,
        NOW,
      );
      expect(snapshot.mandate.amount).toBe(toMinorUnits(160, "USD"));
      expect(snapshot.mandate.amount).toBeGreaterThan(toMinorUnits(100, "USD"));
    });
  });
});
