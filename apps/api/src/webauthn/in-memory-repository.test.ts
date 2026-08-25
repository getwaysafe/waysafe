import { describe, expect, it } from "vitest";
import { InMemoryWebauthnRepository } from "./in-memory-repository.js";

const PRINCIPAL = "prin_test";
const NOW = new Date("2026-08-24T12:00:00.000Z");

describe("InMemoryWebauthnRepository: challenges", () => {
  it("consumes a fresh challenge exactly once", async () => {
    const repo = new InMemoryWebauthnRepository();
    await repo.createChallenge(
      { principalId: PRINCIPAL, challenge: "chal-a", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 60_000) },
      NOW,
    );

    const first = await repo.consumeChallenge(PRINCIPAL, "chal-a", NOW);
    expect(first?.challenge).toBe("chal-a");

    const second = await repo.consumeChallenge(PRINCIPAL, "chal-a", NOW);
    expect(second).toBeNull();
  });

  it("THE ATTACK: a reused challenge is rejected", async () => {
    const repo = new InMemoryWebauthnRepository();
    await repo.createChallenge(
      { principalId: PRINCIPAL, challenge: "chal-b", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 60_000) },
      NOW,
    );
    await repo.consumeChallenge(PRINCIPAL, "chal-b", NOW);

    const replay = await repo.consumeChallenge(PRINCIPAL, "chal-b", new Date(NOW.getTime() + 1000));
    expect(replay).toBeNull();
  });

  it("THE ATTACK: an expired challenge is rejected even though it was never consumed", async () => {
    const repo = new InMemoryWebauthnRepository();
    await repo.createChallenge(
      { principalId: PRINCIPAL, challenge: "chal-c", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 1000) },
      NOW,
    );

    const afterExpiry = new Date(NOW.getTime() + 2000);
    const result = await repo.consumeChallenge(PRINCIPAL, "chal-c", afterExpiry);
    expect(result).toBeNull();
  });

  it("does not consume a challenge belonging to a different principal", async () => {
    const repo = new InMemoryWebauthnRepository();
    await repo.createChallenge(
      { principalId: PRINCIPAL, challenge: "chal-d", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 60_000) },
      NOW,
    );

    const result = await repo.consumeChallenge("prin_someone_else", "chal-d", NOW);
    expect(result).toBeNull();
  });

  it("serializes concurrent redemption attempts so only one succeeds", async () => {
    const repo = new InMemoryWebauthnRepository();
    await repo.createChallenge(
      { principalId: PRINCIPAL, challenge: "chal-e", purpose: "AUTHENTICATION", expiresAt: new Date(NOW.getTime() + 60_000) },
      NOW,
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.consumeChallenge(PRINCIPAL, "chal-e", NOW)),
    );
    const succeeded = results.filter((r) => r !== null);
    expect(succeeded).toHaveLength(1);
  });
});

describe("InMemoryWebauthnRepository: credentials", () => {
  it("saves and retrieves a credential by its credentialId", async () => {
    const repo = new InMemoryWebauthnRepository();
    await repo.saveCredential(
      {
        principalId: PRINCIPAL,
        credentialId: "cred-a",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
        rpId: "localhost",
      },
      NOW,
    );

    const found = await repo.getCredentialByCredentialId("cred-a");
    expect(found?.principalId).toBe(PRINCIPAL);
    expect(found?.counter).toBe(0);
  });

  it("returns null for an unknown credentialId", async () => {
    const repo = new InMemoryWebauthnRepository();
    expect(await repo.getCredentialByCredentialId("nope")).toBeNull();
  });

  it("updates the stored counter", async () => {
    const repo = new InMemoryWebauthnRepository();
    await repo.saveCredential(
      {
        principalId: PRINCIPAL,
        credentialId: "cred-b",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: [],
        rpId: "localhost",
      },
      NOW,
    );

    await repo.updateCredentialCounter("cred-b", 7, NOW);

    const found = await repo.getCredentialByCredentialId("cred-b");
    expect(found?.counter).toBe(7);
  });
});
