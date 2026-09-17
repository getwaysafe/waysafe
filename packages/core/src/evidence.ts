/**
 * The evidence chain: append-only, hash-chained, and (as of D-26) signed,
 * per organization.
 *
 * This module is pure -- no database, no clock, no I/O -- exactly like
 * `evaluate()`. Everything here operates on `EvidenceEvent` rows already
 * fetched by a caller (the repository layer in apps/api). `computeEventHash`
 * derives an event's hash from its own content plus the previous event's
 * hash, so any row's hash depends on everything before it. `verifyEvidenceChain`
 * recomputes that chain from a list of stored events and reports exactly
 * where it stops matching.
 *
 * What hash-chaining alone proves and what it doesn't (see DECISIONS.md
 * D-17, resolved by D-26/OQ-8): a mutated historical row breaks the hash
 * chain, so it's *tamper-evident* to anyone who can recompute it -- a bug,
 * an outside attacker, or an operator checking their own data. What it
 * cannot do alone is prove anything to someone who does not have to trust
 * the database the rows came from: whoever controls that database can
 * mutate a row *and* rewrite every hash after it, all the way to the tip,
 * and the chain looks internally consistent throughout (see
 * `evidence.test.ts`'s "full chain rewrite" case). Passing a `publicKey` to
 * `verifyEvidenceChain` closes that gap -- each event's `signature` is
 * checked against it too, and reproducing a valid one for a forged hash
 * needs the private key (`evidence-signing.ts`), not just write access to
 * Postgres. With a `publicKey` supplied, "tamper-evident" becomes accurate
 * to call "verifiable" -- by a third party, not just an operator trusting
 * their own recomputation. Without one (the parameter is optional, for
 * internal consistency checks that don't need the stronger claim), this
 * function still only proves what hash-chaining alone can.
 *
 * `keyDirectory` (D-52) is the additive rotation path: a map of
 * `key_id -> KeyObject` (build one from the wire format with
 * `loadEvidenceKeyDirectory`). Omitting it entirely reproduces the exact
 * pre-D-52 behavior -- every event checked against `publicKey` alone,
 * `key_id` never even read, so an existing caller that only ever passed
 * `publicKey` needs no change even now that events carry a `key_id`.
 * Passing `keyDirectory` turns that reading on: an event carrying a
 * `key_id` is then checked against that directory entry instead of
 * `publicKey` -- so a key that has since been rotated out can still verify
 * the events it actually signed, as long as its entry stays in the
 * directory -- and a `key_id` that isn't in `keyDirectory` fails closed
 * (`signature_invalid`) rather than silently falling back to `publicKey`: a
 * key_id pointing nowhere is exactly as suspicious as a bad signature. An
 * event with no `key_id` at all (every event written before D-52) still
 * falls back to `publicKey` even with a directory supplied -- this is what
 * "existing entries without key_id must still verify" means in practice.
 */

import { createHash, type KeyObject } from "node:crypto";
import type { EvidenceEvent } from "./domain.js";
import { verifyEventSignature } from "./evidence-signing.js";

/** The fields that determine an event's hash. Excludes `id` (an internal
 * identifier, not chain content) and `hash` itself. */
export interface EvidenceEventContent {
  organization_id: string;
  sequence: number;
  type: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  /** null only for the first event in an organization's chain. */
  previous_hash: string | null;
  /** ISO-8601. Included so mutating a stored timestamp is also detected. */
  created_at: string;
}

/** SHA-256 over the event's content plus the previous event's hash. */
export function computeEventHash(content: EvidenceEventContent): string {
  const canonical = JSON.stringify(sortKeysDeep(content));
  return createHash("sha256").update(canonical).digest("hex");
}

export interface ChainVerificationResult {
  ok: boolean;
  /** The sequence number of the first event that fails to verify. */
  brokenAtSequence?: number;
  reason?: "hash_mismatch" | "previous_hash_mismatch" | "sequence_gap" | "signature_invalid";
  /** True only when a `publicKey` was supplied and every event's signature
   * checked out -- the "verifiable by a third party" claim, not just
   * "internally consistent." Absent (not `false`) when no `publicKey` was
   * passed, so a caller can't mistake "we didn't check" for "we checked and
   * it's unsigned." */
  signed?: boolean;
}

/**
 * Verifies internal consistency of `events`: each event's stored hash must
 * match its recomputed content, each event's `previous_hash` must match the
 * prior event's `hash`, and sequence numbers must increase by exactly 1.
 * When `publicKey` is supplied, also verifies each event's `signature`
 * against it (D-26/OQ-8) -- this is what turns "tamper-evident" into
 * "verifiable by a third party," see this file's module doc comment.
 *
 * `events` must already be in ascending sequence order -- this function does
 * not sort them, so a caller passing an unordered list gets a meaningless
 * result. Verifies whatever range is passed in; the first event's
 * `previous_hash`/`sequence` is taken as the chain's starting point, so this
 * works equally on a full chain or a contiguous sub-range fetched for
 * display. An event physically deleted from the middle of a range shows up
 * as a `sequence_gap` at the event immediately after the gap.
 */
export function verifyEvidenceChain(
  events: EvidenceEvent[],
  publicKey?: KeyObject,
  keyDirectory?: ReadonlyMap<string, KeyObject>,
): ChainVerificationResult {
  const [head] = events;
  let previousHash: string | null = head ? head.previous_hash : null;
  let expectedSequence = head ? head.sequence : 0;
  const checkingSignatures = Boolean(publicKey || keyDirectory);

  for (const event of events) {
    if (event.sequence !== expectedSequence) {
      return { ok: false, brokenAtSequence: event.sequence, reason: "sequence_gap" };
    }
    if (event.previous_hash !== previousHash) {
      return { ok: false, brokenAtSequence: event.sequence, reason: "previous_hash_mismatch" };
    }

    const expectedHash = computeEventHash({
      organization_id: event.organization_id,
      sequence: event.sequence,
      type: event.type,
      subject_type: event.subject_type,
      subject_id: event.subject_id,
      payload: event.payload,
      previous_hash: event.previous_hash,
      created_at: event.created_at.toISOString(),
    });
    if (expectedHash !== event.hash) {
      return { ok: false, brokenAtSequence: event.sequence, reason: "hash_mismatch" };
    }

    if (checkingSignatures) {
      // No keyDirectory at all: ignore key_id entirely and check every
      // event against publicKey -- the exact pre-D-52 behavior, still
      // correct even for an event that now carries a key_id, since
      // publicKey is genuinely the key it was signed with. A keyDirectory
      // IS supplied: an event with a key_id must resolve through it (fail
      // closed if that id isn't in the directory, never silently fall back
      // to publicKey); an event with no key_id still falls back to
      // publicKey, same as always.
      const signingKey = keyDirectory
        ? event.key_id
          ? keyDirectory.get(event.key_id)
          : publicKey
        : publicKey;
      if (!signingKey || !verifyEventSignature(signingKey, event.hash, event.signature)) {
        return { ok: false, brokenAtSequence: event.sequence, reason: "signature_invalid" };
      }
    }

    previousHash = event.hash;
    expectedSequence += 1;
  }

  return checkingSignatures ? { ok: true, signed: true } : { ok: true };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}
