/**
 * Proves the row lock against real Postgres, not the in-memory mutex.
 *
 * `InMemoryAuthorizationRepository`'s lock is a genuine FIFO async mutex, so
 * it proves the *service's* locking logic is correct -- but a single-process
 * mutex can't prove that two separate Postgres connections actually
 * serialize on `SELECT ... FOR UPDATE`. This file re-runs the D-4
 * concurrency scenarios against `PrismaAuthorizationRepository` and a real
 * database to close that gap. See DECISIONS.md D-15.
 *
 * Two safeguards against this suite passing for the wrong reason:
 *
 *  - A negative control (`disableLockForTesting`) proves the race test would
 *    actually catch a regression -- e.g. someone deleting the `FOR UPDATE`
 *    clause -- rather than passing by accident because the two operations
 *    never happened to overlap.
 *  - `WAYSAFE_REQUIRE_DB=1` turns "database unreachable" into a hard
 *    failure instead of a skip. Without it, a broken `DATABASE_URL` in an
 *    environment that's supposed to have one makes this entire block
 *    disappear silently and the suite stays green -- for the single test
 *    that exists specifically to catch money-losing races. Unset (the
 *    default), it skips, so `npm test` stays green with no database at all.
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Decision,
  ID_PREFIX,
  createStaticDirectory,
  generateEvidenceSigningKeyPair,
  generateId,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  type AgentStatus,
  type MandateStatus,
  type Policy,
} from "@waysafe/core";
import { probeDatabase, requireDbOrExplainSkip } from "../test-support/db-gate.js";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { PrismaInstrumentRepository } from "../instruments/prisma-repository.js";
import { handleIssuingAuthorizationRequest, StripeIssuingAdapter } from "../enforcement/stripe-issuing.js";
import { PrismaAuthorizationRepository } from "./prisma-repository.js";
import { authorize, sweepExpiredStepUps, type AuthorizeRepos } from "./service.js";

// This file's focus is the D-4/D-15 mandate row lock against real Postgres;
// agent-key verification (D-18) is exercised on its own in
// agent-keys/prisma-repository.test.ts. Using the in-memory fakes for the
// two repositories here keeps this file's scope narrow -- authorize() only
// needs *a* valid, unrevoked key for the seeded agent, not a real one.
const agentKeys = new InMemoryAgentKeyRepository();
const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);

const prisma = new PrismaClient();
const SUITE_NAME = "PrismaAuthorizationRepository: row lock against real Postgres";
const reachable = await probeDatabase(prisma);

requireDbOrExplainSkip(SUITE_NAME, reachable);

const DIRECTORY = createStaticDirectory([
  { domain: "staples.com", display_name: "Staples" },
]);

function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "test",
    currency: "USD",
    merchants: {
      allow: [{ scheme: "domain", value: "staples.com", label: "Staples" }],
      deny: [],
      unlisted: "STEP_UP",
    },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-09-23T12:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

interface SeedOptions {
  status?: MandateStatus;
  authenticatedAt?: Date | null;
  agentStatus?: AgentStatus;
}

const createdOrgIds: string[] = [];

async function seedMandate(policy: Policy, options: SeedOptions = {}) {
  const organizationId = generateId(ID_PREFIX.organization);
  const principalId = generateId(ID_PREFIX.principal);
  const agentId = generateId(ID_PREFIX.agent);
  const mandateId = generateId(ID_PREFIX.mandate);
  const mandateVersionId = generateId(ID_PREFIX.mandate_version);
  const policyHash = "test-hash";
  createdOrgIds.push(organizationId);

  await prisma.organization.create({ data: { id: organizationId, name: "Test Org" } });
  await prisma.principal.create({
    data: { id: principalId, organizationId, displayName: "Test Principal" },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      organizationId,
      name: "Test Agent",
      status: options.agentStatus ?? "ACTIVE",
    },
  });
  await prisma.mandate.create({
    data: { id: mandateId, organizationId, principalId, status: options.status ?? "ACTIVE" },
  });
  await prisma.mandateVersion.create({
    data: {
      id: mandateVersionId,
      mandateId,
      version: 1,
      intentText: "test",
      policy: policy as unknown as Prisma.InputJsonValue,
      policyHash,
      compilerName: "test",
      assumptions: [],
      authenticatedAt: options.authenticatedAt === undefined ? new Date() : options.authenticatedAt,
      agents: { create: { agentId } },
    },
  });
  await prisma.mandate.update({
    where: { id: mandateId },
    data: { currentVersionId: mandateVersionId },
  });

  const key = await agentKeys.createKey(
    { organizationId, agentId, name: "test key" },
    new Date(),
  );

  return {
    organizationId,
    principalId,
    agentId,
    mandateId,
    mandateVersionId,
    policyHash,
    apiKey: key.fullKey,
  };
}

/**
 * D-35: a mandate with an Instrument row instead of a bound agent -- the
 * card *is* the mandate's spend authority (D-32 item 3), so this seeds
 * exactly what a rail-initiated authorization needs and nothing an
 * agent-actor path would (no ApiKey, no MandateAgent binding).
 */
async function seedInstrumentMandate(policy: Policy, options: SeedOptions = {}) {
  const organizationId = generateId(ID_PREFIX.organization);
  const principalId = generateId(ID_PREFIX.principal);
  const mandateId = generateId(ID_PREFIX.mandate);
  const mandateVersionId = generateId(ID_PREFIX.mandate_version);
  const policyHash = "test-hash";
  createdOrgIds.push(organizationId);

  await prisma.organization.create({ data: { id: organizationId, name: "Test Org (instrument)" } });
  await prisma.principal.create({
    data: { id: principalId, organizationId, displayName: "Test Principal" },
  });
  await prisma.mandate.create({
    data: { id: mandateId, organizationId, principalId, status: options.status ?? "ACTIVE" },
  });
  await prisma.mandateVersion.create({
    data: {
      id: mandateVersionId,
      mandateId,
      version: 1,
      intentText: "test",
      policy: policy as unknown as Prisma.InputJsonValue,
      policyHash,
      compilerName: "test",
      assumptions: [],
      authenticatedAt: options.authenticatedAt === undefined ? new Date() : options.authenticatedAt,
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

  return { organizationId, principalId, mandateId, mandateVersionId, policyHash, instrumentId: instrument.id };
}

/** A recorded issuing_authorization.request payload's `data.object`, trimmed
 * to the fields `handleIssuingAuthorizationRequest` actually reads. */
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
    card: { id: `ic_test_${params.instrumentId}`, metadata: { waysafe_instrument_id: params.instrumentId } },
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

function request(organizationId: string, agentId: string, principalId: string, amount: number) {
  return {
    agent_id: agentId,
    principal_id: principalId,
    action: {
      amount: toMinorUnits(amount, "USD"),
      currency: "USD" as const,
      merchant: { domain: "staples.com" },
      attestations: {},
    },
    context: {},
  };
}

const NOW = new Date("2026-08-24T12:00:00.000Z");

describe.skipIf(!reachable)(SUITE_NAME, () => {
  beforeAll(() => {
    if (!reachable) return;
    // eslint-disable-next-line no-console
    console.log("DATABASE_URL reachable -- running Prisma concurrency tests against it.");
  });

  afterEach(async () => {
    // Cascades to every row created off each seeded organization (mandate,
    // mandate version, agent, authorizations, ledger entries).
    while (createdOrgIds.length > 0) {
      const id = createdOrgIds.pop();
      if (id) await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("ALLOWs a real authorization end-to-end and persists it in Postgres", async () => {
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
    const { organizationId, agentId, principalId, mandateId, apiKey } =
      await seedMandate(policyFrom());

    const result = await authorize(repos, {
      organizationId,
      request: request(organizationId, agentId, principalId, 83),
      now: NOW,
      apiKey,
    });

    expect(result.kind).toBe("decided");
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.ALLOW);

    const stored = await prisma.authorization.findUniqueOrThrow({
      where: { id: result.authorization.id },
    });
    expect(stored.mandateId).toBe(mandateId);
    expect(stored.decision).toBe("ALLOW");
  }, 30_000);

  it(
    "serializes on the mandate row lock so only one of two racing authorizations survives the monthly limit",
    async () => {
      const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
      const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
      const { organizationId, agentId, principalId, apiKey } = await seedMandate(policyFrom());

      // $450 and $60 each pass alone against a fresh $500 monthly cap, but
      // together they're $510 -- over the limit. Fired concurrently against
      // two separate Postgres connections, only one may win; that's only
      // true if `SELECT ... FOR UPDATE` genuinely blocks the second
      // transaction until the first commits its ledger write.
      const [a, b] = await Promise.all([
        authorize(repos, {
          organizationId,
          request: request(organizationId, agentId, principalId, 450),
          now: NOW,
          apiKey,
        }),
        authorize(repos, {
          organizationId,
          request: request(organizationId, agentId, principalId, 60),
          now: NOW,
          apiKey,
        }),
      ]);

      if (a.kind !== "decided" || b.kind !== "decided") throw new Error("unreachable");
      const decisions = [a.authorization.decision, b.authorization.decision];
      expect(decisions.filter((d) => d === Decision.ALLOW)).toHaveLength(1);
      expect(decisions.filter((d) => d === Decision.DENY)).toHaveLength(1);
    },
    30_000,
  );

  it(
    "negative control: WITHOUT the row lock, both racing authorizations land ALLOW -- the exact bug D-4 exists to prevent",
    async () => {
      // Same scenario as the test above, same repository class, same
      // transaction wrapping -- the only difference is disableLockForTesting
      // skipping the `SELECT ... FOR UPDATE` line. If this assertion ever
      // stops holding (i.e. the lock somehow still serializes these), the
      // positive test above is not proving what it claims to: it would keep
      // passing even if someone deleted the FOR UPDATE clause from
      // prisma-repository.ts, because the two operations just wouldn't have
      // overlapped in that run.
      const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY, {
        disableLockForTesting: true,
      });
      const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
      const { organizationId, agentId, principalId, apiKey } = await seedMandate(policyFrom());

      const [a, b] = await Promise.all([
        authorize(repos, {
          organizationId,
          request: request(organizationId, agentId, principalId, 450),
          now: NOW,
          apiKey,
        }),
        authorize(repos, {
          organizationId,
          request: request(organizationId, agentId, principalId, 60),
          now: NOW,
          apiKey,
        }),
      ]);

      if (a.kind !== "decided" || b.kind !== "decided") throw new Error("unreachable");
      const decisions = [a.authorization.decision, b.authorization.decision];
      // Both read the same $0 starting balance before either commits, so
      // both pass the $500 cap independently -- $510 total gets through.
      expect(decisions.filter((d) => d === Decision.ALLOW)).toHaveLength(2);
    },
    30_000,
  );

  it(
    "never lets ten concurrent step-up reservations exceed the monthly limit together",
    async () => {
      const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
      const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
      const { organizationId, agentId, principalId, apiKey } = await seedMandate(
        policyFrom({ step_up: { above_amount: toMinorUnits(90, "USD"), ttl_seconds: 900 } }),
      );

      // Ten concurrent $90 step-ups against a $500 cap: at most 5 can
      // reserve ($450) before the sixth's projected total ($540) exceeds it.
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          authorize(repos, {
            organizationId,
            request: request(organizationId, agentId, principalId, 90),
            now: NOW,
            apiKey,
          }),
        ),
      );

      const decided = results.filter((r) => r.kind === "decided");
      const stepUps = decided.filter(
        (r) => r.kind === "decided" && r.authorization.decision === Decision.STEP_UP,
      );
      expect(stepUps.length).toBeLessThanOrEqual(5);
    },
    60_000,
  );

  it("listMandates/getMandateDetail/listAuthorizations/listAgents (Week 5) round-trip real Postgres rows", async () => {
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
    const { organizationId, agentId, principalId, mandateId, apiKey } = await seedMandate(policyFrom());

    const decided = await authorize(repos, {
      organizationId,
      request: request(organizationId, agentId, principalId, 42),
      now: NOW,
      apiKey,
    });
    if (decided.kind !== "decided") throw new Error("unreachable");

    const mandates = await repo.listMandates(organizationId, 10);
    expect(mandates).toHaveLength(1);
    expect(mandates[0]!.mandateId).toBe(mandateId);
    expect(mandates[0]!.summary).toBe("test");

    const detail = await repo.getMandateDetail(mandateId);
    expect(detail).not.toBeNull();
    expect(detail!.agentIds).toEqual([agentId]);
    expect(detail!.intentText).toBe("test");
    expect(detail!.authenticatedAt).not.toBeNull();

    expect(await repo.getMandateDetail("mandate_does_not_exist")).toBeNull();

    const authorizations = await repo.listAuthorizations(organizationId, 10);
    expect(authorizations.map((a) => a.id)).toContain(decided.authorization.id);

    const agents = await repo.listAgents(organizationId);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.agentId).toBe(agentId);
    expect(agents[0]!.name).toBe("Test Agent");
  }, 30_000);

  it("D-31/OQ-6: sweepExpiredStepUps releases a reservation nobody ever asked about again, against real Postgres", async () => {
    const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
    const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
    const { organizationId, agentId, principalId, mandateId, apiKey } = await seedMandate(
      policyFrom({ merchants: { allow: [], deny: [], unlisted: "STEP_UP" } }),
    );

    const decided = await authorize(repos, {
      organizationId,
      request: request(organizationId, agentId, principalId, 42),
      now: NOW,
      apiKey,
    });
    if (decided.kind !== "decided") throw new Error("unreachable");
    expect(decided.authorization.status).toBe("PENDING_STEP_UP");

    const later = new Date(NOW.getTime() + 1000 * 60 * 20);
    const count = await sweepExpiredStepUps(repo, later);

    expect(count).toBeGreaterThanOrEqual(1);
    const stored = await repo.getAuthorization(decided.authorization.id);
    expect(stored?.status).toBe("EXPIRED");

    const ledgerNet = await prisma.ledgerEntry.aggregate({
      where: { mandateId },
      _sum: { amount: true },
    });
    expect(ledgerNet._sum.amount).toBe(0);
  }, 30_000);

  it(
    "D-35: serializes two racing CARD (instrument-actor) authorizations on the same mandate row lock, " +
      "same as it already does for agent-actor ones",
    async () => {
      const NETWORK_MID = "visa_network_id_d35_race";
      const { organizationId, instrumentId } = await seedInstrumentMandate(
        policyFrom({
          merchants: { allow: [{ scheme: "network_mid", value: NETWORK_MID }], deny: [], unlisted: "STEP_UP" },
        }),
      );
      const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
      const instruments = new PrismaInstrumentRepository(prisma);
      const adapter = new StripeIssuingAdapter();

      // $450 and $60 each pass alone against a fresh $500 monthly cap, but
      // together they're $510 -- over the limit. Same scenario the
      // agent-actor test above proves, now for the actor D-35 added.
      const [a, b] = await Promise.all([
        handleIssuingAuthorizationRequest(
          { authorization: repo, evidence, instruments },
          adapter,
          issuingAuthorization({
            instrumentId,
            amount: toMinorUnits(450, "USD"),
            networkId: NETWORK_MID,
            authorizationId: "iauth_d35_race_a",
          }),
          NOW,
        ),
        handleIssuingAuthorizationRequest(
          { authorization: repo, evidence, instruments },
          adapter,
          issuingAuthorization({
            instrumentId,
            amount: toMinorUnits(60, "USD"),
            networkId: NETWORK_MID,
            authorizationId: "iauth_d35_race_b",
          }),
          NOW,
        ),
      ]);

      const approvals = [a, b].filter((r) => r.response.approved);
      expect(approvals).toHaveLength(1);

      const authorizations = await repo.listAuthorizations(organizationId, 10);
      expect(authorizations.every((auth) => auth.actor_kind === "instrument")).toBe(true);
      expect(authorizations.every((auth) => auth.agent_id === null)).toBe(true);
    },
    30_000,
  );

  it(
    "D-35 negative control: WITHOUT the row lock, both racing card authorizations land ALLOW -- " +
      "the same bug D-4 exists to prevent, now proven for the instrument actor too",
    async () => {
      const NETWORK_MID = "visa_network_id_d35_negative";
      const { instrumentId } = await seedInstrumentMandate(
        policyFrom({
          merchants: { allow: [{ scheme: "network_mid", value: NETWORK_MID }], deny: [], unlisted: "STEP_UP" },
        }),
      );
      const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY, { disableLockForTesting: true });
      const instruments = new PrismaInstrumentRepository(prisma);
      const adapter = new StripeIssuingAdapter();

      const [a, b] = await Promise.all([
        handleIssuingAuthorizationRequest(
          { authorization: repo, evidence, instruments },
          adapter,
          issuingAuthorization({
            instrumentId,
            amount: toMinorUnits(450, "USD"),
            networkId: NETWORK_MID,
            authorizationId: "iauth_d35_neg_a",
          }),
          NOW,
        ),
        handleIssuingAuthorizationRequest(
          { authorization: repo, evidence, instruments },
          adapter,
          issuingAuthorization({
            instrumentId,
            amount: toMinorUnits(60, "USD"),
            networkId: NETWORK_MID,
            authorizationId: "iauth_d35_neg_b",
          }),
          NOW,
        ),
      ]);

      // Both read the same $0 starting balance before either commits, so
      // both pass the $500 cap independently -- $510 total gets through.
      expect([a, b].filter((r) => r.response.approved)).toHaveLength(2);
    },
    30_000,
  );

  it("THE ATTACK: an authorization can never be saved with both or neither actor set -- the DB rejects it", async () => {
    // Both a real agent and a real instrument exist for this mandate, so
    // every case below fails ONLY on the CHECK constraint -- never on a
    // dangling foreign key, which would prove nothing about the constraint
    // this test exists to check.
    const { organizationId, principalId, mandateId, mandateVersionId, policyHash, agentId } =
      await seedMandate(policyFrom());
    const instrument = await prisma.instrument.create({
      data: {
        id: generateId(ID_PREFIX.instrument),
        organizationId,
        mandateId,
        rail: "stripe_issuing",
        externalRef: "ic_test_actor_invariant",
      },
    });

    const base = {
      organizationId,
      principalId,
      mandateId,
      mandateVersionId,
      policyHash,
      decision: "ALLOW" as const,
      status: "AUTHORIZED" as const,
      reasonCodes: ["ALLOW_WITHIN_MANDATE"],
      reasons: [{ code: "ALLOW_WITHIN_MANDATE", message: "ok" }] as unknown as Prisma.InputJsonValue,
      action: { amount: 100, currency: "USD", merchant: {}, attestations: {} } as unknown as Prisma.InputJsonValue,
      amount: 100,
      currency: "USD",
      merchant: { trust: "VERIFIED", refs: [], resolution_source: "directory" } as unknown as Prisma.InputJsonValue,
      createdAt: NOW,
      decidedAt: NOW,
    };

    async function expectConstraintViolation(data: Prisma.AuthorizationUncheckedCreateInput) {
      const error = await prisma.authorization.create({ data }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("authorizations_actor_kind_check");
    }

    // Neither agentId nor instrumentId set, actorKind claims "agent".
    await expectConstraintViolation({
      id: generateId(ID_PREFIX.authorization),
      actorKind: "agent",
      agentId: null,
      instrumentId: null,
      ...base,
    });

    // Both set at once, actorKind claims "instrument".
    await expectConstraintViolation({
      id: generateId(ID_PREFIX.authorization),
      actorKind: "instrument",
      agentId,
      instrumentId: instrument.id,
      ...base,
    });

    // actorKind says "agent" but only instrumentId is set.
    await expectConstraintViolation({
      id: generateId(ID_PREFIX.authorization),
      actorKind: "agent",
      agentId: null,
      instrumentId: instrument.id,
      ...base,
    });
  });
});
