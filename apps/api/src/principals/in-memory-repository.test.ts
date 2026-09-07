import { describe, expect, it } from "vitest";
import { PrincipalType } from "@waysafe/core";
import { InMemoryPrincipalRepository } from "./in-memory-repository.js";

const ORG = "org_test";
const OTHER_ORG = "org_other";
const NOW = new Date("2026-09-07T12:00:00.000Z");

describe("InMemoryPrincipalRepository", () => {
  it("creates a principal and reads it back", async () => {
    const repo = new InMemoryPrincipalRepository();
    const created = await repo.createPrincipal(
      { organizationId: ORG, displayName: "Jordan Rivera", email: "jordan@example.com" },
      NOW,
    );

    const found = await repo.getPrincipal(created.id, ORG);

    expect(found).toEqual(created);
    expect(created.type).toBe(PrincipalType.INDIVIDUAL);
    expect(created.organizationId).toBe(ORG);
  });

  it("defaults email to null and type to INDIVIDUAL when omitted", async () => {
    const repo = new InMemoryPrincipalRepository();
    const created = await repo.createPrincipal({ organizationId: ORG, displayName: "No Email" }, NOW);

    expect(created.email).toBeNull();
    expect(created.type).toBe(PrincipalType.INDIVIDUAL);
  });

  it("honors an explicit ORGANIZATION type", async () => {
    const repo = new InMemoryPrincipalRepository();
    const created = await repo.createPrincipal(
      { organizationId: ORG, displayName: "Acme Corp", type: PrincipalType.ORGANIZATION },
      NOW,
    );

    expect(created.type).toBe(PrincipalType.ORGANIZATION);
  });

  it("returns null for an id that doesn't exist", async () => {
    const repo = new InMemoryPrincipalRepository();
    const found = await repo.getPrincipal("prin_does_not_exist", ORG);
    expect(found).toBeNull();
  });

  it("THE ATTACK: a principal from a different organization is indistinguishable from one that doesn't exist", async () => {
    const repo = new InMemoryPrincipalRepository();
    const created = await repo.createPrincipal({ organizationId: ORG, displayName: "Jordan Rivera" }, NOW);

    const found = await repo.getPrincipal(created.id, OTHER_ORG);

    expect(found).toBeNull();
  });
});
