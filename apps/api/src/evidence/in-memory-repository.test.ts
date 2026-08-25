import { describe, expect, it } from "vitest";
import { verifyEvidenceChain } from "@agentpay/core";
import { InMemoryEvidenceRepository } from "./in-memory-repository.js";

const ORG = "org_test";
const OTHER_ORG = "org_other";
const NOW = new Date("2026-08-24T12:00:00.000Z");

describe("InMemoryEvidenceRepository", () => {
  it("assigns increasing sequence numbers and links each event to the previous hash", async () => {
    const repo = new InMemoryEvidenceRepository();
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
    const repo = new InMemoryEvidenceRepository();
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

  it("keeps each organization's chain independent", async () => {
    const repo = new InMemoryEvidenceRepository();
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
    const repo = new InMemoryEvidenceRepository();
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
