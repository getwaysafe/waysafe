import { describe, expect, it } from "vitest";
import { InMemoryAgentKeyRepository } from "./in-memory-repository.js";

const ORG = "org_test";
const OTHER_ORG = "org_other";
const AGENT = "agt_test";
const NOW = new Date("2026-08-24T12:00:00.000Z");

describe("InMemoryAgentKeyRepository", () => {
  it("verifies a freshly created key", async () => {
    const repo = new InMemoryAgentKeyRepository();
    const created = await repo.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);

    const result = await repo.verifyKey(created.fullKey, NOW);

    expect(result).toEqual({ ok: true, keyId: created.id, organizationId: ORG, agentId: AGENT });
  });

  it("THE ATTACK: rejects an unknown key", async () => {
    const repo = new InMemoryAgentKeyRepository();
    await repo.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);

    const result = await repo.verifyKey("wsf_live_00000000forgedsecretvaluethatdoesnotexist", NOW);

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("THE ATTACK: rejects a key with the right prefix but a forged secret", async () => {
    const repo = new InMemoryAgentKeyRepository();
    const created = await repo.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);
    const forged = created.prefix + "forgedTailThatIsNotTheRealSecret";

    const result = await repo.verifyKey(forged, NOW);

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("THE ATTACK: rejects a revoked key even though the secret is still correct", async () => {
    const repo = new InMemoryAgentKeyRepository();
    const created = await repo.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);

    await repo.revokeKey(created.id, ORG, NOW);
    const result = await repo.verifyKey(created.fullKey, NOW);

    expect(result).toEqual({ ok: false, reason: "revoked" });
  });

  it("THE ATTACK: revoking with the wrong organizationId does nothing -- the key stays valid", async () => {
    const repo = new InMemoryAgentKeyRepository();
    const created = await repo.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);

    const revoked = await repo.revokeKey(created.id, OTHER_ORG, NOW);
    expect(revoked).toBe(false);

    const result = await repo.verifyKey(created.fullKey, NOW);
    expect(result).toEqual({ ok: true, keyId: created.id, organizationId: ORG, agentId: AGENT });
  });

  it("keeps keys scoped to the organization and agent they were created for", async () => {
    const repo = new InMemoryAgentKeyRepository();
    const created = await repo.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);
    await repo.createKey({ organizationId: OTHER_ORG, agentId: "agt_other", name: "other bot" }, NOW);

    const result = await repo.verifyKey(created.fullKey, NOW);
    expect(result).toEqual({ ok: true, keyId: created.id, organizationId: ORG, agentId: AGENT });
  });

  it("updates lastUsedAt only on a successful verification", async () => {
    const repo = new InMemoryAgentKeyRepository();
    const created = await repo.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);

    const usedAt = new Date(NOW.getTime() + 60_000);
    await repo.verifyKey(created.fullKey, usedAt);

    const record = await repo.getById(created.id);
    expect(record?.lastUsedAt).toEqual(usedAt);
  });

  it("does not update lastUsedAt on a failed verification", async () => {
    const repo = new InMemoryAgentKeyRepository();
    const created = await repo.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);

    await repo.verifyKey("wsf_live_00000000wrongsecretentirely", new Date(NOW.getTime() + 60_000));

    const record = await repo.getById(created.id);
    expect(record?.lastUsedAt).toBeNull();
  });
});
