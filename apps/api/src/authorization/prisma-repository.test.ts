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
 * Skips itself (not fails) when DATABASE_URL isn't set or isn't reachable,
 * so `npm test` stays green offline; CI and any environment with a real
 * Postgres instance run it for real.
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
import { PrismaAuthorizationRepository } from "./prisma-repository.js";
import { authorize } from "./service.js";

const prisma = new PrismaClient();

let reachable = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  reachable = true;
} catch {
  reachable = false;
}

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

  return { organizationId, principalId, agentId, mandateId, mandateVersionId, policyHash };
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

describe.skipIf(!reachable)("PrismaAuthorizationRepository: row lock against real Postgres", () => {
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
    const { organizationId, agentId, principalId, mandateId } = await seedMandate(policyFrom());

    const result = await authorize(repo, {
      organizationId,
      request: request(organizationId, agentId, principalId, 83),
      now: NOW,
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
      const { organizationId, agentId, principalId } = await seedMandate(policyFrom());

      // $450 and $60 each pass alone against a fresh $500 monthly cap, but
      // together they're $510 -- over the limit. Fired concurrently against
      // two separate Postgres connections, only one may win; that's only
      // true if `SELECT ... FOR UPDATE` genuinely blocks the second
      // transaction until the first commits its ledger write.
      const [a, b] = await Promise.all([
        authorize(repo, {
          organizationId,
          request: request(organizationId, agentId, principalId, 450),
          now: NOW,
        }),
        authorize(repo, {
          organizationId,
          request: request(organizationId, agentId, principalId, 60),
          now: NOW,
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
    "never lets ten concurrent step-up reservations exceed the monthly limit together",
    async () => {
      const repo = new PrismaAuthorizationRepository(prisma, DIRECTORY);
      const { organizationId, agentId, principalId } = await seedMandate(
        policyFrom({ step_up: { above_amount: toMinorUnits(90, "USD"), ttl_seconds: 900 } }),
      );

      // Ten concurrent $90 step-ups against a $500 cap: at most 5 can
      // reserve ($450) before the sixth's projected total ($540) exceeds it.
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          authorize(repo, {
            organizationId,
            request: request(organizationId, agentId, principalId, 90),
            now: NOW,
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
