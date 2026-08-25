/**
 * Proves PrismaAgentKeyRepository against real Postgres: creation, hashing
 * round-trip, and revocation, exactly as the in-memory tests do, plus that
 * the schema wiring (prefix uniqueness, agentId FK) actually works.
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ID_PREFIX, generateId } from "@agentpay/core";
import { probeDatabase, requireDbOrExplainSkip } from "../test-support/db-gate.js";
import { PrismaAgentKeyRepository } from "./prisma-repository.js";

const prisma = new PrismaClient();
const SUITE_NAME = "PrismaAgentKeyRepository against real Postgres";
const reachable = await probeDatabase(prisma);

requireDbOrExplainSkip(SUITE_NAME, reachable);

const NOW = new Date("2026-08-24T12:00:00.000Z");
const createdOrgIds: string[] = [];

async function seedOrgAndAgent(): Promise<{ organizationId: string; agentId: string }> {
  const organizationId = generateId(ID_PREFIX.organization);
  const agentId = generateId(ID_PREFIX.agent);
  await prisma.organization.create({ data: { id: organizationId, name: "Test Org" } });
  await prisma.agent.create({ data: { id: agentId, organizationId, name: "Test Agent" } });
  createdOrgIds.push(organizationId);
  return { organizationId, agentId };
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

  it("creates a key and verifies it against the stored hash", async () => {
    const repo = new PrismaAgentKeyRepository(prisma);
    const { organizationId, agentId } = await seedOrgAndAgent();

    const created = await repo.createKey({ organizationId, agentId, name: "bot" }, NOW);
    const result = await repo.verifyKey(created.fullKey, NOW);

    expect(result).toEqual({ ok: true, keyId: created.id, organizationId, agentId });
  }, 30_000);

  it("THE ATTACK: rejects a revoked key even though the secret is still correct", async () => {
    const repo = new PrismaAgentKeyRepository(prisma);
    const { organizationId, agentId } = await seedOrgAndAgent();

    const created = await repo.createKey({ organizationId, agentId, name: "bot" }, NOW);
    await repo.revokeKey(created.id, NOW);
    const result = await repo.verifyKey(created.fullKey, NOW);

    expect(result).toEqual({ ok: false, reason: "revoked" });
  }, 30_000);

  it("THE ATTACK: rejects an unknown key without touching any real row", async () => {
    const repo = new PrismaAgentKeyRepository(prisma);
    await seedOrgAndAgent();

    const result = await repo.verifyKey("ap_live_00000000forgedsecretvalue", NOW);

    expect(result).toEqual({ ok: false, reason: "not_found" });
  }, 30_000);
});
