/**
 * Proves the per-organization evidence lock against real Postgres.
 *
 * Same rationale as `authorization/prisma-repository.test.ts` (D-15),
 * applied to the D-16 organization lock instead of the D-4 mandate lock.
 * Skips itself when DATABASE_URL isn't reachable, unless BLES_REQUIRE_DB=1
 * (see test-support/db-gate.ts).
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ID_PREFIX,
  generateEvidenceSigningKeyPair,
  generateId,
  loadEvidencePublicKey,
  verifyEvidenceChain,
  type EvidenceEvent,
} from "@bles/core";
import { probeDatabase, requireDbOrExplainSkip } from "../test-support/db-gate.js";
import { PrismaEvidenceRepository } from "./prisma-repository.js";

const prisma = new PrismaClient();
const SUITE_NAME = "PrismaEvidenceRepository: organization lock against real Postgres";
const reachable = await probeDatabase(prisma);
const SIGNING_KEY = generateEvidenceSigningKeyPair().privateKey;

requireDbOrExplainSkip(SUITE_NAME, reachable);

const NOW = new Date("2026-08-24T12:00:00.000Z");
const createdOrgIds: string[] = [];

async function seedOrg(): Promise<string> {
  const id = generateId(ID_PREFIX.organization);
  await prisma.organization.create({ data: { id, name: "Test Org" } });
  createdOrgIds.push(id);
  return id;
}

describe.skipIf(!reachable)(SUITE_NAME, () => {
  afterEach(async () => {
    while (createdOrgIds.length > 0) {
      const id = createdOrgIds.pop();
      if (id) await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("appends events with increasing sequence and hash linkage, persisted in Postgres", async () => {
    const repo = new PrismaEvidenceRepository(prisma, SIGNING_KEY);
    const organizationId = await seedOrg();

    const first = await repo.withOrganizationLock(organizationId, () =>
      repo.appendEvent({
        organizationId,
        type: "mandate.authenticated",
        subjectType: "mandate_version",
        subjectId: "mdv_1",
        payload: { via: "passkey" },
        now: NOW,
      }),
    );
    const second = await repo.withOrganizationLock(organizationId, () =>
      repo.appendEvent({
        organizationId,
        type: "authorization.decided",
        subjectType: "authorization",
        subjectId: "auth_1",
        payload: { decision: "ALLOW" },
        now: NOW,
      }),
    );

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previous_hash).toBe(first.hash);

    const events = await repo.listForOrganization(organizationId);
    expect(verifyEvidenceChain(events)).toEqual({ ok: true });

    const publicKey = loadEvidencePublicKey(repo.getPublicKey());
    expect(verifyEvidenceChain(events, publicKey)).toEqual({ ok: true, signed: true });
  }, 30_000);

  it(
    "serializes ten concurrent appends into a single valid chain, no gaps or duplicate sequences",
    async () => {
      const repo = new PrismaEvidenceRepository(prisma, SIGNING_KEY);
      const organizationId = await seedOrg();
      const COUNT = 10;

      await Promise.all(
        Array.from({ length: COUNT }, (_, i) =>
          repo.withOrganizationLock(organizationId, () =>
            repo.appendEvent({
              organizationId,
              type: "test.event",
              subjectType: "test",
              subjectId: `subject_${i}`,
              payload: { i },
              now: NOW,
            }),
          ),
        ),
      );

      const events = await repo.listForOrganization(organizationId);
      expect(events).toHaveLength(COUNT);
      expect(events.map((e: EvidenceEvent) => e.sequence)).toEqual(
        Array.from({ length: COUNT }, (_, i) => i + 1),
      );
      expect(verifyEvidenceChain(events)).toEqual({ ok: true });
    },
    30_000,
  );

  it(
    "negative control: WITHOUT the lock, two concurrent appends contend on the sequence and one throws instead of serializing cleanly",
    async () => {
      // Unlike the D-4/D-15 ledger race (where an unlocked race silently
      // lets two things through that shouldn't both fit), the evidence
      // table's `@@unique([organizationId, sequence])` constraint is a
      // second line of defense: it can't produce two rows claiming the same
      // sequence number. What it *can't* prevent is the ungraceful failure
      // mode -- without the lock serializing them, one of two legitimate,
      // unrelated concurrent appends throws a unique-constraint error
      // instead of being cleanly assigned the next sequence number. That's
      // exactly what the lock exists to turn into "just works."
      const repo = new PrismaEvidenceRepository(prisma, SIGNING_KEY, { disableLockForTesting: true });
      const organizationId = await seedOrg();

      const results = await Promise.allSettled([
        repo.withOrganizationLock(organizationId, () =>
          repo.appendEvent({
            organizationId,
            type: "test.event",
            subjectType: "test",
            subjectId: "a",
            payload: {},
            now: NOW,
          }),
        ),
        repo.withOrganizationLock(organizationId, () =>
          repo.appendEvent({
            organizationId,
            type: "test.event",
            subjectType: "test",
            subjectId: "b",
            payload: {},
            now: NOW,
          }),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    },
    30_000,
  );
});
