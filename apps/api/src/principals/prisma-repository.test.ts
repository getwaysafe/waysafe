/**
 * Proves PrismaPrincipalRepository against real Postgres: creation, the
 * org-scoping rule on retrieval, and that the schema wiring (the
 * organizationId FK) actually works.
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ID_PREFIX, PrincipalType, generateId } from "@waysafe/core";
import { probeDatabase, requireDbOrExplainSkip } from "../test-support/db-gate.js";
import { PrismaPrincipalRepository } from "./prisma-repository.js";

const prisma = new PrismaClient();
const SUITE_NAME = "PrismaPrincipalRepository against real Postgres";
const reachable = await probeDatabase(prisma);

requireDbOrExplainSkip(SUITE_NAME, reachable);

const NOW = new Date("2026-09-07T12:00:00.000Z");
const createdOrgIds: string[] = [];

async function seedOrg(): Promise<string> {
  const organizationId = generateId(ID_PREFIX.organization);
  await prisma.organization.create({ data: { id: organizationId, name: "Test Org" } });
  createdOrgIds.push(organizationId);
  return organizationId;
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

  it("creates a principal and reads it back, persisted in Postgres", async () => {
    const repo = new PrismaPrincipalRepository(prisma);
    const organizationId = await seedOrg();

    const created = await repo.createPrincipal(
      { organizationId, displayName: "Jordan Rivera", email: "jordan@example.com" },
      NOW,
    );
    const found = await repo.getPrincipal(created.id, organizationId);

    expect(found).toEqual(created);
    expect(created.type).toBe(PrincipalType.INDIVIDUAL);
  }, 30_000);

  it("defaults email to null and type to INDIVIDUAL when omitted", async () => {
    const repo = new PrismaPrincipalRepository(prisma);
    const organizationId = await seedOrg();

    const created = await repo.createPrincipal({ organizationId, displayName: "No Email" }, NOW);

    expect(created.email).toBeNull();
    expect(created.type).toBe(PrincipalType.INDIVIDUAL);
  }, 30_000);

  it("THE ATTACK: a principal from a different organization is indistinguishable from one that doesn't exist", async () => {
    const repo = new PrismaPrincipalRepository(prisma);
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const created = await repo.createPrincipal({ organizationId: orgA, displayName: "Jordan Rivera" }, NOW);

    const found = await repo.getPrincipal(created.id, orgB);

    expect(found).toBeNull();
  }, 30_000);

  it("returns null for an id that doesn't exist", async () => {
    const repo = new PrismaPrincipalRepository(prisma);
    const organizationId = await seedOrg();

    const found = await repo.getPrincipal("prin_does_not_exist", organizationId);

    expect(found).toBeNull();
  }, 30_000);
});
