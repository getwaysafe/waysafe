/**
 * D-76: a decision, its ledger hold and its evidence event are one
 * transaction.
 *
 * NOTE ON THE BRIEF. This work was asked for as "prove that today the
 * handler responds to Stripe before the evidence event exists". It does
 * not, and did not: read against `fe26584`, both rails appended the evidence
 * event *before* returning a response. There was never a window in which
 * Stripe received `approved: true` and the evidence write then failed.
 *
 * The real defect was narrower and is still worth closing. The decision plus
 * its ledger rows committed in one transaction; the evidence event was a
 * *second*, separate transaction immediately afterwards. A crash or an
 * evidence-write failure between the two left a committed authorization and
 * a committed RESERVATION with no evidence event, and -- because nothing
 * caught the throw -- a 500, so Stripe declined on timeout. Net result:
 * budget consumed, nothing bought, nothing in the chain.
 *
 * So the ordering test below asserts the property that was already true
 * (evidence precedes the answer) to pin it against regression, and the
 * atomicity tests assert the property that was false and is now true.
 *
 * `InMemoryEvidenceRepository` has no transaction to roll back, so the
 * rollback case is Postgres-gated. The ordering and decline cases run
 * offline.
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  Decision,
  ID_PREFIX,
  ReasonCode,
  createStaticDirectory,
  generateId,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  type Policy,
} from "@waysafe/core";
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { probeDatabase, requireDbOrExplainSkip } from "../test-support/db-gate.js";
import type { NewEvidenceEvent } from "../evidence/types.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "../instruments/in-memory-repository.js";
import { PrismaAuthorizationRepository } from "../authorization/prisma-repository.js";
import { PrismaEvidenceRepository } from "../evidence/prisma-repository.js";
import { PrismaInstrumentRepository } from "../instruments/prisma-repository.js";
import { handleIssuingAuthorizationRequest, StripeIssuingAdapter } from "./stripe-issuing.js";

const DIRECTORY = createStaticDirectory([{ domain: "staples.com", display_name: "Staples" }]);
const NETWORK_MID = "visa_network_id_d76";
const NOW = new Date("2026-10-05T12:00:00.000Z");

function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "d76",
    currency: "USD",
    per_transaction_max: toMinorUnits(500, "USD"),
    cumulative_limits: [{ window: "month", max_amount: toMinorUnits(1000, "USD") }],
    merchants: {
      allow: [{ scheme: "network_mid", value: NETWORK_MID }],
      deny: [],
      unlisted: "DENY",
    },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

function issuingAuthorization(params: {
  instrumentId: string;
  amount: number;
  authorizationId: string;
}): Stripe.Issuing.Authorization {
  return {
    id: params.authorizationId,
    object: "issuing.authorization",
    amount: params.amount,
    approved: false,
    currency: "usd",
    merchant_data: {
      category: "office_supplies",
      category_code: "5943",
      name: "Staples",
      network_id: NETWORK_MID,
      city: null,
      country: null,
      postal_code: null,
      state: null,
      tax_id: null,
      terminal_id: null,
      url: null,
    },
    card: {
      id: `ic_test_${params.instrumentId}`,
      metadata: { waysafe_instrument_id: params.instrumentId },
    },
    pending_request: {
      amount: params.amount,
      amount_details: null,
      currency: "usd",
      is_amount_controllable: false,
      merchant_amount: params.amount,
      merchant_currency: "usd",
      network_risk_score: null,
    },
  } as unknown as Stripe.Issuing.Authorization;
}

// --- Offline: ordering, and the decline on a failed append -----------------

/** An in-memory evidence repository whose `appendEvent` can be made to fail,
 * and which records the order of calls relative to the response. */
class ObservableEvidence extends InMemoryEvidenceRepository {
  failNext = false;
  appendCount = 0;

  override async appendEvent(input: NewEvidenceEvent) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("evidence store unavailable");
    }
    this.appendCount += 1;
    return super.appendEvent(input);
  }
}

async function offlineSetup(policy: Policy) {
  const authorization = new InMemoryAuthorizationRepository(DIRECTORY);
  const evidence = new ObservableEvidence(new FakeEd25519Signer());
  const instruments = new InMemoryInstrumentRepository();
  const organizationId = "org_d76";
  const principalId = generateId(ID_PREFIX.principal);
  const agentId = generateId(ID_PREFIX.agent);
  const policyHash = "d76-hash";
  const { mandateId } = authorization.seedMandate({
    organizationId,
    principalId,
    agentId,
    policy,
    policyHash,
  });
  const instrument = await instruments.createInstrument(
    { organizationId, mandateId, rail: "stripe_issuing", externalRef: `ic_test_${mandateId}` },
    NOW,
  );
  return { authorization, evidence, instruments, organizationId, mandateId, instrument };
}

describe("D-76: the evidence event precedes the answer, and shares its transaction", () => {
  it("the evidence event exists before the response is produced (pinned, was already true)", async () => {
    const ctx = await offlineSetup(policyFrom());
    const adapter = new StripeIssuingAdapter();

    // Observed by counting appends at the moment the handler returns: if the
    // append happened after the response, the count would be 0 here.
    const decision = await handleIssuingAuthorizationRequest(
      { authorization: ctx.authorization, evidence: ctx.evidence, instruments: ctx.instruments },
      adapter,
      issuingAuthorization({
        instrumentId: ctx.instrument.id,
        amount: toMinorUnits(80, "USD"),
        authorizationId: "iauth_d76_order",
      }),
      NOW,
    );

    expect(decision.response.approved).toBe(true);
    expect(ctx.evidence.appendCount).toBe(1);

    const events = await ctx.evidence.listForOrganization(ctx.organizationId);
    const decisionEvent = events.find(
      (e) => e.type === "enforcement.stripe_issuing.decision",
    );
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent!.subject_id).toBe(decision.authorizationId);
  });

  it("THE FIX: a failed evidence append produces a DECLINE, never an approval without a record", async () => {
    const ctx = await offlineSetup(policyFrom());
    const adapter = new StripeIssuingAdapter();
    ctx.evidence.failNext = true;

    const decision = await handleIssuingAuthorizationRequest(
      { authorization: ctx.authorization, evidence: ctx.evidence, instruments: ctx.instruments },
      adapter,
      issuingAuthorization({
        instrumentId: ctx.instrument.id,
        amount: toMinorUnits(80, "USD"),
        authorizationId: "iauth_d76_fail",
      }),
      NOW,
    );

    // Before D-76 this threw, became a 500, and left Stripe's own
    // decline-on-timeout setting as the only thing failing closed.
    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toEqual([
      ReasonCode.DENY_DECISION_NOT_RECORDED,
    ]);
    expect(decision.authorizationId).toBeNull();

    // CONTROL: the very next request, with the store healthy, is approved --
    // so the decline above is the append failing, not a broken handler.
    const healthy = await handleIssuingAuthorizationRequest(
      { authorization: ctx.authorization, evidence: ctx.evidence, instruments: ctx.instruments },
      adapter,
      issuingAuthorization({
        instrumentId: ctx.instrument.id,
        amount: toMinorUnits(80, "USD"),
        authorizationId: "iauth_d76_healthy",
      }),
      NOW,
    );
    expect(healthy.response.approved).toBe(true);
  });
});

// --- Postgres: the rollback itself ----------------------------------------

const prisma = new PrismaClient();
const SUITE = "D-76 atomicity against real Postgres";
const reachable = await probeDatabase(prisma);
requireDbOrExplainSkip(SUITE, reachable);

const createdOrgIds: string[] = [];

async function seedInstrumentMandate(policy: Policy) {
  const organizationId = generateId(ID_PREFIX.organization);
  const principalId = generateId(ID_PREFIX.principal);
  const mandateId = generateId(ID_PREFIX.mandate);
  const mandateVersionId = generateId(ID_PREFIX.mandate_version);
  createdOrgIds.push(organizationId);

  await prisma.organization.create({ data: { id: organizationId, name: "D-76 Org" } });
  await prisma.principal.create({
    data: { id: principalId, organizationId, displayName: "Principal" },
  });
  await prisma.mandate.create({
    data: { id: mandateId, organizationId, principalId, status: "ACTIVE" },
  });
  await prisma.mandateVersion.create({
    data: {
      id: mandateVersionId,
      mandateId,
      version: 1,
      intentText: "test",
      policy: policy as unknown as Prisma.InputJsonValue,
      policyHash: "d76-hash",
      compilerName: "test",
      assumptions: [],
      authenticatedAt: new Date(),
    },
  });
  await prisma.mandate.update({
    where: { id: mandateId },
    data: { currentVersionId: mandateVersionId },
  });
  const instrument = await prisma.instrument.create({
    data: {
      id: generateId(ID_PREFIX.instrument),
      organizationId,
      mandateId,
      rail: "stripe_issuing",
      externalRef: `ic_test_${mandateId}`,
    },
  });
  return { organizationId, mandateId, instrumentId: instrument.id };
}

/** A real Prisma evidence repository whose append can be made to fail
 * *inside* the shared transaction, which is the only way to observe a real
 * rollback. */
class FailingPrismaEvidence extends PrismaEvidenceRepository {
  failNext = false;
  override async appendEvent(input: NewEvidenceEvent) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("evidence store unavailable");
    }
    return super.appendEvent(input);
  }
}

describe.skipIf(!reachable)(SUITE, { timeout: 30_000 }, () => {
  afterEach(async () => {
    while (createdOrgIds.length > 0) {
      const id = createdOrgIds.pop();
      if (id) await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("THE ATTACK, closed: a failed evidence append rolls back the authorization AND the hold", async () => {
    const { organizationId, mandateId, instrumentId } = await seedInstrumentMandate(policyFrom());
    const authorization = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const evidence = new FailingPrismaEvidence(prisma, new FakeEd25519Signer());
    const instruments = new PrismaInstrumentRepository(prisma);
    const adapter = new StripeIssuingAdapter();

    evidence.failNext = true;
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      adapter,
      issuingAuthorization({
        instrumentId,
        amount: toMinorUnits(80, "USD"),
        authorizationId: "iauth_d76_rollback",
      }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toEqual([ReasonCode.DENY_DECISION_NOT_RECORDED]);

    // The point of the whole entry: nothing was committed. Before D-76 the
    // authorization row and its RESERVATION survived, so the mandate's
    // budget was consumed with no record of why.
    const rows = await prisma.authorization.findMany({ where: { mandateId } });
    expect(rows).toEqual([]);
    const ledger = await prisma.ledgerEntry.findMany({ where: { mandateId } });
    expect(ledger).toEqual([]);
    const events = await prisma.evidenceEvent.findMany({ where: { organizationId } });
    expect(events).toEqual([]);
  });

  it("CONTROL: a healthy append commits all three together, in one transaction", async () => {
    const { organizationId, mandateId, instrumentId } = await seedInstrumentMandate(policyFrom());
    const authorization = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const evidence = new FailingPrismaEvidence(prisma, new FakeEd25519Signer());
    const instruments = new PrismaInstrumentRepository(prisma);
    const adapter = new StripeIssuingAdapter();

    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      adapter,
      issuingAuthorization({
        instrumentId,
        amount: toMinorUnits(80, "USD"),
        authorizationId: "iauth_d76_commit",
      }),
      NOW,
    );
    expect(decision.response.approved).toBe(true);

    const rows = await prisma.authorization.findMany({ where: { mandateId } });
    expect(rows).toHaveLength(1);
    const ledger = await prisma.ledgerEntry.findMany({ where: { mandateId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.type).toBe("RESERVATION");
    const events = await prisma.evidenceEvent.findMany({ where: { organizationId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.subjectId).toBe(rows[0]?.id);
  });

  it("the added latency is measured, not assumed, and stays well inside Stripe's 2s window", async () => {
    // Stripe waits about 2s for the issuing_authorization.request response.
    // D-76 moves one INSERT plus one `SELECT ... FOR UPDATE` on the
    // organization row inside a transaction that was already open, so the
    // cost is the row lock and the insert, not a second round trip to open
    // a transaction. Measured over several runs against the real database
    // this repository uses (Neon, which also adds real network latency).
    const { mandateId, instrumentId } = await seedInstrumentMandate(policyFrom());
    const authorization = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const evidence = new PrismaEvidenceRepository(prisma, new FakeEd25519Signer());
    const instruments = new PrismaInstrumentRepository(prisma);
    const adapter = new StripeIssuingAdapter();

    // Measure the DELTA, not the total. The total is dominated by network
    // latency to a shared cloud database and says nothing about this change.
    // What D-76 actually costs is one `SELECT ... FOR UPDATE` on the
    // organizations row inside a transaction that was already open -- and it
    // saves opening a second transaction, which the old shape did.
    const orgId = (await prisma.instrument.findFirstOrThrow({ where: { id: instrumentId } }))
      .organizationId;

    const joined: number[] = [];
    const separate: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      // (1) D-76's shape: the append joins an already-open transaction.
      const a = performance.now();
      await authorization.withMandateLock(mandateId, () =>
        evidence.withOrganizationLock(orgId, () =>
          evidence.appendEvent({
            organizationId: orgId,
            type: "latency.probe.joined",
            subjectType: "authorization",
            subjectId: `probe_joined_${i}`,
            payload: {},
            now: NOW,
          }),
        ),
      );
      joined.push(performance.now() - a);

      // (2) The old shape: a second, independent transaction.
      const b = performance.now();
      await evidence.withOrganizationLock(orgId, () =>
        evidence.appendEvent({
          organizationId: orgId,
          type: "latency.probe.separate",
          subjectType: "authorization",
          subjectId: `probe_separate_${i}`,
          payload: {},
          now: NOW,
        }),
      );
      separate.push(performance.now() - b);
    }

    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    // eslint-disable-next-line no-console
    console.log(
      `D-76 latency: append joined to the decision transaction, median ${med(joined).toFixed(0)}ms ` +
        `(samples ${joined.map((s) => s.toFixed(0)).join(", ")}); ` +
        `append in its own transaction, median ${med(separate).toFixed(0)}ms ` +
        `(samples ${separate.map((s) => s.toFixed(0)).join(", ")})`,
    );

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const decision = await handleIssuingAuthorizationRequest(
        { authorization, evidence, instruments },
        adapter,
        issuingAuthorization({
          instrumentId,
          amount: toMinorUnits(10, "USD"),
          authorizationId: `iauth_d76_latency_${i}`,
        }),
        NOW,
      );
      samples.push(performance.now() - started);
      expect(decision.response.approved).toBe(true);
    }

    const worst = Math.max(...samples);
    // eslint-disable-next-line no-console
    console.log(
      `D-76 end-to-end decision latency (ms), 5 runs: ${samples
        .map((s) => s.toFixed(0))
        .join(", ")} -- worst ${worst.toFixed(0)}ms against Stripe's ~2000ms window`,
    );
    // A deliberately loose assertion: this runs against a shared cloud
    // database, so a cold start is a real possibility and a tight bound
    // would make this test flaky rather than informative. The number above
    // is the useful output; this only catches an order-of-magnitude
    // regression.
    expect(worst).toBeLessThan(2_000);
  });
});
