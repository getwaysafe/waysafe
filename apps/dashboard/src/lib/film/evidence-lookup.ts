/**
 * D-45: finds one specific decision's own real evidence event, so Act 3's
 * receipt/chain rows can cite its actual sequence number, previous hash,
 * hash, and signature instead of a placeholder. `/api/demo/evidence`
 * returns the whole demo organization's chain (every run, not just this
 * one) -- this is the join back to the one authorization `/film` actually
 * cares about.
 */

import type { BrowserEvidenceEvent } from "../demo/browser-verify";

export function findEvidenceEventForAuthorization(
  events: BrowserEvidenceEvent[],
  authorizationId: string,
): BrowserEvidenceEvent | null {
  return events.find((e) => e.subject_type === "authorization" && e.subject_id === authorizationId) ?? null;
}

/** `sha256:1234…abcd`-style truncation, matching the storyboard's own
 * display convention for hashes and signatures -- real values, shortened
 * for legibility, never a fabricated placeholder standing in for one that
 * doesn't exist. */
export function truncateHash(hex: string, lead = 4, trail = 4): string {
  if (hex.length <= lead + trail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-trail)}`;
}

export function formatPolicyHash(hex: string): string {
  return `sha256:${truncateHash(hex)}`;
}
