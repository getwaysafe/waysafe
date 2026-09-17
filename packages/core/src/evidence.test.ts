import { describe, expect, it } from "vitest";
import { computeEventHash, verifyEvidenceChain } from "./evidence.js";
import { computeKeyId, generateEvidenceSigningKeyPair, signEventHash } from "./evidence-signing.js";
import type { EvidenceEvent } from "./domain.js";

const ORG = "org_test";
const KEY_PAIR = generateEvidenceSigningKeyPair();

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
      signature: signEventHash(KEY_PAIR.privateKey, hash),
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

describe("verifyEvidenceChain: signature verification (D-26/OQ-8)", () => {
  it("verifies (and reports signed:true) when every signature checks out against the public key", () => {
    const events = makeChain(4);
    expect(verifyEvidenceChain(events, KEY_PAIR.publicKey)).toEqual({ ok: true, signed: true });
  });

  it("omitting publicKey never reports signed:true, even for a genuinely signed chain", () => {
    const events = makeChain(4);
    const result = verifyEvidenceChain(events);
    expect(result.ok).toBe(true);
    expect(result.signed).toBeUndefined();
  });

  it("THE ATTACK: a signature that doesn't verify under the given public key fails, even though hashes and links are all internally consistent", () => {
    const events = makeChain(3);
    events[1] = { ...events[1]!, signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" };

    const result = verifyEvidenceChain(events, KEY_PAIR.publicKey);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSequence).toBe(2);
    expect(result.reason).toBe("signature_invalid");
  });

  it("THE ATTACK: a chain signed under a different key entirely fails verification against this public key", () => {
    const events = makeChain(3);
    const otherKeyPair = generateEvidenceSigningKeyPair();
    const result = verifyEvidenceChain(events, otherKeyPair.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it(
    "THE ATTACK, the whole point of D-26: a full chain rewrite -- forging one event and cascading " +
      "self-consistent hash/previous_hash edits all the way to the tip -- passes hash-only verification " +
      "(the exact gap D-17 named) but fails signature verification, because the attacker never had the " +
      "private key to re-sign what they forged",
    () => {
      const events = makeChain(5);
      // Forge event 2's payload, then patiently rewrite every event after it
      // so the hash chain stays perfectly self-consistent end to end -- a
      // database-only attacker's best-case attempt, not a lazy one.
      const forged = events.map((e) => ({ ...e }));
      forged[1]!.payload = { note: "forged, and everything downstream rewritten to match" };
      let previousHash = forged[0]!.hash;
      for (let i = 1; i < forged.length; i++) {
        const event = forged[i]!;
        event.previous_hash = previousHash;
        event.hash = computeEventHash({
          organization_id: event.organization_id,
          sequence: event.sequence,
          type: event.type,
          subject_type: event.subject_type,
          subject_id: event.subject_id,
          payload: event.payload,
          previous_hash: event.previous_hash,
          created_at: event.created_at.toISOString(),
        });
        // Deliberately NOT re-signing -- the attacker controls the database,
        // not the private key that lives outside it.
        previousHash = event.hash;
      }

      // The gap D-17 described: recomputing hashes alone, this looks like a
      // perfectly intact chain.
      expect(verifyEvidenceChain(forged)).toEqual({ ok: true });

      // Checked against the public key, it isn't: every event from the
      // forgery onward carries a signature over a hash that no longer
      // matches what's signed.
      const signedResult = verifyEvidenceChain(forged, KEY_PAIR.publicKey);
      expect(signedResult.ok).toBe(false);
      expect(signedResult.brokenAtSequence).toBe(2);
      expect(signedResult.reason).toBe("signature_invalid");
    },
  );
});

describe("verifyEvidenceChain: key directory (D-52)", () => {
  it("an event carrying a key_id is checked against the matching key directory entry, not publicKey", () => {
    const events = makeChain(2);
    const rotated = generateEvidenceSigningKeyPair();
    const rotatedId = computeKeyId(rotated.publicKey);
    events[1] = {
      ...events[1]!,
      signature: signEventHash(rotated.privateKey, events[1]!.hash),
      key_id: rotatedId,
    };
    const directory = new Map([[rotatedId, rotated.publicKey]]);

    // publicKey here is deliberately the WRONG key for event 2 -- if this
    // passed, it would mean key_id routing was never actually consulted.
    const result = verifyEvidenceChain(events, KEY_PAIR.publicKey, directory);
    expect(result).toEqual({ ok: true, signed: true });
  });

  it("an event with no key_id still falls back to publicKey even when a keyDirectory is supplied", () => {
    const events = makeChain(2); // signed under KEY_PAIR, no key_id -- pre-D-52 shape
    const directory = new Map([["unrelated", generateEvidenceSigningKeyPair().publicKey]]);
    const result = verifyEvidenceChain(events, KEY_PAIR.publicKey, directory);
    expect(result).toEqual({ ok: true, signed: true });
  });

  it("THE ATTACK: a key_id that isn't in the directory fails closed, never silently falls back to publicKey", () => {
    const events = makeChain(2);
    // Event 2 is still genuinely signed under KEY_PAIR -- publicKey would
    // accept it -- but it's mislabeled with a key_id the directory doesn't
    // recognize. That must fail, not fall back.
    events[1] = { ...events[1]!, key_id: "does_not_exist" };
    const result = verifyEvidenceChain(events, KEY_PAIR.publicKey, new Map());
    expect(result.ok).toBe(false);
    expect(result.brokenAtSequence).toBe(2);
    expect(result.reason).toBe("signature_invalid");
  });

  it("a chain mixing legacy (no key_id) and post-rotation (key_id) events verifies end to end -- the actual rotation scenario D-52 exists for", () => {
    const events = makeChain(4); // all signed under KEY_PAIR, no key_id yet
    const rotated = generateEvidenceSigningKeyPair();
    const rotatedId = computeKeyId(rotated.publicKey);
    // Re-sign only the back half under the new key and tag it -- hashes and
    // previous_hash links are untouched, since key_id isn't part of the hash.
    for (let i = 2; i < events.length; i++) {
      events[i] = {
        ...events[i]!,
        signature: signEventHash(rotated.privateKey, events[i]!.hash),
        key_id: rotatedId,
      };
    }
    const directory = new Map([[rotatedId, rotated.publicKey]]);
    const result = verifyEvidenceChain(events, KEY_PAIR.publicKey, directory);
    expect(result).toEqual({ ok: true, signed: true });
  });
});
