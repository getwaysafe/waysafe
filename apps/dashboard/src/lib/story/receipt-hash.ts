/**
 * D-43: a real SHA-256 digest of each decision's own content, computed with
 * WebCrypto in the browser -- cosmetic (a display id for the receipt
 * stream), not a hash chain. Deliberately not called an "evidence hash" or
 * "evidence chain" anywhere in the UI copy: this has no `previous_hash`
 * link and nothing signs it, so calling it that would overclaim exactly the
 * property DECISIONS.md D-16/D-17 are careful never to claim without the
 * mechanism to back it. It genuinely hashes the genuine decision, though --
 * not a fabricated string -- which is what makes it worth showing at all.
 */

import type { DecisionEvent } from "./simulation";

function canonicalRecord(event: DecisionEvent): string {
  const { attempt, decision, reasons } = event;
  return JSON.stringify({
    agent_id: attempt.agentId,
    at_ms: attempt.atMs,
    rail: attempt.rail,
    amount_minor: attempt.amountMinor,
    currency: attempt.currency,
    merchant: attempt.merchant,
    decision,
    reason_codes: reasons.map((r) => r.code),
  });
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeReceiptHash(event: DecisionEvent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRecord(event));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

/** Computes every attempt's receipt hash up front, keyed by `attempt.id`, so
 * the animation loop never awaits anything mid-playback. */
export async function computeReceiptHashes(decisions: DecisionEvent[]): Promise<Map<number, string>> {
  const entries = await Promise.all(
    decisions.map(async (event) => [event.attempt.id, await computeReceiptHash(event)] as const),
  );
  return new Map(entries);
}
