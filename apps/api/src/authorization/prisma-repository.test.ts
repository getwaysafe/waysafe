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
 *  - `AGENTPAY_REQUIRE_DB=1` turns "database unreachable" into a hard
 *    failure instead of a skip. Without it, a broken `DATABASE_URL` in an
 *    environment that's supposed to have one makes this entire block
 *    disappear silently and the suite stays green -- for the single test
 *    that exists specifically to catch money-losing races. Unset (the
 *    default), it skips, so `npm test` stays green with no database at all.
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Decision,
  ID_PREFIX,
  createStaticDirectory,
  generateId,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  type AgentStatus,
  type MandateStatus,
  type Policy,
} from "@agentpay/core";
import { probeDatabase, requireDbOrExplainSkip } from "../test-support/db-gate.js";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { PrismaAuthorizationRepository } from "./prisma-repository.js";
import { authorize, type AuthorizeRepos } from "./service.js";

// This file's focus is the D-4/D-15 mandate row lock against real Postgres;
// agent-key verification (D-18) is exercised on its own in
// agent-keys/prisma-repository.test.ts. Using the in-memory fakes for the
// two repositories here keeps this file's scope narrow -- authorize() only
// needs *a* valid, unrevoked key for the seeded agent, not a real one.
const agentKeys = new InMemoryAgentKeyRepository();
const evidence = new InMemoryEvidenceRepository();

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
});
