/**
 * Proves the challenge single-use guarantee against real Postgres: the
 * conditional updateMany, not just the in-memory Map version of the same
 * logic.
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ID_PREFIX, generateId } from "@waysafe/core";
import { probeDatabase, requireDbOrExplainSkip } from "../test-support/db-gate.js";
import { PrismaWebauthnRepository } from "./prisma-repository.js";

const prisma = new PrismaClient();
const SUITE_NAME = "PrismaWebauthnRepository against real Postgres";
const reachable = await probeDatabase(prisma);

requireDbOrExplainSkip(SUITE_NAME, reachable);

const NOW = new Date("2026-08-24T12:00:00.000Z");
const createdOrgIds: string[] = [];

async function seedPrincipal(): Promise<string> {
  const organizationId = generateId(ID_PREFIX.organization);
  const principalId = generateId(ID_PREFIX.principal);
  await prisma.organization.create({ data: { id: organizationId, name: "Test Org" } });
  await prisma.principal.create({
    data: { id: principalId, organizationId, displayName: "Test Principal" },
  });
  createdOrgIds.push(organizationId);
  return principalId;
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

  it("consumes a fresh challenge exactly once", async () => {
    const repo = new PrismaWebauthnRepository(prisma);
    const principalId = await seedPrincipal();
    await repo.createChallenge(
      { principalId, challenge: "chal-a", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 60_000) },
      NOW,
    );

    const first = await repo.consumeChallenge(principalId, "chal-a", NOW);
    expect(first?.challenge).toBe("chal-a");

    const second = await repo.consumeChallenge(principalId, "chal-a", NOW);
    expect(second).toBeNull();
  }, 30_000);

  it("THE ATTACK: a reused challenge is rejected", async () => {
    const repo = new PrismaWebauthnRepository(prisma);
    const principalId = await seedPrincipal();
    await repo.createChallenge(
      { principalId, challenge: "chal-b", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 60_000) },
      NOW,
    );
    await repo.consumeChallenge(principalId, "chal-b", NOW);

    const replay = await repo.consumeChallenge(principalId, "chal-b", new Date(NOW.getTime() + 1000));
    expect(replay).toBeNull();
  }, 30_000);

  it("THE ATTACK: an expired challenge is rejected even though it was never consumed", async () => {
    const repo = new PrismaWebauthnRepository(prisma);
    const principalId = await seedPrincipal();
    await repo.createChallenge(
      { principalId, challenge: "chal-c", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 1000) },
      NOW,
    );

    const result = await repo.consumeChallenge(principalId, "chal-c", new Date(NOW.getTime() + 2000));
    expect(result).toBeNull();
  }, 30_000);

  it(
    "serializes ten concurrent redemption attempts on the same challenge so only one succeeds",
    async () => {
      const repo = new PrismaWebauthnRepository(prisma);
      const principalId = await seedPrincipal();
      await repo.createChallenge(
        { principalId, challenge: "chal-d", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 60_000) },
        NOW,
      );

      const results = await Promise.all(
        Array.from({ length: 10 }, () => repo.consumeChallenge(principalId, "chal-d", NOW)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    },
    30_000,
  );

  it("saves a credential and round-trips its public key and counter", async () => {
    const repo = new PrismaWebauthnRepository(prisma);
    const principalId = await seedPrincipal();
    const publicKey = new Uint8Array([9, 8, 7, 6, 5]);

    await repo.saveCredential(
      { principalId, credentialId: "cred-x", publicKey, counter: 0, transports: ["internal"], rpId: "localhost" },
      NOW,
    );

    const found = await repo.getCredentialByCredentialId("cred-x");
    expect(found?.principalId).toBe(principalId);
    expect(Array.from(found?.publicKey ?? [])).toEqual(Array.from(publicKey));

    await repo.updateCredentialCounter("cred-x", 12, NOW);
    const updated = await repo.getCredentialByCredentialId("cred-x");
    expect(updated?.counter).toBe(12);
  }, 30_000);
});
