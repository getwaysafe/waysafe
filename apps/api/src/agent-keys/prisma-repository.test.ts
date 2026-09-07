/**
 * Proves PrismaAgentKeyRepository against real Postgres: creation, hashing
 * round-trip, and revocation, exactly as the in-memory tests do, plus that
 * the schema wiring (prefix uniqueness, agentId FK) actually works.
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ID_PREFIX, generateId } from "@waysafe/core";
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
    await repo.revokeKey(created.id, organizationId, NOW);
    const result = await repo.verifyKey(created.fullKey, NOW);

    expect(result).toEqual({ ok: false, reason: "revoked" });
  }, 30_000);

  it("THE ATTACK: revoking with the wrong organizationId does nothing -- the key stays valid", async () => {
    const repo = new PrismaAgentKeyRepository(prisma);
    const { organizationId, agentId } = await seedOrgAndAgent();
    const created = await repo.createKey({ organizationId, agentId, name: "bot" }, NOW);

    const revoked = await repo.revokeKey(created.id, "org_some_other_tenant", NOW);
    expect(revoked).toBe(false);

    const result = await repo.verifyKey(created.fullKey, NOW);
    expect(result).toEqual({ ok: true, keyId: created.id, organizationId, agentId });
  }, 30_000);

  it("THE ATTACK: rejects an unknown key without touching any real row", async () => {
    const repo = new PrismaAgentKeyRepository(prisma);
    await seedOrgAndAgent();

    const result = await repo.verifyKey("wsf_live_00000000forgedsecretvalue", NOW);

    expect(result).toEqual({ ok: false, reason: "not_found" });
  }, 30_000);

  it("listKeysForOrganization (Week 5) returns the org's keys, prefix only, never the full key or hash", async () => {
    const repo = new PrismaAgentKeyRepository(prisma);
    const { organizationId, agentId } = await seedOrgAndAgent();
    const created = await repo.createKey({ organizationId, agentId, name: "dashboard key" }, NOW);

    const keys = await repo.listKeysForOrganization(organizationId);

    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(created.id);
    expect(keys[0]!.prefix).toBe(created.prefix);
    expect(keys[0]!.name).toBe("dashboard key");
    expect(JSON.stringify(keys)).not.toContain(created.fullKey);
  }, 30_000);

  it("THE ATTACK: listKeysForOrganization never returns another organization's keys", async () => {
    const repo = new PrismaAgentKeyRepository(prisma);
    const orgA = await seedOrgAndAgent();
    const orgB = await seedOrgAndAgent();
    await repo.createKey({ organizationId: orgA.organizationId, agentId: orgA.agentId, name: "org a key" }, NOW);
    await repo.createKey({ organizationId: orgB.organizationId, agentId: orgB.agentId, name: "org b key" }, NOW);

    const keys = await repo.listKeysForOrganization(orgA.organizationId);

    expect(keys).toHaveLength(1);
    expect(keys[0]!.name).toBe("org a key");
  }, 30_000);
});
