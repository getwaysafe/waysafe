/**
 * FINDINGS 5 and 6 of the adversarial review of 387958a -- both about the
 * ledger, which is where non-negotiable #6 lives ("cumulative spend is a SUM
 * over the ledger, never a counter column"). A SUM over rows with the wrong
 * window key, or over rows that never got written, is exactly as wrong as a
 * lost counter update -- it just looks more trustworthy.
 *
 * Finding 5: an approved step-up never charges the mandate that spent, and
 *            `recordExecution`'s reservation lookup is not scoped to a
 *            mandate, so it can release a *different* mandate's reservation.
 * Finding 6: release and settle recompute the calendar window from `now()`
 *            instead of using the window the reservation was made in.
 *
 * **Against real Postgres, deliberately.** Both findings reproduce only
 * there. `InMemoryAuthorizationRepository` keeps one ledger array per
 * mandate, so its reservation lookups are mandate-scoped *by construction*
 * and Finding 5's cross-mandate half is invisible to it -- an instance of
 * exactly the gap D-15 warned the in-memory fake would leave. Skips without
 * a reachable `DATABASE_URL`, same gate as `prisma-repository.test.ts`.
 *
 * NOTE ON THE FINDING'S FRAMING (Finding 5, case c). The review describes
 * "recordExecution called with an authorization from mandate A but mandate
 * id B". `RecordExecutionInput` has **no mandate id field** -- see
 * `types.ts` -- so there is no B to pass. The mandate it writes to is read
 * from the authorization row, which is correct. The defect is entirely on
 * the *read* side: `findFirst({ where: { authorizationId, type:
 * "RESERVATION" } })` is not scoped to that mandate, and since D-62 two
 * different mandates can hold a RESERVATION under one authorization id. Case
 * (c) below is re-cast to that, the mechanism that actually exists.
 *
 * Written as the attack first. Every test here passes against 21e4a00.
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
  windowKeys,
  type Policy,
} from "@waysafe/core";
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { probeDatabase, requireDbOrExplainSkip } from "../test-support/db-gate.js";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { PrismaInstrumentRepository } from "../instruments/prisma-repository.js";
import {
  handleIssuingAuthorizationRequest,
  StripeIssuingAdapter,
} from "../enforcement/stripe-issuing.js";
import { PrismaAuthorizationRepository } from "./prisma-repository.js";
import { authorize, resolveStepUpAsApprover, type AuthorizeRepos } from "./service.js";

const agentKeys = new InMemoryAgentKeyRepository();
const evidence = new InMemoryEvidenceRepository(new FakeEd25519Signer());

const prisma = new PrismaClient();
const SUITE_NAME = "FINDINGS 5 & 6: the ledger (against real Postgres)";
const reachable = await probeDatabase(prisma);
requireDbOrExplainSkip(SUITE_NAME, reachable);

const DIRECTORY = createStaticDirectory([{ domain: "staples.com", display_name: "Staples" }]);

/** Two calendar windows, one month apart, in the policy timezone (UTC). */
const W1 = new Date("2026-08-24T12:00:00.000Z");
const W2 = new Date("2026-09-24T12:00:00.000Z");
const KEYS_W1 = windowKeys(W1, "UTC");
const KEYS_W2 = windowKeys(W2, "UTC");

function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "finding 5/6",
    currency: "USD",
    per_transaction_max: toMinorUnits(2000, "USD"),
    merchants: {
      allow: [{ scheme: "domain", value: "staples.com", label: "Staples" }],
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

const createdOrgIds: string[] = [];

async function seedMandate(policy: Policy, options: { organizationId?: string } = {}) {
  const organizationId = options.organizationId ?? generateId(ID_PREFIX.organization);
  const principalId = generateId(ID_PREFIX.principal);
  const agentId = generateId(ID_PREFIX.agent);
  const mandateId = generateId(ID_PREFIX.mandate);
  const mandateVersionId = generateId(ID_PREFIX.mandate_version);

  if (!options.organizationId) {
    createdOrgIds.push(organizationId);
    await prisma.organization.create({ data: { id: organizationId, name: "Finding 5/6 Org" } });
  }
  await prisma.principal.create({
    data: { id: principalId, organizationId, displayName: "Principal" },
  });
  await prisma.agent.create({
    data: { id: agentId, organizationId, name: "Agent", status: "ACTIVE" },
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
      policyHash: "test-hash",
      compilerName: "test",
      assumptions: [],
      authenticatedAt: new Date(),
      agents: { create: { agentId } },
    },
  });
  await prisma.mandate.update({
    where: { id: mandateId },
    data: { currentVersionId: mandateVersionId },
  });

  const key = await agentKeys.createKey({ organizationId, agentId, name: "k" }, new Date());
  return { organizationId, principalId, agentId, mandateId, apiKey: key.fullKey };
}

async function seedInstrumentMandate(policy: Policy) {
  const organizationId = generateId(ID_PREFIX.organization);
  const principalId = generateId(ID_PREFIX.principal);
  const mandateId = generateId(ID_PREFIX.mandate);
  const mandateVersionId = generateId(ID_PREFIX.mandate_version);
  createdOrgIds.push(organizationId);

  await prisma.organization.create({ data: { id: organizationId, name: "Finding 6 Org (card)" } });
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
      policyHash: "test-hash",
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

function issuingAuthorization(params: {
  instrumentId: string;
  amount: number;
  networkId: string;
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
      network_id: params.networkId,
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

function request(organizationId: string, agentId: string, principalId: string, amountUsd: number) {
  return {
    agent_id: agentId,
    principal_id: principalId,
    action: {
      amount: toMinorUnits(amountUsd, "USD"),
      currency: "USD" as const,
      merchant: { domain: "staples.com" },
      attestations: {},
    },
    context: {},
  };
}

type LedgerRow = {
  type: string;
  amount: number;
  dayKey: string;
  weekKey: string;
  monthKey: string;
  authorizationId: string;
};

async function ledgerFor(mandateId: string): Promise<LedgerRow[]> {
  const rows = await prisma.ledgerEntry.findMany({
    where: { mandateId },
    orderBy: { createdAt: "asc" },
    select: {
      type: true,
      amount: true,
      dayKey: true,
      weekKey: true,
      monthKey: true,
      authorizationId: true,
    },
  });
  return rows;
}

/** The exact SUM `getSpendSnapshot` would compute for one month window. */
function monthSum(rows: LedgerRow[], monthKey: string): number {
  return rows.filter((r) => r.monthKey === monthKey).reduce((n, r) => n + r.amount, 0);
}

// 30s per test, the same allowance prisma-repository.test.ts's own Postgres
// cases take: each case here is a dozen-plus real round trips against a Neon
// instance that scales to zero when idle, so the 5s default misreports a cold
// connection as a hung test.
describe.skipIf(!reachable)(SUITE_NAME, { timeout: 30_000 }, () => {
  afterEach(async () => {
    while (createdOrgIds.length > 0) {
      const id = createdOrgIds.pop();
      if (id) await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // =========================================================================
  // FINDING 5 -- the approved transaction never costs the mandate that spent
  // =========================================================================

  /**
   * Spender: $100/month cap, `step_up_on_first_use` so the first payment at
   * a merchant escalates on its own merits rather than on its amount (an
   * amount-based `above_amount` threshold would make the *second* attempt
   * step up too, masking whether the cap bit). `reserve_on_step_up: false`,
   * which is precisely the configuration the review names: a non-reserving
   * step-up.
   */
  async function setUpSpenderAndApprover() {
    const approver = await seedMandate(
      policyFrom({ cumulative_limits: [{ window: "month", max_amount: toMinorUnits(100000, "USD") }] }),
    );
    const spender = await seedMandate(
      policyFrom({
        cumulative_limits: [{ window: "month", max_amount: toMinorUnits(100, "USD") }],
        merchants: {
          allow: [{ scheme: "domain", value: "staples.com", label: "Staples" }],
          deny: [],
          unlisted: "DENY",
          step_up_on_first_use: true,
        },
        accounting: { reserve_on_step_up: false },
        escalation: { approvers: [approver.mandateId] },
      }),
      { organizationId: approver.organizationId },
    );
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
    return { approver, spender, repo, repos };
  }

  it("(a) THE ATTACK, closed by D-71: an approved, executed $80 costs the spender's $100 cap, so another $80 is DENIED", async () => {
    const { approver, spender, repo, repos } = await setUpSpenderAndApprover();

    // 1. $80 at a merchant this mandate has not used -> STEP_UP.
    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");
    expect(first.authorization.decision).toBe(Decision.STEP_UP);
    expect(first.authorization.reasons.map((r) => r.code)).toContain(
      ReasonCode.STEP_UP_FIRST_TIME_MERCHANT,
    );

    // 2. A real D-62 approver approves it.
    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W1,
    });
    expect(outcome.kind).toBe("resolved");

    // 3. The money moves and execution is recorded.
    await repo.recordExecution(
      {
        authorizationId: first.authorization.id,
        mandateId: spender.mandateId,
        provider: "stripe",
        providerReference: "pi_test_finding5",
        providerFee: 0,
      },
      W1,
    );

    // The SUM over the spender's own ledger now reports the $80 that
    // really moved. It read $0 before D-71.
    const snapshot = await repo.getSpendSnapshot(spender.mandateId, { timezone: "UTC" } as never, W1);
    expect(snapshot.month.amount).toBe(toMinorUnits(80, "USD"));

    // 4. So the next $80 is refused: $160 does not fit a $100 monthly cap.
    const second = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (second.kind !== "decided") throw new Error("unreachable");
    expect(second.authorization.decision).toBe(Decision.DENY); // was ALLOW
    expect(second.authorization.reasons.map((r) => r.code)).toContain(
      ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED,
    );
  });

  it("(a2) and the budget is consumed at APPROVAL, not only at execution", async () => {
    // The other half of (a): before D-71 a non-reserving step-up left the
    // spender's ledger empty between approval and execution, so any number
    // of $80 payments could be approved against an $80 cap.
    const { approver, spender, repo, repos } = await setUpSpenderAndApprover();

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");
    expect(first.authorization.decision).toBe(Decision.STEP_UP);

    await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W1,
    });

    // No execution yet. The hold already exists.
    const snapshot = await repo.getSpendSnapshot(spender.mandateId, { timezone: "UTC" } as never, W1);
    expect(snapshot.month.amount).toBe(toMinorUnits(80, "USD"));

    const second = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (second.kind !== "decided") throw new Error("unreachable");
    expect(second.authorization.decision).toBe(Decision.DENY);
    expect(second.authorization.reasons.map((r) => r.code)).toContain(
      ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED,
    );
  });

  it("(b) where the approved $80 lands now: a hold on the spender AND the approver's own separate D-62 charge", async () => {
    const { approver, spender, repo, repos } = await setUpSpenderAndApprover();

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");

    await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W1,
    });

    // Immediately after approval, before execution: a hold on the spender
    // (D-71) and, separately, the approver's own permanent charge (D-62
    // Addition B). Before D-71 the spender's ledger was empty here.
    expect(await ledgerFor(spender.mandateId)).toMatchObject([
      { type: "RESERVATION", amount: toMinorUnits(80, "USD") },
    ]);
    expect(await ledgerFor(approver.mandateId)).toMatchObject([
      { type: "RESERVATION", amount: toMinorUnits(80, "USD") },
    ]);

    await repo.recordExecution(
      {
        authorizationId: first.authorization.id,
        mandateId: spender.mandateId,
        provider: "stripe",
        providerReference: "pi_test_finding5b",
        providerFee: 0,
      },
      W1,
    );

    // After execution the spender's own hold is released and replaced by a
    // real capture -- its OWN reservation, not the approver's. The release
    // that used to appear here was of the approver's row, and the two
    // cancelled, which is why (a)'s SUM read $0.
    const spenderRows = await ledgerFor(spender.mandateId);
    expect(spenderRows.map((r) => [r.type, r.amount])).toEqual([
      ["RESERVATION", toMinorUnits(80, "USD")],
      ["RELEASE", -toMinorUnits(80, "USD")],
      ["CAPTURE", toMinorUnits(80, "USD")],
    ]);
    expect(monthSum(spenderRows, KEYS_W1.month)).toBe(toMinorUnits(80, "USD"));

    // The approver is still charged, and its reservation is still never
    // released -- on its own ledger or anyone else's (D-62 Addition B).
    const approverRows = await ledgerFor(approver.mandateId);
    expect(monthSum(approverRows, KEYS_W1.month)).toBe(toMinorUnits(80, "USD"));
    expect(approverRows.filter((r) => r.type === "RELEASE")).toEqual([]);
  });

  it("(c) re-cast, closed by D-71: recordExecution's reservation lookup is mandate-scoped, and a wrong mandate id is rejected", async () => {
    // The review's framing ("called with mandate id B") was not expressible
    // before D-71 -- RecordExecutionInput had no mandate id at all. It does
    // now, it is validated rather than trusted, and the reservation lookup
    // is scoped by it. The mechanism that was broken: since D-62 two
    // mandates can hold a RESERVATION under one authorization id, and the
    // lookup picked by authorization id alone.
    const { approver, spender, repo, repos } = await setUpSpenderAndApprover();

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");
    await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W1,
    });

    // Two reservations now share this authorization id, on two mandates --
    // which is legitimate and must stay possible (D-62 Addition B + D-71).
    const allReservations = await prisma.ledgerEntry.findMany({
      where: { authorizationId: first.authorization.id, type: "RESERVATION" },
      select: { mandateId: true },
    });
    expect(allReservations.map((r) => r.mandateId).sort()).toEqual(
      [approver.mandateId, spender.mandateId].sort(),
    );

    // Presenting mandate B for an authorization issued by mandate A is
    // refused outright, rather than writing to whichever mandate the row
    // happens to name.
    await expect(
      repo.recordExecution(
        {
          authorizationId: first.authorization.id,
          mandateId: approver.mandateId,
          provider: "stripe",
          providerReference: "pi_test_finding5c_wrong",
          providerFee: 0,
        },
        W1,
      ),
    ).rejects.toThrow(/belongs to mandate/);
    expect(await ledgerFor(approver.mandateId)).toHaveLength(1); // untouched

    await repo.recordExecution(
      {
        authorizationId: first.authorization.id,
        mandateId: spender.mandateId,
        provider: "stripe",
        providerReference: "pi_test_finding5c",
        providerFee: 0,
      },
      W1,
    );

    // The release is of the spender's OWN hold, and the approver's row is
    // left alone. Before D-71 the spender got a release of a reservation it
    // never made -- a negative row on a mandate that never reserved.
    const spenderReleases = (await ledgerFor(spender.mandateId)).filter((r) => r.type === "RELEASE");
    expect(spenderReleases).toHaveLength(1);
    expect(monthSum(await ledgerFor(spender.mandateId), KEYS_W1.month)).toBe(
      toMinorUnits(80, "USD"),
    );
    expect((await ledgerFor(approver.mandateId)).filter((r) => r.type === "RELEASE")).toEqual([]);
  });

  it("(d) recordExecution twice is a no-op that returns the original, never a second charge", async () => {
    // Before D-71 the second call threw /not executable/. It now returns
    // the recorded outcome, so a retried capture webhook is idempotent
    // rather than an error every caller has to special-case -- and the
    // partial unique index on (mandateId, authorizationId) WHERE type =
    // 'CAPTURE' is what holds when two callers both read AUTHORIZED.
    const { approver, spender, repo, repos } = await setUpSpenderAndApprover();

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");
    await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W1,
    });

    const execute = () =>
      repo.recordExecution(
        {
          authorizationId: first.authorization.id,
          mandateId: spender.mandateId,
          provider: "stripe",
          providerReference: "pi_test_finding5d",
          providerFee: 0,
        },
        W1,
      );

    const firstRun = await execute();
    const replay = await execute();
    expect(replay.id).toBe(firstRun.id);
    expect(replay.status).toBe("EXECUTED");

    const rows = await ledgerFor(spender.mandateId);
    expect(rows.filter((r) => r.type === "CAPTURE")).toHaveLength(1);
    expect(rows.filter((r) => r.type === "RELEASE")).toHaveLength(1);
    expect(monthSum(rows, KEYS_W1.month)).toBe(toMinorUnits(80, "USD"));

    // The database, not the status check, is the control. Writing a second
    // CAPTURE row directly is refused by the D-71 partial unique index.
    await expect(
      prisma.ledgerEntry.create({
        data: {
          id: generateId(ID_PREFIX.evidence),
          organizationId: spender.organizationId,
          mandateId: spender.mandateId,
          authorizationId: first.authorization.id,
          type: "CAPTURE",
          amount: toMinorUnits(80, "USD"),
          currency: "USD",
          dayKey: KEYS_W1.day,
          weekKey: KEYS_W1.week,
          monthKey: KEYS_W1.month,
          createdAt: W1,
        },
      }),
    ).rejects.toThrow();
  });

  it("(e1) closed by D-73: a step-up whose TTL has lapsed is refused under the lock, not approved", async () => {
    const { approver, spender, repo, repos } = await setUpSpenderAndApprover();

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");
    expect(first.authorization.step_up_expires_at).not.toBeNull();

    // Approve well after the TTL, calling the service directly -- which is
    // what a real race looks like: server.ts runs expireIfNeeded first,
    // outside the lock, so before D-73 a TTL that lapsed between that
    // check and the lock was approved, and the service itself had no
    // defence. The check now lives under the same lock that takes the
    // money, reading the row's own step_up_expires_at.
    const wayLater = new Date(W1.getTime() + 86_400_000);
    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: wayLater,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.authorization.status).toBe("EXPIRED"); // was STEP_UP_APPROVED

    const fresh = await repo.getAuthorization(first.authorization.id);
    expect(fresh?.status).toBe("EXPIRED");

    // And it is not executable.
    await expect(
      repo.recordExecution(
        {
          authorizationId: first.authorization.id,
          mandateId: spender.mandateId,
          provider: "stripe",
          providerReference: "pi_test_finding5e1",
          providerFee: 0,
        },
        wayLater,
      ),
    ).rejects.toThrow(/not executable/);

    // The refusal is recorded with its own code, so a receipt says why.
    const events = await evidence.listForOrganization(spender.organizationId);
    const declined = events.filter((e) => e.type === "step_up.declined");
    expect(declined.length).toBeGreaterThan(0);
    expect(JSON.stringify(declined.at(-1)?.payload)).toContain("DENY_STEP_UP_EXPIRED");
  });

  it("(e2) closed by D-73: a revoked mandate's step-up is refused, with DENY_MANDATE_REVOKED", async () => {
    const { approver, spender, repo, repos } = await setUpSpenderAndApprover();

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");

    // The principal revokes the spending mandate -- the one unambiguous
    // "stop" signal in the whole system.
    await prisma.mandate.update({
      where: { id: spender.mandateId },
      data: { status: "REVOKED" },
    });

    // resolveMandateGate validates the APPROVER's mandate, and evaluate()
    // runs against the APPROVER's policy, so before D-73 nothing re-asked
    // whether the mandate that wanted the money was still allowed to have
    // it. It is now asked under the same lock that takes the money.
    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W1,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.authorization.status).toBe("STEP_UP_DECLINED"); // was STEP_UP_APPROVED

    const events = await evidence.listForOrganization(spender.organizationId);
    expect(JSON.stringify(events.at(-1)?.payload)).toContain("DENY_MANDATE_REVOKED");

    // And a revoked mandate's payment no longer goes through.
    await expect(
      repo.recordExecution(
        {
          authorizationId: first.authorization.id,
          mandateId: spender.mandateId,
          provider: "stripe",
          providerReference: "pi_test_finding5e2",
          providerFee: 0,
        },
        W1,
      ),
    ).rejects.toThrow(/not executable/);
  });

  it("(e3) closed by D-73: an expired policy's step-up is refused, with DENY_MANDATE_EXPIRED", async () => {
    // Same hole, a third clock: not the step-up TTL and not the mandate
    // row's status, but the policy's own expiry date. A fresh authorize()
    // always denied this; the approval path never looked.
    const approver = await seedMandate(
      policyFrom({ cumulative_limits: [{ window: "month", max_amount: toMinorUnits(100000, "USD") }] }),
    );
    const spender = await seedMandate(
      policyFrom({
        expires_at: "2026-08-31T00:00:00.000Z",
        merchants: {
          allow: [{ scheme: "domain", value: "staples.com", label: "Staples" }],
          deny: [],
          unlisted: "DENY",
          step_up_on_first_use: true,
        },
        accounting: { reserve_on_step_up: false },
        escalation: { approvers: [approver.mandateId] },
      }),
      { organizationId: approver.organizationId },
    );
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");
    expect(first.authorization.decision).toBe(Decision.STEP_UP);

    // W2 is past the spender policy's expires_at. A fresh authorize() would
    // be denied outright; the approval is not.
    const denied = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 10),
      now: W2,
      apiKey: spender.apiKey,
    });
    if (denied.kind !== "decided") throw new Error("unreachable");
    expect(denied.authorization.decision).toBe(Decision.DENY);

    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W2,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    // The step-up's own TTL (900s) lapsed long before W2 too, so the TTL
    // check fires first and this lands EXPIRED rather than STEP_UP_DECLINED.
    // Either way it is not approved, which is the property under test.
    expect(outcome.authorization.status).not.toBe("STEP_UP_APPROVED");
  });

  it("(e3b) ...and with a TTL long enough to survive, the expiry check is what refuses it", async () => {
    // (e3) alone cannot distinguish the policy-expiry check from the TTL
    // check, since both have lapsed by W2. This isolates it: a TTL that
    // outlives the boundary, so only the policy's expires_at can refuse.
    const approver = await seedMandate(
      policyFrom({ cumulative_limits: [{ window: "month", max_amount: toMinorUnits(100000, "USD") }] }),
    );
    const spender = await seedMandate(
      policyFrom({
        expires_at: "2026-08-31T00:00:00.000Z",
        step_up: { ttl_seconds: 60 * 60 * 24 * 90, above_amount: toMinorUnits(50, "USD") },
        accounting: { reserve_on_step_up: false },
        escalation: { approvers: [approver.mandateId] },
      }),
      { organizationId: approver.organizationId },
    );
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");
    expect(first.authorization.decision).toBe(Decision.STEP_UP);
    // The TTL genuinely outlives the window boundary.
    expect(new Date(first.authorization.step_up_expires_at!).getTime()).toBeGreaterThan(
      W2.getTime(),
    );

    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W2,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.authorization.status).toBe("STEP_UP_DECLINED");

    const events = await evidence.listForOrganization(spender.organizationId);
    expect(JSON.stringify(events.at(-1)?.payload)).toContain("DENY_MANDATE_EXPIRED");
  });

  it("CONTROL (D-73): an active mandate's in-TTL step-up is still approved, and must stay so", async () => {
    const { approver, spender, repo, repos } = await setUpSpenderAndApprover();

    const first = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 80),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (first.kind !== "decided") throw new Error("unreachable");

    // Well inside the 900s TTL, mandate ACTIVE, policy not expired.
    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: first.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: new Date(W1.getTime() + 60_000),
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.authorization.status).toBe("STEP_UP_APPROVED");

    const executed = await repo.recordExecution(
      {
        authorizationId: first.authorization.id,
        mandateId: spender.mandateId,
        provider: "stripe",
        providerReference: "pi_test_d73_control",
        providerFee: 0,
      },
      W1,
    );
    expect(executed.status).toBe("EXECUTED");
  });

  // =========================================================================
  // FINDING 6 -- release and settle recompute the window from now()
  // =========================================================================

  /** A spender whose step-up DOES reserve, so there is a reservation to
   * release across a boundary. $100/month cap. */
  async function setUpReservingSpender(options: { capUsd?: number; ttlSeconds?: number } = {}) {
    const approver = await seedMandate(
      policyFrom({ cumulative_limits: [{ window: "month", max_amount: toMinorUnits(100000, "USD") }] }),
    );
    const spender = await seedMandate(
      policyFrom({
        cumulative_limits: [
          { window: "month", max_amount: toMinorUnits(options.capUsd ?? 100, "USD") },
        ],
        step_up: {
          above_amount: toMinorUnits(50, "USD"),
          ttl_seconds: options.ttlSeconds ?? 900,
        },
        accounting: { reserve_on_step_up: true },
        escalation: { approvers: [approver.mandateId] },
      }),
      { organizationId: approver.organizationId },
    );
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
    return { approver, spender, repo, repos };
  }

  it("(a) THE ATTACK, closed by D-72: a reservation made in W1 and released in W2 decrements W1, the window it was taken in", async () => {
    const { spender, repo, repos } = await setUpReservingSpender();

    // Reserve $90 in W1 (a STEP_UP above the $50 threshold reserves).
    const held = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 90),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (held.kind !== "decided") throw new Error("unreachable");
    expect(held.authorization.decision).toBe(Decision.STEP_UP);

    const afterReserve = await ledgerFor(spender.mandateId);
    expect(afterReserve).toMatchObject([
      { type: "RESERVATION", amount: toMinorUnits(90, "USD"), monthKey: KEYS_W1.month },
    ]);

    // The clock crosses into W2, and the step-up is released (expired).
    await repo.resolveStepUp(spender.mandateId, held.authorization.id, "expired", W2);

    const rows = await ledgerFor(spender.mandateId);
    const release = rows.find((r) => r.type === "RELEASE")!;

    // The release carries the RESERVATION's keys. It was stamped with W2's
    // before D-72, so it cancelled a hold in a window that never had one.
    expect(release.monthKey).toBe(KEYS_W1.month);
    expect(release.dayKey).toBe(KEYS_W1.day);
    expect(release.weekKey).toBe(KEYS_W1.week);

    // Both windows are now true: the hold is gone from W1, and W2 never
    // learned about a transaction that did not happen in it.
    expect(monthSum(rows, KEYS_W1.month)).toBe(0);
    expect(monthSum(rows, KEYS_W2.month)).toBe(0);

    const snapshot = await repo.getSpendSnapshot(spender.mandateId, { timezone: "UTC" } as never, W2);
    expect(snapshot.month.amount).toBe(0); // was -$9000

    // $150 in W2 is still refused -- the cap is $100, and no phantom
    // release has inflated it.
    const overspend = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 150),
      now: W2,
      apiKey: spender.apiKey,
    });
    if (overspend.kind !== "decided") throw new Error("unreachable");
    expect(overspend.authorization.decision).toBe(Decision.DENY);
    expect(overspend.authorization.reasons.map((r) => r.code)).toContain(
      ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED,
    );
  });

  it("(b) reserve in W1, execute in W2: the charge lands in W1 -- the window it was authorized in", async () => {
    const { approver, spender, repo, repos } = await setUpReservingSpender();

    const held = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 90),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (held.kind !== "decided") throw new Error("unreachable");

    await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: held.authorization,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W1,
    });

    // Settle in the next window.
    await repo.recordExecution(
      {
        authorizationId: held.authorization.id,
        mandateId: spender.mandateId,
        provider: "stripe",
        providerReference: "pi_test_finding6b",
        providerFee: 0,
      },
      W2,
    );

    const rows = await ledgerFor(spender.mandateId);
    // All three rows carry W1: the window the authorization was decided in.
    // RELEASE and CAPTURE used to be stamped W2, the window the *later*
    // event happened to fire in.
    expect(rows.map((r) => [r.type, r.monthKey])).toEqual([
      ["RESERVATION", KEYS_W1.month],
      ["RELEASE", KEYS_W1.month],
      ["CAPTURE", KEYS_W1.month],
    ]);

    // $90 was authorized in W1 and $90 is what W1 reports. W2 is untouched
    // -- which is now consistent with (a) rather than its mirror image.
    expect(monthSum(rows, KEYS_W1.month)).toBe(toMinorUnits(90, "USD"));
    expect(monthSum(rows, KEYS_W2.month)).toBe(0);
  });

  it("(c) the invariant the fix must hold: per-window SUM equals SUM of settled, and is never negative", async () => {
    // A deliberately generous cap AND a TTL that outlives the boundary: the
    // subject here is which window each row lands in, so neither a ceiling
    // that denied the second hold nor D-73's TTL check refusing a
    // month-old step-up should stop the test before it reaches the
    // boundary. Both of those are tested on their own elsewhere in this
    // file -- (a)/(a2) for the cap, (e1) for the TTL.
    const { approver, spender, repo, repos } = await setUpReservingSpender({
      capUsd: 100_000,
      ttlSeconds: 60 * 60 * 24 * 90,
    });

    // Three reservations in W1 above the step-up threshold.
    const amounts = [60, 70, 80];
    const authorizations = [];
    for (const amount of amounts) {
      const result = await authorize(repos, {
        organizationId: spender.organizationId,
        request: request(spender.organizationId, spender.agentId, spender.principalId, amount),
        now: W1,
        apiKey: spender.apiKey,
      });
      if (result.kind !== "decided") throw new Error("unreachable");
      expect(result.authorization.decision).toBe(Decision.STEP_UP);
      authorizations.push(result.authorization);
    }

    // Mixed outcomes, all after the boundary: one expires, one declines,
    // one is approved and settles.
    await repo.resolveStepUp(spender.mandateId, authorizations[0]!.id, "expired", W2);
    await repo.resolveStepUp(spender.mandateId, authorizations[1]!.id, "declined", W2);
    await resolveStepUpAsApprover(repos, {
      organizationId: spender.organizationId,
      stepUp: authorizations[2]!,
      approverAgentId: approver.agentId,
      approverPrincipalId: approver.principalId,
      approverMandateId: approver.mandateId,
      apiKey: approver.apiKey,
      now: W2,
    });
    await repo.recordExecution(
      {
        authorizationId: authorizations[2]!.id,
        mandateId: spender.mandateId,
        provider: "stripe",
        providerReference: "pi_test_finding6c",
        providerFee: 0,
      },
      W2,
    );

    const rows = await ledgerFor(spender.mandateId);
    const settled = toMinorUnits(80, "USD"); // only the third actually moved

    const w1 = monthSum(rows, KEYS_W1.month);
    const w2 = monthSum(rows, KEYS_W2.month);

    // THE INVARIANT, all three parts. Before D-72 this read
    // w1 = $210, w2 = -$130.
    //
    //  1. No window SUM is negative (#6).
    expect(w1).toBeGreaterThanOrEqual(0);
    expect(w2).toBeGreaterThanOrEqual(0);
    //  2. Each window's SUM is what was authorized in it. All three
    //     authorizations were decided in W1, and $80 of the $210 survived
    //     to settle; the other two were released in W1 too.
    expect(w1).toBe(settled);
    expect(w2).toBe(0);
    //  3. The total equals what settled.
    expect(w1 + w2).toBe(settled);

    // Every row carries W1 -- nothing leaked across the boundary.
    expect(rows.every((r) => r.monthKey === KEYS_W1.month)).toBe(true);
  });

  it("(c2) the invariant holds for a refund landing in a later window too", async () => {
    // Not in the review, and the same defect by a different route: a CREDIT
    // stamped with `now` would push a negative row into a window where
    // nothing had been spent. Asserted on the rows directly rather than
    // through getSpendSnapshot, so `refunds_credit_budget` -- which decides
    // whether the engine *counts* a credit, not where it is filed -- is not
    // a variable here.
    const { spender, repo, repos } = await setUpReservingSpender({ capUsd: 1000 });

    const allowed = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 40),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (allowed.kind !== "decided") throw new Error("unreachable");
    expect(allowed.authorization.decision).toBe(Decision.ALLOW);

    await repo.recordExecution(
      {
        authorizationId: allowed.authorization.id,
        mandateId: spender.mandateId,
        provider: "stripe",
        providerReference: "pi_test_finding6c2",
        providerFee: 0,
      },
      W1,
    );

    // The refund arrives a month later.
    await repo.recordRefund(
      {
        authorizationId: allowed.authorization.id,
        amount: toMinorUnits(40, "USD"),
        provider: "stripe",
        providerReference: "re_test_finding6c2",
      },
      W2,
    );

    const rows = await ledgerFor(spender.mandateId);
    expect(rows.find((r) => r.type === "CREDIT")?.monthKey).toBe(KEYS_W1.month);
    expect(monthSum(rows, KEYS_W2.month)).toBe(0); // not -$4000
    expect(monthSum(rows, KEYS_W1.month)).toBeGreaterThanOrEqual(0);
  });

  it("(d) a replayed Issuing webhook reserves the mandate's budget a second time", async () => {
    // The "replay dedupe" follow-up, reached from Finding 6's direction:
    // handleIssuingAuthorizationRequest never consults findByExternalRef,
    // and Authorization.externalRef is indexed but NOT unique, so the same
    // Stripe authorization id lands twice with two RESERVATION rows.
    const NETWORK_MID = "visa_network_id_finding6d";
    const { mandateId } = await seedInstrumentMandate(
      policyFrom({
        // Room for the replay: the duplicate hold has to be what denies the
        // next real payment, not the cap denying the replay itself.
        cumulative_limits: [{ window: "month", max_amount: toMinorUnits(150, "USD") }],
        merchants: {
          allow: [{ scheme: "network_mid", value: NETWORK_MID }],
          deny: [],
          unlisted: "DENY",
        },
      }),
    );
    const instrumentRow = await prisma.instrument.findFirstOrThrow({ where: { mandateId } });
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const instruments = new PrismaInstrumentRepository(prisma);
    const adapter = new StripeIssuingAdapter();
    const payload = issuingAuthorization({
      instrumentId: instrumentRow.id,
      amount: toMinorUnits(60, "USD"),
      networkId: NETWORK_MID,
      authorizationId: "iauth_finding6d_replay",
    });

    const first = await handleIssuingAuthorizationRequest(
      { authorization: repo, evidence, instruments },
      adapter,
      payload,
      W1,
    );
    expect(first.response.approved).toBe(true);

    // Stripe redelivers the identical event. Nothing dedupes it.
    const second = await handleIssuingAuthorizationRequest(
      { authorization: repo, evidence, instruments },
      adapter,
      payload,
      W1,
    );
    expect(second.response.approved).toBe(true);

    const rows = await ledgerFor(mandateId);
    const reservations = rows.filter((r) => r.type === "RESERVATION");
    expect(reservations).toHaveLength(2);
    // $120 held for one $60 card authorization.
    expect(monthSum(rows, KEYS_W1.month)).toBe(toMinorUnits(120, "USD"));

    // Which is not merely untidy: the phantom $60 declines the cardholder's
    // next real $60 payment against their own $150 cap.
    const nextRealPayment = await handleIssuingAuthorizationRequest(
      { authorization: repo, evidence, instruments },
      adapter,
      issuingAuthorization({
        instrumentId: instrumentRow.id,
        amount: toMinorUnits(60, "USD"),
        networkId: NETWORK_MID,
        authorizationId: "iauth_finding6d_genuine",
      }),
      W1,
    );
    expect(nextRealPayment.response.approved).toBe(false);

    // Two authorization rows share one Stripe id, so externalRef no longer
    // identifies a single receipt.
    const sameRef = await prisma.authorization.findMany({
      where: { externalRef: "iauth_finding6d_replay" },
      select: { id: true },
    });
    expect(sameRef).toHaveLength(2);
  });

  it("(d2) the replayed reservation is never releasable, because the capture names only one of the two rows", async () => {
    // Why (d) is a leak and not just noise: the duplicate hold has no event
    // that will ever clear it. The mandate's budget is permanently short by
    // the replayed amount until the window rolls.
    const NETWORK_MID = "visa_network_id_finding6d2";
    const { mandateId } = await seedInstrumentMandate(
      policyFrom({
        cumulative_limits: [{ window: "month", max_amount: toMinorUnits(100, "USD") }],
        merchants: {
          allow: [{ scheme: "network_mid", value: NETWORK_MID }],
          deny: [],
          unlisted: "DENY",
        },
      }),
    );
    const instrumentRow = await prisma.instrument.findFirstOrThrow({ where: { mandateId } });
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const instruments = new PrismaInstrumentRepository(prisma);
    const adapter = new StripeIssuingAdapter();
    const payload = issuingAuthorization({
      instrumentId: instrumentRow.id,
      amount: toMinorUnits(40, "USD"),
      networkId: NETWORK_MID,
      authorizationId: "iauth_finding6d2_replay",
    });

    const a = await handleIssuingAuthorizationRequest(
      { authorization: repo, evidence, instruments },
      adapter,
      payload,
      W1,
    );
    await handleIssuingAuthorizationRequest(
      { authorization: repo, evidence, instruments },
      adapter,
      payload,
      W1,
    );

    // Settle the first row, as a real capture webhook would.
    await repo.recordExecution(
      {
        authorizationId: a.authorizationId!,
        mandateId: mandateId,
        provider: "stripe_issuing",
        providerReference: "iauth_finding6d2_replay",
        providerFee: 0,
      },
      W1,
    );

    const rows = await ledgerFor(mandateId);
    // $40 really moved. The ledger says $80 -- the orphaned hold survives.
    expect(monthSum(rows, KEYS_W1.month)).toBe(toMinorUnits(80, "USD"));
    expect(rows.filter((r) => r.type === "RESERVATION")).toHaveLength(2);
    expect(rows.filter((r) => r.type === "CAPTURE")).toHaveLength(1);
  });

  it("CONTROL: a reservation made and released inside ONE window nets to zero, and must stay so", async () => {
    const { spender, repo, repos } = await setUpReservingSpender();

    const held = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 90),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (held.kind !== "decided") throw new Error("unreachable");

    await repo.resolveStepUp(spender.mandateId, held.authorization.id, "expired", W1);

    const rows = await ledgerFor(spender.mandateId);
    expect(monthSum(rows, KEYS_W1.month)).toBe(0);
    expect(rows.every((r) => r.monthKey === KEYS_W1.month)).toBe(true);
  });

  it("CONTROL: an ALLOW reserved and settled inside ONE window charges exactly once, and must stay so", async () => {
    const { spender, repo, repos } = await setUpReservingSpender();

    const allowed = await authorize(repos, {
      organizationId: spender.organizationId,
      request: request(spender.organizationId, spender.agentId, spender.principalId, 40),
      now: W1,
      apiKey: spender.apiKey,
    });
    if (allowed.kind !== "decided") throw new Error("unreachable");
    expect(allowed.authorization.decision).toBe(Decision.ALLOW);

    await repo.recordExecution(
      {
        authorizationId: allowed.authorization.id,
        mandateId: spender.mandateId,
        provider: "stripe",
        providerReference: "pi_test_control",
        providerFee: 0,
      },
      W1,
    );

    const rows = await ledgerFor(spender.mandateId);
    expect(monthSum(rows, KEYS_W1.month)).toBe(toMinorUnits(40, "USD"));
  });
});
