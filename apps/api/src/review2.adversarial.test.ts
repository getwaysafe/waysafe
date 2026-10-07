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
  beginRegistration,
  beginReenrollmentAuthentication,
  completeRegistration,
  completeReenrollmentAuthentication,
} from "./webauthn/service.js";
import { policyHashToChallenge } from "./webauthn/webauthn.js";
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
  describe("R1 — closed by D-79: an increment is a new decision, not a replay (review: R9/High)", () => {
    it("a $10 approval does NOT cover a $10,000 request on the same id", async () => {
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

      // The increment is now evaluated on its own. $10,000 is far above the
      // $10 per-transaction ceiling, so it is DENIED rather than replayed.
      const increment = await handleIssuingAuthorizationRequest(f.repos, adapter, incremented, NOW);
      expect(increment.response.approved).toBe(false);
      expect(increment.response.reason_codes).toContain(
        ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED,
      );
      expect(increment.authorizationId).not.toBe(first.authorizationId);

      // CONTROL: the same $10,000 payload under a fresh id is still declined.
      const control = await handleIssuingAuthorizationRequest(
        f.repos,
        adapter,
        { ...incremented, id: `iauth_r2_${randomUUID().slice(0, 12)}` } as unknown as Stripe.Issuing.Authorization,
        NOW,
      );
      expect(control.response.approved).toBe(false);

      // Still $10 held, and now that is the truth rather than an accident.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });

    it("a genuine redelivery -- same id, same revision, same amount -- still replays", async () => {
      // D-74's property, which must survive D-79: an identical redelivery
      // takes no second hold.
      const f = await fixture(policyFrom({ per_transaction_max: toMinorUnits(10, "USD") }));
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      const adapter = new StripeIssuingAdapter();

      const first = await handleIssuingAuthorizationRequest(f.repos, adapter, card, NOW);
      expect(first.response.approved).toBe(true);
      const again = await handleIssuingAuthorizationRequest(f.repos, adapter, card, NOW);
      expect(again.response).toEqual(first.response);
      expect(again.authorizationId).toBe(first.authorizationId);
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });

    it("an increment within the cap is approved, and the hold becomes the aggregate", async () => {
      // The legitimate case: a restaurant tab raised from $10 to $30 under a
      // $50 per-transaction and $100 cumulative ceiling. The second decision
      // reserves the $20 DIFFERENCE, so the total held is $30, not $40.
      const f = await fixture(
        policyFrom({
          per_transaction_max: toMinorUnits(50, "USD"),
          cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(100, "USD") }],
        }),
      );
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      const adapter = new StripeIssuingAdapter();

      const first = await handleIssuingAuthorizationRequest(f.repos, adapter, card, NOW);
      expect(first.response.approved).toBe(true);
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));

      const raised = {
        ...card,
        request_history: [{ amount: toMinorUnits(10, "USD") }],
        pending_request: { ...(card.pending_request as object), amount: toMinorUnits(30, "USD") },
      } as unknown as Stripe.Issuing.Authorization;
      const second = await handleIssuingAuthorizationRequest(f.repos, adapter, raised, NOW);
      expect(second.response.approved).toBe(true);
      expect(second.authorizationId).not.toBe(first.authorizationId);

      // The aggregate, not the sum of both full amounts.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(30, "USD"));
    });

    it("increments cannot be stacked past the per-transaction ceiling one delta at a time", async () => {
      // The reason the per-transaction rule is checked against the AGGREGATE
      // and not the delta: ten $10 deltas would each pass a $10 ceiling.
      const f = await fixture(
        policyFrom({
          per_transaction_max: toMinorUnits(15, "USD"),
          cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(1000, "USD") }],
        }),
      );
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      const adapter = new StripeIssuingAdapter();
      expect((await handleIssuingAuthorizationRequest(f.repos, adapter, card, NOW)).response.approved).toBe(true);

      const raised = {
        ...card,
        request_history: [{ amount: toMinorUnits(10, "USD") }],
        pending_request: { ...(card.pending_request as object), amount: toMinorUnits(20, "USD") },
      } as unknown as Stripe.Issuing.Authorization;
      const second = await handleIssuingAuthorizationRequest(f.repos, adapter, raised, NOW);
      // The $10 delta would pass a $15 ceiling. The $20 aggregate does not.
      expect(second.response.approved).toBe(false);
      expect(second.response.reason_codes).toContain(
        ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED,
      );
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });
  });

  // =======================================================================
  describe("R2 — closed by D-82: a cumulative refund total credits only the delta (review: R7/High)", () => {
    it("a $100 capture refunded $40 then $100 nets to zero, not minus $40", async () => {
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

      // $100 captured, $100 refunded in total, so the ledger says $0.
      // Before D-82 it said minus $40 -- $140 of fresh budget.
      expect((await spend(f)).mandate.amount).toBe(0);

      // And the credits sum to exactly the capture, in two rows.
      const credits = await prisma.ledgerEntry.findMany({
        where: { mandateId: f.mandateId, type: "CREDIT" },
      });
      expect(credits.map((c) => c.amount).sort((a, b) => a - b)).toEqual([
        -toMinorUnits(60, "USD"),
        -toMinorUnits(40, "USD"),
      ]);
    });

    it("a third event with no further refund credits nothing", async () => {
      const f = await fixture();
      const auth = await decided(f, 100);
      await f.authorization.withMandateLock(f.mandateId, () =>
        f.authorization.recordExecution(
          {
            authorizationId: auth.id,
            mandateId: f.mandateId,
            provider: "stripe",
            providerReference: "pi_r2c",
            providerFee: 0,
          },
          NOW,
        ),
      );
      const charge = { id: `ch_r2_${randomUUID()}`, metadata: { waysafe_authorization_id: auth.id } };
      for (const total of [40, 100, 100]) {
        await handleStripeWebhook(
          f.repos,
          stripeEvent("charge.refunded", { ...charge, amount_refunded: toMinorUnits(total, "USD") }),
          NOW,
        );
      }
      expect((await spend(f)).mandate.amount).toBe(0);
      const credits = await prisma.ledgerEntry.findMany({
        where: { mandateId: f.mandateId, type: "CREDIT" },
      });
      expect(credits).toHaveLength(2); // the third event added nothing
    });

    it("an over-refund is clamped, so no window SUM goes negative", async () => {
      // Non-negotiable #6. A provider can refund more than it captured (a
      // goodwill credit); the honest ledger answer is that this
      // authorization's spend is zero, not that the mandate gained budget.
      const f = await fixture();
      const auth = await decided(f, 100);
      await f.authorization.withMandateLock(f.mandateId, () =>
        f.authorization.recordExecution(
          {
            authorizationId: auth.id,
            mandateId: f.mandateId,
            provider: "stripe",
            providerReference: "pi_r2d",
            providerFee: 0,
          },
          NOW,
        ),
      );
      await handleStripeWebhook(
        f.repos,
        stripeEvent("charge.refunded", {
          id: `ch_r2_${randomUUID()}`,
          metadata: { waysafe_authorization_id: auth.id },
          amount_refunded: toMinorUnits(250, "USD"),
        }),
        NOW,
      );
      expect((await spend(f)).mandate.amount).toBe(0);
      expect((await spend(f)).mandate.amount).toBeGreaterThanOrEqual(0);
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
  describe("R3 — closed by D-87: max_count counts authorized transactions (review: R6)", () => {
    const countPolicy = () =>
      policyFrom({
        cumulative_limits: [
          { window: "mandate", max_amount: toMinorUnits(1000, "USD"), max_count: 1 },
        ],
      });

    it("a pending payment consumes the only slot", async () => {
      const f = await fixture(countPolicy());
      expect((await decided(f, 1)).decision).toBe(Decision.ALLOW);
      expect((await spend(f)).mandate.count).toBe(1);
      expect((await decided(f, 1)).decision).toBe(Decision.DENY);
    });

    it("a CAPTURED payment still consumes it -- settling does not free the slot", async () => {
      const f = await fixture(countPolicy());
      const first = await decided(f, 1);
      expect(first.decision).toBe(Decision.ALLOW);

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

      // Settlement writes RELEASE(-1) + CAPTURE(+1): the amount is right,
      // and before D-87 the COUNT went back to zero because it was computed
      // as reservations minus releases. One settled payment is still one
      // payment.
      const snapshot = await spend(f);
      expect(snapshot.mandate.amount).toBe(toMinorUnits(1, "USD"));
      expect(snapshot.mandate.count).toBe(1); // was 0

      const second = await decided(f, 1);
      expect(second.decision).toBe(Decision.DENY); // was ALLOW
      expect(second.reasons.map((r) => r.code)).toContain(ReasonCode.DENY_VELOCITY_LIMIT_EXCEEDED);
    });

    it("a REVERSED authorization frees the slot -- released without capture", async () => {
      const f = await fixture(countPolicy());
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      const approved = await handleIssuingAuthorizationRequest(
        f.repos,
        new StripeIssuingAdapter(),
        card,
        NOW,
      );
      expect(approved.response.approved).toBe(true);
      expect((await spend(f)).mandate.count).toBe(1);

      await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", {
          ...card,
          status: "reversed",
          approved: true,
          amount: 0,
        }),
        NOW,
      );

      // Nothing moved, so nothing is counted.
      expect((await spend(f)).mandate.count).toBe(0);
      expect((await decided(f, 1)).decision).toBe(Decision.ALLOW);
    });

    it("a settled card payment stays counted after capture", async () => {
      const f = await fixture(countPolicy());
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", {
          ...card,
          status: "closed",
          approved: true,
          amount: toMinorUnits(10, "USD"),
          currency: "usd",
        }),
        NOW,
      );

      expect((await spend(f)).mandate.count).toBe(1);
      expect((await decided(f, 1)).decision).toBe(Decision.DENY);
    });

    it("a force capture with no prior reservation is counted (D-84)", async () => {
      // A capture that never had a hold is still an authorized-transaction
      // slot consumed: it is the one case "reservations minus releases"
      // could never see at all, since there is no reservation to count.
      const f = await fixture(countPolicy());
      const instrument = await f.repos.instruments.createInstrument(
        {
          organizationId: f.org,
          mandateId: f.mandateId,
          rail: "stripe_issuing",
          externalRef: `ic_r3_${randomUUID().slice(0, 8)}`,
        },
        NOW,
      );
      const forced = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_transaction.created", {
          id: `ipi_r3_${randomUUID().slice(0, 12)}`,
          object: "issuing.transaction",
          amount: -toMinorUnits(7, "USD"),
          currency: "usd",
          type: "capture",
          authorization: null,
          card: { id: "ic_x", metadata: { waysafe_instrument_id: instrument.id } },
          merchant_data: { category: "fuel", category_code: "5541", name: "FORCED", network_id: "f_mid" },
        } as unknown as Stripe.Issuing.Transaction),
        NOW,
      );
      expect(forced).toMatchObject({ kind: "applied", effect: "unauthorized_settlement" });

      expect((await spend(f)).mandate.count).toBe(1);
      expect((await decided(f, 1)).decision).toBe(Decision.DENY);
    });

    it("SELF-FOUND: an INCREMENTED authorization is one transaction, not two", async () => {
      // Not in the review. D-79 gives each increment of one external
      // authorization its own Authorization row, each with its own
      // RESERVATION. Counting rows would make a single incremented card
      // payment consume two slots of max_count. The counting unit is the
      // external authorization, so it consumes one.
      const f = await fixture(countPolicy());
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      const incremented = await handleIssuingAuthorizationRequest(
        f.repos,
        new StripeIssuingAdapter(),
        {
          ...card,
          pending_request: { ...card.pending_request, amount: toMinorUnits(25, "USD") },
          request_history: [{ amount: toMinorUnits(10, "USD"), approved: true }],
        } as never,
        NOW,
      );
      expect(incremented.response.approved).toBe(true);

      const rows = await prisma.authorization.findMany({
        where: { mandateId: f.mandateId, externalRef: card.id },
      });
      expect(rows.length).toBe(2); // two revisions...
      expect((await spend(f)).mandate.count).toBe(1); // ...one transaction
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
  describe("R5 — closed by D-86: a purpose per operation (review: R4/High)", () => {
    it("through HTTP and Postgres: a policy-activation signature is REFUSED at the passkey route", async () => {
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

        // That same signature, offered at the passkey route, is refused:
        // the challenge was issued for MANDATE_AUTHENTICATION and only
        // completeMandateAuthentication accepts that purpose.
        const granted = await app.inject({
          method: "POST",
          url: `/v1/principals/${f.principalId}/passkeys/verify`,
          headers,
          payload: { challenge: policyChallenge.challenge, response: policySignature },
        });
        expect(granted.statusCode).toBe(401); // was 200
        expect((granted.json() as { reason: string }).reason).toContain(
          "not REENROLLMENT_AUTHENTICATION",
        );

        // The policy challenge is still consumed (single-use), so the
        // attacker cannot retry it either.
        const retried = await completeReenrollmentAuthentication(
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
        expect(retried.kind).toBe("rejected");
      } finally {
        await app.close();
      }
    });

    it("CONTROL: the proper re-enrollment ceremony still works end to end", async () => {
      // Without this, the fix would look correct while breaking the only
      // legitimate way to add a second passkey (D-66).
      const f = await fixture();
      const authenticator = createVirtualAuthenticator();
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
        // First passkey.
        const reg = (
          await app.inject({
            method: "POST",
            url: `/v1/mandates/${f.mandateId}/authenticate/options`,
            headers,
          })
        ).json() as { challenge: string };
        await app.inject({
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

        // The re-enrollment ceremony: its own challenge, its own purpose.
        const options = await app.inject({
          method: "POST",
          url: `/v1/principals/${f.principalId}/passkeys/options`,
          headers,
        });
        expect(options.statusCode).toBe(200);
        const challenge = (options.json() as { challenge: string }).challenge;

        const verified = await app.inject({
          method: "POST",
          url: `/v1/principals/${f.principalId}/passkeys/verify`,
          headers,
          payload: {
            challenge,
            response: buildAuthenticationResponse({
              authenticator,
              ...WEBAUTHN_CONFIG,
              challenge,
            }),
          },
        });
        expect(verified.statusCode).toBe(200);
        expect((verified.json() as { grant: string }).grant).toBeTruthy();
      } finally {
        await app.close();
      }
    });

    it("the re-enrollment challenge is random, not derived from a policy hash", async () => {
      // Which is what narrows OQ-12: a predictable challenge is now only a
      // concern for mandate activation, because this path no longer has one.
      const f = await fixture();
      const webauthnRepos = {
        authorization: f.authorization,
        evidence: f.evidence,
        webauthn: f.repos.webauthn,
      };
      const authenticator = createVirtualAuthenticator();
      const reg = await beginRegistration(webauthnRepos, f.principalId, new Date());
      await completeRegistration(
        webauthnRepos,
        WEBAUTHN_CONFIG,
        {
          organizationId: f.org,
          principalId: f.principalId,
          claimedChallenge: reg.challenge,
          response: buildRegistrationResponse({
            authenticator,
            ...WEBAUTHN_CONFIG,
            challenge: reg.challenge,
          }),
        },
        new Date(),
      );

      const a = await beginReenrollmentAuthentication(webauthnRepos, f.principalId, new Date());
      const b = await beginReenrollmentAuthentication(webauthnRepos, f.principalId, new Date());
      expect(a.challenge).not.toBe(b.challenge);
      // And neither equals the deterministic policy-hash challenge.
      expect(a.challenge).not.toBe(policyHashToChallenge(hashPolicy(f.policy)));
    });
  });

  // =======================================================================
  describe("R6 — closed by D-81: the event and its effect commit together (review: R8/High)", () => {
    it("an injected refund failure rolls the event back, so the retry applies it", async () => {
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

      const original = f.authorization.recordRefund.bind(f.authorization);
      (f.authorization as { recordRefund: unknown }).recordRefund = async () => {
        throw new Error("review 2 injected ledger outage");
      };
      await expect(handleStripeWebhook(f.repos, event, NOW)).rejects.toThrow(
        "review 2 injected ledger outage",
      );
      (f.authorization as { recordRefund: unknown }).recordRefund = original;

      // The event record rolled back with the failed effect, so Stripe's
      // retry is a genuine first attempt. Before D-81 it was "duplicate".
      const retry = await handleStripeWebhook(f.repos, event, NOW);
      expect(retry.kind).toBe("applied"); // was "duplicate"

      // And the refund is credited: $100 captured, $100 back.
      expect((await spend(f)).mandate.amount).toBe(0);
    });

    it("CONTROL: a healthy delivery still deduplicates on redelivery", async () => {
      // D-81 must not break idempotency, which is the property the original
      // ordering existed to provide.
      const f = await fixture();
      const auth = await decided(f, 100);
      await f.authorization.withMandateLock(f.mandateId, () =>
        f.authorization.recordExecution(
          {
            authorizationId: auth.id,
            mandateId: f.mandateId,
            provider: "stripe",
            providerReference: "pi_r6b",
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

    it("a transient miss is NOT recorded, so a later retry can still apply it", async () => {
      // The other half of D-81: an event ignored because its target does not
      // exist yet must stay retryable. Marking it seen is how a real refund
      // disappears permanently.
      const f = await fixture();
      const auth = await decided(f, 100);
      await f.authorization.withMandateLock(f.mandateId, () =>
        f.authorization.recordExecution(
          {
            authorizationId: auth.id,
            mandateId: f.mandateId,
            provider: "stripe",
            providerReference: "pi_r6c",
            providerFee: 0,
          },
          NOW,
        ),
      );

      const event = stripeEvent("charge.refunded", {
        id: `ch_r2_${randomUUID()}`,
        metadata: { waysafe_authorization_id: "auth_does_not_exist_yet" },
        amount_refunded: toMinorUnits(40, "USD"),
      });
      const missed = await handleStripeWebhook(f.repos, event, NOW);
      expect(missed.kind).toBe("ignored");
      expect(missed).toMatchObject({ retryable: true });

      // The same event id, now resolvable, applies rather than deduplicating.
      const resolvable = {
        ...event,
        data: {
          object: {
            id: `ch_r2_${randomUUID()}`,
            metadata: { waysafe_authorization_id: auth.id },
            amount_refunded: toMinorUnits(40, "USD"),
          },
        },
      } as never;
      expect((await handleStripeWebhook(f.repos, resolvable, NOW)).kind).toBe("applied");
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(60, "USD"));
    });

    it("a permanently irrelevant event IS recorded, so the provider stops retrying", async () => {
      const f = await fixture();
      const event = stripeEvent("customer.created", { id: "cus_whatever" });
      const first = await handleStripeWebhook(f.repos, event, NOW);
      expect(first.kind).toBe("ignored");
      expect(first).toMatchObject({ retryable: false });
      expect((await handleStripeWebhook(f.repos, event, NOW)).kind).toBe("duplicate");
    });
  });

  // =======================================================================
  describe("R7 — closed by D-83: the card lifecycle is modelled (review: R10/High)", () => {
    it("a reversed authorization releases its hold", async () => {
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
      expect(reversal).toMatchObject({ kind: "applied", effect: "release:reversed" });

      // The budget is back. Before D-83 the hold survived forever.
      expect((await spend(f)).mandate.amount).toBe(0);
      const events = await f.evidence.listForOrganization(f.org);
      expect(events.some((e) => e.type === "enforcement.stripe_issuing.released")).toBe(true);
    });

    it("an expired authorization releases its hold too", async () => {
      const f = await fixture();
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      const expiry = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", { ...card, status: "expired", approved: true }),
        NOW,
      );
      expect(expiry).toMatchObject({ kind: "applied", effect: "release:expired" });
      expect((await spend(f)).mandate.amount).toBe(0);
    });

    it("a partial capture records the SETTLED amount, not the authorized amount", async () => {
      const f = await fixture();
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      // Stripe settles $2.50 of the $10 hold.
      const capture = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", {
          ...card,
          status: "closed",
          approved: true,
          amount: toMinorUnits(2.5, "USD"),
          currency: "usd",
        }),
        NOW,
      );
      expect(capture.kind).toBe("applied");

      const captures = await prisma.ledgerEntry.findMany({
        where: { mandateId: f.mandateId, type: "CAPTURE" },
      });
      expect(captures.map((c) => [c.amount, c.currency])).toEqual([
        [toMinorUnits(2.5, "USD"), "USD"],
      ]);
      // $2.50 moved and $2.50 is recorded. Before D-83 it was $10.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(2.5, "USD"));

      // The receipt carries BOTH figures, so it can answer "was this
      // partial?" without a second lookup.
      const events = await f.evidence.listForOrganization(f.org);
      const captured = events.find((e) => e.type === "enforcement.stripe_issuing.captured");
      expect(captured?.payload).toMatchObject({
        authorized: toMinorUnits(10, "USD"),
        settled: toMinorUnits(2.5, "USD"),
        partial: true,
      });
    });

    it("a settled currency that disagrees with the authorization is refused, not converted", async () => {
      // There is no FX anywhere in this codebase. Converting silently would
      // be worse than refusing, and the webhook layer can retry.
      const f = await fixture();
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      await expect(
        handleStripeWebhook(
          f.repos,
          stripeEvent("issuing_authorization.updated", {
            ...card,
            status: "closed",
            approved: true,
            amount: toMinorUnits(2.5, "USD"),
            currency: "eur",
          }),
          NOW,
        ),
      ).rejects.toThrow(/does not match the authorization/);
      // Nothing captured, and the hold is untouched for the retry.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));
    });

    it("an increment's AGGREGATE hold is what settlement reconciles against (D-79 + D-83)", async () => {
      // $10 raised to $30 across two revisions, then $28 settles. Both holds
      // must be released and $28 captured -- not $30, and not twice.
      const f = await fixture(
        policyFrom({
          per_transaction_max: toMinorUnits(50, "USD"),
          cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(100, "USD") }],
        }),
      );
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      const adapter = new StripeIssuingAdapter();
      await handleIssuingAuthorizationRequest(f.repos, adapter, card, NOW);
      const raised = {
        ...card,
        request_history: [{ amount: toMinorUnits(10, "USD") }],
        pending_request: { ...(card.pending_request as object), amount: toMinorUnits(30, "USD") },
      } as unknown as Stripe.Issuing.Authorization;
      await handleIssuingAuthorizationRequest(f.repos, adapter, raised, NOW);
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(30, "USD"));

      const settled = await handleStripeWebhook(
        f.repos,
        stripeEvent("issuing_authorization.updated", {
          ...raised,
          status: "closed",
          approved: true,
          amount: toMinorUnits(28, "USD"),
          currency: "usd",
        }),
        NOW,
      );
      expect(settled.kind).toBe("applied");

      // $28 charged, both holds gone.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(28, "USD"));
      const rows = await prisma.ledgerEntry.findMany({ where: { mandateId: f.mandateId } });
      expect(rows.filter((r) => r.type === "RESERVATION")).toHaveLength(2);
      expect(rows.filter((r) => r.type === "RELEASE")).toHaveLength(2);
      expect(rows.filter((r) => r.type === "CAPTURE")).toHaveLength(1);
      expect(rows.filter((r) => r.type === "CAPTURE")[0]?.amount).toBe(toMinorUnits(28, "USD"));
    });

    it("a second settlement event for an already-settled authorization is refused, not double-charged", async () => {
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
          currency: "usd",
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
      // Refused and NOT retryable: this authorization is settled. Several
      // real settlements against one authorization arrive as their own
      // transaction objects, which D-84 handles.
      expect(second).toMatchObject({ kind: "ignored", retryable: false });
      // $6 settled, $6 recorded -- the first settlement, not the hold.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(6, "USD"));
    });
  });

  // =======================================================================
  describe("R7b — closed by D-84: force capture and overcapture are recorded, never ignored", () => {
    const transaction = (params: {
      instrumentId: string;
      amountCents: number;
      authorizationRef?: string | null;
    }) =>
      ({
        id: `ipi_r2_${randomUUID().slice(0, 12)}`,
        object: "issuing.transaction",
        // Stripe signs a purchase negative.
        amount: -params.amountCents,
        currency: "usd",
        type: "capture",
        authorization: params.authorizationRef ?? null,
        card: { id: `ic_x`, metadata: { waysafe_instrument_id: params.instrumentId } },
        merchant_data: {
          category: "fuel",
          category_code: "5541",
          name: "OFFLINE FUEL STOP",
          network_id: "forced_mid",
          city: "Nowhere",
          country: "US",
          postal_code: null,
          state: null,
          tax_id: null,
          terminal_id: "t_offline_1",
          url: null,
        },
      }) as unknown as Stripe.Issuing.Transaction;

    it("a FORCE CAPTURE with no authorization at all is recorded and charged against the cap", async () => {
      const f = await fixture();
      const instrument = await f.repos.instruments.createInstrument(
        {
          organizationId: f.org,
          mandateId: f.mandateId,
          rail: "stripe_issuing",
          externalRef: `ic_r2_${randomUUID().slice(0, 8)}`,
        },
        NOW,
      );

      const result = await handleStripeWebhook(
        f.repos,
        stripeEvent(
          "issuing_transaction.created",
          transaction({ instrumentId: instrument.id, amountCents: toMinorUnits(37, "USD") }),
        ),
        NOW,
      );
      // Never silently ignored. Before D-84 this event type was not handled
      // at all: the money moved and nothing recorded it.
      expect(result).toMatchObject({ kind: "applied", effect: "unauthorized_settlement" });

      // It really moved, so the cap is charged.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(37, "USD"));

      // The row is honest: DENY (what Waysafe would have said) on a row that
      // is EXECUTED (the money is gone).
      const rows = await prisma.authorization.findMany({ where: { mandateId: f.mandateId } });
      const forced = rows.find((r) => r.status === "EXECUTED" && r.decision === "DENY");
      expect(forced).toBeDefined();
      expect(forced!.reasonCodes).toContain(ReasonCode.DENY_SETTLED_WITHOUT_AUTHORIZATION);

      // And the evidence event carries what a principal needs to dispute it.
      const events = await f.evidence.listForOrganization(f.org);
      const flagged = events.find(
        (e) => e.type === "enforcement.stripe_issuing.unauthorized_settlement",
      );
      expect(flagged).toBeDefined();
      expect(flagged!.payload).toMatchObject({
        stripe_authorization_id: null,
        never_approved: toMinorUnits(37, "USD"),
        authorized: 0,
        currency: "USD",
      });
      // The dispute basis: what Waysafe would have decided, had it been asked.
      expect(flagged!.payload).toHaveProperty("would_have_decided");
      expect(flagged!.payload).toHaveProperty("would_have_reasoned");
      // The raw rail payload, which is what a dispute actually needs: the
      // trading name, the city, the terminal id. Kept separate from the
      // `merchant` assertion, which excludes the name because a name can
      // never confer trust (non-negotiable #3).
      const payload = flagged!.payload as {
        merchant: { name?: string };
        merchant_data: { name?: string; city?: string; terminal_id?: string };
      };
      expect(payload.merchant_data.name).toBe("OFFLINE FUEL STOP");
      expect(payload.merchant_data.city).toBe("Nowhere");
      expect(payload.merchant_data.terminal_id).toBe("t_offline_1");
      // And the assertion used for resolution still has no name in it.
      expect(payload.merchant.name).toBeUndefined();
    });

    it("an OVERCAPTURE settles the authorized portion and flags only the excess", async () => {
      const f = await fixture(
        policyFrom({
          per_transaction_max: toMinorUnits(50, "USD"),
          cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(100, "USD") }],
        }),
      );
      const { instrument, authorization: card } = await cardFor(f, toMinorUnits(20, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(20, "USD"));

      // The network settles $26 against a $20 authorization -- real on fuel.
      const result = await handleStripeWebhook(
        f.repos,
        stripeEvent(
          "issuing_transaction.created",
          transaction({
            instrumentId: instrument.id,
            amountCents: toMinorUnits(26, "USD"),
            authorizationRef: card.id,
          }),
        ),
        NOW,
      );
      expect(result).toMatchObject({ kind: "applied", effect: "over_authorized_settlement" });

      // $26 charged in total: $20 settled against the hold, $6 as the excess.
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(26, "USD"));

      const events = await f.evidence.listForOrganization(f.org);
      const flagged = events.find(
        (e) => e.type === "enforcement.stripe_issuing.over_authorized_settlement",
      );
      expect(flagged!.payload).toMatchObject({
        settled: toMinorUnits(26, "USD"),
        authorized: toMinorUnits(20, "USD"),
        never_approved: toMinorUnits(6, "USD"),
        stripe_authorization_id: card.id,
      });
    });

    it("CONTROL: a transaction that matches its authorization exactly is an ordinary capture", async () => {
      // Without this, the two cases above would pass against a handler that
      // flagged everything as unauthorized.
      const f = await fixture();
      const { instrument, authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));
      await handleIssuingAuthorizationRequest(f.repos, new StripeIssuingAdapter(), card, NOW);

      const result = await handleStripeWebhook(
        f.repos,
        stripeEvent(
          "issuing_transaction.created",
          transaction({
            instrumentId: instrument.id,
            amountCents: toMinorUnits(10, "USD"),
            authorizationRef: card.id,
          }),
        ),
        NOW,
      );
      expect(result).toMatchObject({ kind: "applied", effect: "capture" });
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(10, "USD"));

      const events = await f.evidence.listForOrganization(f.org);
      expect(
        events.some((e) => e.type.includes("unauthorized") || e.type.includes("over_authorized")),
      ).toBe(false);
    });

    it("a redelivered transaction event deduplicates rather than charging twice", async () => {
      const f = await fixture();
      const instrument = await f.repos.instruments.createInstrument(
        {
          organizationId: f.org,
          mandateId: f.mandateId,
          rail: "stripe_issuing",
          externalRef: `ic_r2_${randomUUID().slice(0, 8)}`,
        },
        NOW,
      );
      const event = stripeEvent(
        "issuing_transaction.created",
        transaction({ instrumentId: instrument.id, amountCents: toMinorUnits(12, "USD") }),
      );
      expect((await handleStripeWebhook(f.repos, event, NOW)).kind).toBe("applied");
      expect((await handleStripeWebhook(f.repos, event, NOW)).kind).toBe("duplicate");
      expect((await spend(f)).mandate.amount).toBe(toMinorUnits(12, "USD"));
    });

    it("a transaction on a card this deployment does not know stays retryable", async () => {
      const f = await fixture();
      const result = await handleStripeWebhook(
        f.repos,
        stripeEvent(
          "issuing_transaction.created",
          transaction({ instrumentId: "inst_not_ours", amountCents: toMinorUnits(5, "USD") }),
        ),
        NOW,
      );
      expect(result).toMatchObject({ kind: "ignored", retryable: true });
      expect((await spend(f)).mandate.amount).toBe(0);
    });
  });

  // =======================================================================
  describe("R8 — closed by D-88: a nonzero transfer is never recorded as zero (review: R1/Medium)", () => {
    it("three sub-cent atomic transfers are each charged one cent, with the atomic amount on the receipt", async () => {
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
        // The co-signature still authorizes the exact atomic amount. Rounding
        // is the budget's unit, never the transfer's.
        expect(result.response.co_signature?.amount_atomic).toBe("4999");
      }

      const rows = await f.authorization.listAuthorizations(f.org, 10);
      expect(rows.filter((r) => r.action.amount === 0)).toHaveLength(0); // was 3
      expect(rows.filter((r) => r.action.amount === 1)).toHaveLength(3);
      // 14,997 atomic units co-signed, three cents on the ledger. Before D-88
      // it was $0.00 and the cumulative limits never saw the spend at all.
      expect((await spend(f)).mandate.amount).toBe(3); // was 0

      // The signed receipt carries the atomic amount alongside the cents, so
      // a principal can see that 4,999 atomic units were charged as one cent
      // rather than having to trust the rounded figure on its own.
      const events = await f.evidence.listForOrganization(f.org);
      const decision = events.find((e) => e.type === "enforcement.x402.decision");
      expect(decision).toBeDefined();
      expect(decision!.payload).toMatchObject({
        amount: 1,
        currency: "USD",
        amount_atomic: "4999",
        asset_decimals: AMOY_USDC.decimals,
        amount_rounded_up: true,
      });
    });

    it("rounds UP, so a fraction of a cent is never free", () => {
      // Every case here returned the floor or the nearest cent before D-88.
      expect(assetAtomicToCents("1", AMOY_USDC)).toBe(1); // 0.000001 USDC
      expect(assetAtomicToCents("4999", AMOY_USDC)).toBe(1); // was 0
      expect(assetAtomicToCents("5000", AMOY_USDC)).toBe(1);
      expect(assetAtomicToCents("10001", AMOY_USDC)).toBe(2); // was 1
      expect(assetAtomicToCents("1000001", AMOY_USDC)).toBe(101); // was 100
    });

    it("CONTROL: an exact number of cents is not inflated", () => {
      // Rounding up must not charge an extra cent on an exact amount, which
      // a naive `floor + 1` would.
      expect(assetAtomicToCents("0", AMOY_USDC)).toBe(0);
      expect(assetAtomicToCents("10000", AMOY_USDC)).toBe(1);
      expect(assetAtomicToCents("1000000", AMOY_USDC)).toBe(100);
      expect(assetAtomicToCents("2500000", AMOY_USDC)).toBe(250);
    });
  });

  // =======================================================================
  describe("R9 — closed by D-89: the fetch deadline is absolute (review: R2/Medium)", () => {
    // The budget plus what a loaded CI box can add between the timer firing
    // and the promise settling. Deliberately generous: the defect this
    // replaces overran a 60ms budget by 170ms and would have overrun any
    // budget indefinitely, so a tolerance that distinguishes 60ms from
    // "however long the server feels like" is the thing worth asserting.
    const TOLERANCE_MS = 150;

    it("a slow-drip body cannot outlive the budget", async () => {
      // Before D-89 the only timer was `req.setTimeout`, which is an IDLE
      // timer: every chunk resets it, so one byte every 20ms held the
      // connection open for as long as the server cared to write.
      const server = createServer((_req, res) => {
        res.writeHead(402, { "content-type": "application/json" });
        const timer = setInterval(() => res.write(" "), 20);
        setTimeout(() => {
          clearInterval(timer);
          res.end("{}");
        }, 4000);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const started = Date.now();
        const outcome = await fetchResourceUnderPolicy(`http://127.0.0.1:${port}/`, {
          ...LOCAL_RESOURCE_FETCH_POLICY,
          timeoutMs: 60,
        }).then(
          () => "resolved" as const,
          (e: Error) => e.message,
        );
        const elapsed = Date.now() - started;
        // eslint-disable-next-line no-console
        console.log(`R9: a 60ms deadline returned after ${elapsed}ms (${outcome})`);

        expect(outcome).toContain("timed out after 60ms");
        // Was ~230ms against a 60ms budget, and unbounded in principle.
        expect(elapsed).toBeLessThanOrEqual(60 + TOLERANCE_MS);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("a chain of slow redirects cannot outlive the budget either", async () => {
      // This one already held before D-89: `fetchResourceUnderPolicy` checks
      // the remaining budget between hops. Kept as a guard, not as a
      // reproduction -- it is the property the new absolute timer must not
      // quietly lose while replacing the per-hop arithmetic.
      let hops = 0;
      const server = createServer((req, res) => {
        hops += 1;
        const port = (server.address() as AddressInfo).port;
        setTimeout(() => {
          res.writeHead(302, { location: `http://127.0.0.1:${port}/${hops}` });
          res.end();
        }, 40);
        void req;
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const started = Date.now();
        const outcome = await fetchResourceUnderPolicy(`http://127.0.0.1:${port}/`, {
          ...LOCAL_RESOURCE_FETCH_POLICY,
          timeoutMs: 100,
          maxRedirects: 20,
        }).then(
          () => "resolved" as const,
          (e: Error) => e.message,
        );
        const elapsed = Date.now() - started;
        // eslint-disable-next-line no-console
        console.log(`R9: ${hops} slow redirect hops under a 100ms deadline took ${elapsed}ms`);

        expect(outcome).toContain("timed out after 100ms");
        expect(elapsed).toBeLessThanOrEqual(100 + TOLERANCE_MS);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("CONTROL: a prompt response inside the budget still succeeds", async () => {
      // Without this, a deadline that fired immediately would look correct.
      const server = createServer((_req, res) => {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ x402Version: 1, accepts: [] }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const result = await fetchResourceUnderPolicy(`http://127.0.0.1:${port}/`, {
          ...LOCAL_RESOURCE_FETCH_POLICY,
          timeoutMs: 2000,
        });
        expect(result.status).toBe(402);
        expect(JSON.parse(result.body)).toMatchObject({ x402Version: 1 });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // =======================================================================
  describe("R10 — closed by D-80: mandate authority is re-read under the money lock (review: R12)", () => {
    it("a revocation committed between the gate and the lock now DENIES", async () => {
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
      expect(racing.decision).toBe(Decision.DENY); // was ALLOW
      expect(racing.reasons.map((r) => r.code)).toContain(ReasonCode.DENY_MANDATE_REVOKED);
      // And it took no hold.
      expect((await spend(f)).mandate.amount).toBe(0);

      (f.authorization as { withMandateLock: unknown }).withMandateLock = original;

      // CONTROL: still denied once the revocation is visible to the gate too.
      const after = await decided(f, 1);
      expect(after.decision).toBe(Decision.DENY);
      expect(after.reasons.map((r) => r.code)).toContain(ReasonCode.DENY_MANDATE_REVOKED);
    });

    it("CONTROL: an ACTIVE mandate still ALLOWs, so the re-read is not refusing everything", async () => {
      const f = await fixture();
      const ok = await decided(f, 1);
      expect(ok.decision).toBe(Decision.ALLOW);
    });

    it("the card rail re-reads it too: a revocation in the same window DENIES", async () => {
      // D-80 applies to every decision path, not just authorize(). The card
      // rail read its gate before the lock in exactly the same shape.
      const f = await fixture();
      const { authorization: card } = await cardFor(f, toMinorUnits(10, "USD"));

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

      const decision = await handleIssuingAuthorizationRequest(
        f.repos,
        new StripeIssuingAdapter(),
        card,
        NOW,
      );
      (f.authorization as { withMandateLock: unknown }).withMandateLock = original;

      expect(decision.response.approved).toBe(false);
      expect(decision.response.reason_codes).toContain(ReasonCode.DENY_MANDATE_REVOKED);
      expect((await spend(f)).mandate.amount).toBe(0);
    });

    it("STRUCTURAL: every decision path obtains its policy through withAuthorizedMandate", async () => {
      // D-80 follow-up. D-80 fixed three call sites; this asserts the fourth
      // one cannot be written wrong by omission. A decision path is one that
      // calls `evaluate()`; each must get its policy from the gated helper,
      // not from a bare `getMandateDetail` inside a raw lock.
      //
      // Source-level because there is no runtime seam: a path that skipped
      // the gate would simply be a different, correct-looking function.
      const { readFileSync } = await import("node:fs");
      const paths = [
        "apps/api/src/authorization/service.ts",
        "apps/api/src/enforcement/stripe-issuing.ts",
        "apps/api/src/enforcement/x402.ts",
      ];
      let evaluators = 0;
      for (const path of paths) {
        const source = readFileSync(path, "utf8");
        if (!source.includes("evaluate({")) continue;
        evaluators += 1;
        expect(source, `${path} calls evaluate() without withAuthorizedMandate`).toContain(
          "withAuthorizedMandate(",
        );
      }
      // Guards the guard: if evaluate() moved, the loop above would assert
      // nothing at all.
      expect(evaluators).toBe(3);
    });

    it("an expired POLICY is caught under the lock as well, not only a revoked row", async () => {
      // gateMandateExpiry, which x402 never consulted at all before D-80
      // because that file kept its own copy of the status gate and no
      // expiry check.
      const f = await fixture(policyFrom({ expires_at: "2026-01-01T00:00:00.000Z" }));
      const auth = await decided(f, 1);
      expect(auth.decision).toBe(Decision.DENY);
      expect(auth.reasons.map((r) => r.code)).toContain(ReasonCode.DENY_MANDATE_EXPIRED);
    });
  });

  // =======================================================================
  describe("R11 — closed by D-85: an approval re-checks the spender's cumulative cap", () => {
    it("two $80 step-ups on a $100 cap: the first approves, the second is denied", async () => {
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
              payment_method_ref: "pm_spender",
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

      const first = await approve(one);
      expect(first.kind).toBe("resolved");
      if (first.kind !== "resolved") throw new Error("unreachable");
      expect(first.authorization.status).toBe("STEP_UP_APPROVED");

      // The second approval would put $160 on a $100 cap. Denied.
      const second = await approve(two);
      expect(second.kind).toBe("resolved");
      if (second.kind !== "resolved") throw new Error("unreachable");
      expect(second.authorization.status).toBe("STEP_UP_DECLINED"); // was STEP_UP_APPROVED

      // The decline REASON lands on the evidence chain, not on the
      // authorization row: `resolveStepUp` changes status only, so the row
      // still carries the reasons it was raised with. Named as a known gap
      // in D-85 rather than papered over here.
      const events = await approver.evidence.listForOrganization(approver.org);
      const declined = events.filter((e) => e.type === "step_up.declined");
      expect(declined.length).toBeGreaterThan(0);
      expect(JSON.stringify(declined.at(-1)?.payload)).toContain(
        ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED,
      );

      // $80 held, not $160. Before D-85 this read $160 against a $100 cap.
      const snapshot = await approver.authorization.getSpendSnapshot(
        created.mandateId,
        spenderPolicy.accounting,
        NOW,
      );
      expect(snapshot.mandate.amount).toBe(toMinorUnits(80, "USD"));
      expect(snapshot.mandate.amount).toBeLessThanOrEqual(toMinorUnits(100, "USD"));
    });

    it("CONTROL: two $40 step-ups on a $100 cap both approve", async () => {
      // Without this, the fix would look correct while refusing every second
      // approval regardless of the arithmetic.
      const approver = await fixture(
        policyFrom({
          cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(100_000, "USD") }],
          per_transaction_max: toMinorUnits(100_000, "USD"),
        }),
      );
      const suffix = randomUUID().slice(0, 12);
      const spenderPrincipal = `prin_r2c_${suffix}`;
      const spenderAgent = `agt_r2c_${suffix}`;
      await prisma.principal.create({
        data: { id: spenderPrincipal, organizationId: approver.org, displayName: "Spender" },
      });
      await prisma.agent.create({
        data: { id: spenderAgent, organizationId: approver.org, name: "Spender", status: "ACTIVE" },
      });
      const spenderPolicy = policyFrom({
        per_transaction_max: toMinorUnits(100, "USD"),
        cumulative_limits: [{ window: "mandate", max_amount: toMinorUnits(100, "USD") }],
        step_up: { above_amount: toMinorUnits(20, "USD"), ttl_seconds: 900 },
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
        "203.0.113.9",
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
              amount: toMinorUnits(40, "USD"),
              currency: "USD" as const,
              merchant: { domain: "staples.com" },
              attestations: {},
              payment_method_ref: "pm_spender",
            },
          } as never,
          apiKey: spenderKey.fullKey,
          now: NOW,
        });
        if (result.kind !== "decided") throw new Error(result.kind);
        expect(result.authorization.decision).toBe(Decision.STEP_UP);
        return result.authorization;
      };
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

      const a = await approve(one);
      const b = await approve(two);
      if (a.kind !== "resolved" || b.kind !== "resolved") throw new Error("unreachable");
      expect(a.authorization.status).toBe("STEP_UP_APPROVED");
      expect(b.authorization.status).toBe("STEP_UP_APPROVED");

      const snapshot = await approver.authorization.getSpendSnapshot(
        created.mandateId,
        spenderPolicy.accounting,
        NOW,
      );
      expect(snapshot.mandate.amount).toBe(toMinorUnits(80, "USD"));
    });
  });
});
