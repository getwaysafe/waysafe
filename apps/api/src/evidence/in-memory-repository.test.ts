import { describe, expect, it } from "vitest";
import {
  generateEvidenceSigningKeyPair,
  loadEvidencePublicKey,
  verifyEvidenceChain,
} from "@bles/core";
import { InMemoryEvidenceRepository } from "./in-memory-repository.js";

const ORG = "org_test";
const OTHER_ORG = "org_other";
const NOW = new Date("2026-08-24T12:00:00.000Z");

describe("InMemoryEvidenceRepository", () => {
  it("assigns increasing sequence numbers and links each event to the previous hash", async () => {
    const repo = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const first = await repo.withOrganizationLock(ORG, () =>
      repo.appendEvent({
        organizationId: ORG,
        type: "mandate.authenticated",
        subjectType: "mandate_version",
        subjectId: "mdv_1",
        payload: { via: "passkey" },
        now: NOW,
      }),
    );
    const second = await repo.withOrganizationLock(ORG, () =>
      repo.appendEvent({
        organizationId: ORG,
        type: "authorization.decided",
        subjectType: "authorization",
        subjectId: "auth_1",
        payload: { decision: "ALLOW" },
        now: NOW,
      }),
    );

    expect(first.sequence).toBe(1);
    expect(first.previous_hash).toBeNull();
    expect(second.sequence).toBe(2);
    expect(second.previous_hash).toBe(first.hash);
  });

  it("produces a chain that verifyEvidenceChain accepts", async () => {
    const repo = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    for (let i = 0; i < 5; i++) {
      await repo.withOrganizationLock(ORG, () =>
        repo.appendEvent({
          organizationId: ORG,
          type: "test.event",
          subjectType: "test",
          subjectId: `subject_${i}`,
          payload: { i },
          now: NOW,
        }),
      );
    }

    const events = await repo.listForOrganization(ORG);
    expect(events).toHaveLength(5);
    expect(verifyEvidenceChain(events)).toEqual({ ok: true });
  });

  it("signs every event, verifiably against the repository's own published public key (D-26/OQ-8)", async () => {
    const signingKey = generateEvidenceSigningKeyPair().privateKey;
    const repo = new InMemoryEvidenceRepository(signingKey);
    for (let i = 0; i < 3; i++) {
      await repo.withOrganizationLock(ORG, () =>
        repo.appendEvent({
          organizationId: ORG,
          type: "test.event",
          subjectType: "test",
          subjectId: `subject_${i}`,
          payload: { i },
          now: NOW,
        }),
      );
    }

    const events = await repo.listForOrganization(ORG);
    expect(events.every((e) => typeof e.signature === "string" && e.signature.length > 0)).toBe(true);

    const publicKey = loadEvidencePublicKey(repo.getPublicKey());
    expect(verifyEvidenceChain(events, publicKey)).toEqual({ ok: true, signed: true });
  });

  it("THE ATTACK: a chain this repository produced does not verify against a different repository's public key", async () => {
    const repo = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    await repo.withOrganizationLock(ORG, () =>
      repo.appendEvent({
        organizationId: ORG,
        type: "test.event",
        subjectType: "test",
        subjectId: "a",
        payload: {},
        now: NOW,
      }),
    );
    const events = await repo.listForOrganization(ORG);

    const otherRepo = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const wrongPublicKey = loadEvidencePublicKey(otherRepo.getPublicKey());

    const result = verifyEvidenceChain(events, wrongPublicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("keeps each organization's chain independent", async () => {
    const repo = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    await repo.withOrganizationLock(ORG, () =>
      repo.appendEvent({
        organizationId: ORG,
        type: "test.event",
        subjectType: "test",
        subjectId: "a",
        payload: {},
        now: NOW,
      }),
    );
    const otherFirst = await repo.withOrganizationLock(OTHER_ORG, () =>
      repo.appendEvent({
        organizationId: OTHER_ORG,
        type: "test.event",
        subjectType: "test",
        subjectId: "b",
        payload: {},
        now: NOW,
      }),
    );

    // OTHER_ORG's chain starts fresh at sequence 1 with no previous_hash,
    // unaffected by ORG already having an event.
    expect(otherFirst.sequence).toBe(1);
    expect(otherFirst.previous_hash).toBeNull();
  });

  it("serializes concurrent appends to the same organization with no gaps or duplicate sequences", async () => {
    const repo = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const COUNT = 25;

    await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        repo.withOrganizationLock(ORG, () =>
          repo.appendEvent({
            organizationId: ORG,
            type: "test.event",
            subjectType: "test",
            subjectId: `subject_${i}`,
            payload: { i },
            now: NOW,
          }),
        ),
      ),
    );

    const events = await repo.listForOrganization(ORG);
    expect(events).toHaveLength(COUNT);
    expect(events.map((e) => e.sequence)).toEqual(
      Array.from({ length: COUNT }, (_, i) => i + 1),
    );
    expect(verifyEvidenceChain(events)).toEqual({ ok: true });
  });
});
