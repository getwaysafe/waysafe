/**
 * The evidence chain: append-only, hash-chained per organization.
 *
 * This module is pure -- no database, no clock, no I/O -- exactly like
 * `evaluate()`. Everything here operates on `EvidenceEvent` rows already
 * fetched by a caller (the repository layer in apps/api). `computeEventHash`
 * derives an event's hash from its own content plus the previous event's
 * hash, so any row's hash depends on everything before it. `verifyEvidenceChain`
 * recomputes that chain from a list of stored events and reports exactly
 * where it stops matching.
 *
 * What this proves and what it doesn't (see DECISIONS.md D-17, OQ-8): a
 * mutated historical row breaks the hash chain, so this is *tamper-evident*
 * to anyone who can recompute it -- a bug, an outside attacker, or an
 * operator checking their own data. It is not *tamper-proof* or
 * independently *verifiable*: whoever controls the database that stores
 * these rows can mutate one and recompute every hash after it, and the
 * chain will look intact end to end. Proving integrity to someone who does
 * not have to trust that database needs a signature, which this module
 * deliberately does not add (OQ-8). Never describe what this module does as
 * "tamper-proof" or "verifiable" outside that narrow, trusted-recomputer
 * sense -- "tamper-evident" is the accurate word.
 */

import { createHash } from "node:crypto";
import type { EvidenceEvent } from "./domain.js";

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
  reason?: "hash_mismatch" | "previous_hash_mismatch" | "sequence_gap";
}

/**
 * Verifies internal consistency of `events`: each event's stored hash must
 * match its recomputed content, each event's `previous_hash` must match the
 * prior event's `hash`, and sequence numbers must increase by exactly 1.
 *
 * `events` must already be in ascending sequence order -- this function does
 * not sort them, so a caller passing an unordered list gets a meaningless
 * result. Verifies whatever range is passed in; the first event's
 * `previous_hash`/`sequence` is taken as the chain's starting point, so this
 * works equally on a full chain or a contiguous sub-range fetched for
 * display. An event physically deleted from the middle of a range shows up
 * as a `sequence_gap` at the event immediately after the gap.
 */
export function verifyEvidenceChain(events: EvidenceEvent[]): ChainVerificationResult {
  const [head] = events;
  let previousHash: string | null = head ? head.previous_hash : null;
  let expectedSequence = head ? head.sequence : 0;

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

    previousHash = event.hash;
    expectedSequence += 1;
  }

  return { ok: true };
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
