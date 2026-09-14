/**
 * D-46: frame 06's Safe revert card never renders viem's raw error text --
 * long, multi-line, meant for a terminal, not a viewer. This formats the
 * real on-chain result into legible lines instead.
 *
 * GS020 is a real Safe contract error code (the Safe protocol's own error
 * registry) whose fixed meaning is "signatures data too short" -- exactly
 * what a 1-of-2 signature submission produces, which is exactly what this
 * bypass case is. The fixed two-line explanation for that case is a real,
 * stable meaning of a real code, not an invented explanation; the address
 * on the third line is the real Safe's own address, shortened.
 *
 * Any other revert reason (a failure this bypass test wasn't designed to
 * produce) falls back to the real message itself, ellipsized for
 * legibility -- never a fabricated explanation standing in for one that
 * doesn't exist.
 */

import { truncateHash } from "./evidence-lookup";
import { SAFE_REVERT_BALANCE_SUFFIX, SAFE_REVERT_GS020_LINE_1, SAFE_REVERT_GS020_LINE_2 } from "./constants";

export function ellipsize(value: string, maxLength = 64): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

/** `revertReason`/`safeAddress` are the real values from
 * `POST /v1/enforcement/x402/bypass-proof` (proxied by `/api/demo/bypass`) --
 * `null` only while that call is still in flight or failed. */
export function formatSafeRevertLines(revertReason: string | null, safeAddress: string | null): string[] {
  if (!revertReason) return ["→ reverted · …"];
  if (revertReason.includes("GS020")) {
    const addr = safeAddress ? truncateHash(safeAddress, 6, 4) : "…";
    return [SAFE_REVERT_GS020_LINE_1, SAFE_REVERT_GS020_LINE_2, `Safe ${addr} · ${SAFE_REVERT_BALANCE_SUFFIX}`];
  }
  return [`→ reverted · ${ellipsize(revertReason)}`];
}
