import { describe, expect, it } from "vitest";
import { computeEventHash, verifyEvidenceChain } from "./evidence.js";
import type { EvidenceEvent } from "./domain.js";

const ORG = "org_test";

function makeChain(length: number): EvidenceEvent[] {
  const events: EvidenceEvent[] = [];
  let previousHash: string | null = null;

  for (let i = 0; i < length; i++) {
    const sequence = i + 1;
    const createdAt = new Date(2026, 0, 1, 0, 0, sequence);
    const payload = { note: `event ${sequence}` };
    const hash = computeEventHash({
      organization_id: ORG,
      sequence,
      type: "test.event",
      subject_type: "test",
      subject_id: `subject_${sequence}`,
      payload,
      previous_hash: previousHash,
      created_at: createdAt.toISOString(),
    });
    events.push({
      id: `ev_${sequence}`,
      organization_id: ORG,
      sequence,
      type: "test.event",
      subject_type: "test",
      subject_id: `subject_${sequence}`,
      payload,
      previous_hash: previousHash,
      hash,
      created_at: createdAt,
    });
    previousHash = hash;
  }

  return events;
}

describe("verifyEvidenceChain: untampered chains", () => {
  it("verifies an empty chain", () => {
    expect(verifyEvidenceChain([])).toEqual({ ok: true });
  });

  it("verifies a single-event chain (no previous_hash)", () => {
    expect(verifyEvidenceChain(makeChain(1))).toEqual({ ok: true });
  });

  it("verifies a multi-event chain", () => {
    expect(verifyEvidenceChain(makeChain(5))).toEqual({ ok: true });
  });
});

describe("verifyEvidenceChain: tampering is detected", () => {
  it("THE ATTACK: mutating a historical event's payload without recomputing its hash breaks the chain at that event", () => {
    const events = makeChain(4);
    // Tamper event 2 (index 1) -- change what happened, leave the stored
    // hash as it was. The simplest, laziest tamper: edit the row, don't
    // touch the hash column.
    events[1] = { ...events[1]!, payload: { note: "forged" } };

    const result = verifyEvidenceChain(events);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSequence).toBe(2);
    expect(result.reason).toBe("hash_mismatch");
  });

  it("THE ATTACK: a forged event that recomputes its OWN hash correctly still breaks the link to the next event", () => {
    // The harder case: the attacker doesn't just edit a column and leave the
    // hash stale -- they forge a fully self-consistent replacement row,
    // recomputing its hash from the forged content the same way a real
    // write would. That still can't succeed, because the *next* event in
    // the chain already committed to the hash of the *original* row it was
    // written after -- and the attacker would need to also rewrite every
    // event after the one they forged, cascading all the way to the tip.
    const events = makeChain(4);
    const original = events[1]!;
    const forgedPayload = { note: "forged, self-consistent" };
    const forgedHash = computeEventHash({
      organization_id: original.organization_id,
      sequence: original.sequence,
      type: original.type,
      subject_type: original.subject_type,
      subject_id: original.subject_id,
      payload: forgedPayload,
      previous_hash: original.previous_hash,
      created_at: original.created_at.toISOString(),
    });
    events[1] = { ...original, payload: forgedPayload, hash: forgedHash };

    const result = verifyEvidenceChain(events);
    expect(result.ok).toBe(false);
    // Event 2 itself now looks internally valid; the break surfaces at
    // event 3, whose previous_hash still commits to the ORIGINAL event 2.
    expect(result.brokenAtSequence).toBe(3);
    expect(result.reason).toBe("previous_hash_mismatch");
  });

  it("detects a deleted historical event as a sequence gap", () => {
    const events = makeChain(4);
    events.splice(1, 1); // remove event 2 entirely

    const result = verifyEvidenceChain(events);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSequence).toBe(3);
    expect(result.reason).toBe("sequence_gap");
  });

  it("detects a mutated timestamp even when payload and hash are otherwise consistent with each other", () => {
    const events = makeChain(3);
    // Same trap as the payload case: edit createdAt, forget the hash covers
    // it too.
    events[0] = { ...events[0]!, created_at: new Date(2099, 0, 1) };

    const result = verifyEvidenceChain(events);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSequence).toBe(1);
    expect(result.reason).toBe("hash_mismatch");
  });
});
