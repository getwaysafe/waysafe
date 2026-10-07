/**
 * D-87: how a window's `amount` and `count` are derived from ledger entries.
 *
 * This lives in core, and both the Prisma repository and the in-memory one
 * call it, because the previous arrangement had the same eleven lines written
 * out twice. D-85 is the lesson: when the fake and the real implementation
 * each carry their own copy of a rule, they drift, and the drift is only
 * visible in whichever one the test happens to exercise.
 *
 * `amount` is a SUM over the entries (non-negotiable #6). `count` is NOT a
 * sum of anything -- see `rollUpWindow`.
 */

import type { Accounting } from "../policy.js";
import type { WindowSpend } from "./types.js";

/** The only part of a ledger row this roll-up reads. */
export interface LedgerRollupEntry {
  /**
   * The unit a `max_count` limit counts: one *transaction*, not one
   * database row.
   *
   * For an agent-initiated authorization that is the authorization id. For a
   * rail-initiated one it is the rail's own reference (`externalRef`), because
   * D-79 gives each incremental request of a single card authorization its own
   * `Authorization` row with its own `RESERVATION`: counting rows would make
   * one incremented card payment consume two slots of a `max_count: 1` policy,
   * and today it does -- the increment is declined by the count rule even
   * though only one transaction exists.
   */
  transactionKey: string;
  type: "RESERVATION" | "RELEASE" | "CAPTURE" | "CREDIT";
  /** Signed minor units: RESERVATION/CAPTURE positive, RELEASE/CREDIT negative. */
  amount: number;
}

export interface RollUpOptions {
  /**
   * One transaction key to leave out of `count` -- never out of `amount`.
   *
   * D-79's incremental card authorization needs this. An increment is a new
   * `Authorization` row for a transaction that is already in the ledger and
   * already counted, so it must not consume a second `max_count` slot. The
   * amount side solves the same problem with a delta: the engine decides the
   * increment, and the prior hold stays in the SUM. Count cannot use a delta,
   * because `evaluate()` adds exactly 1 per action -- so the already-counted
   * transaction is dropped from the roll-up instead, and the engine's +1
   * puts it back. The transaction ends up counted once, which is the truth.
   *
   * Excluded in whichever window the prior revision actually landed in
   * (D-72), rather than by subtracting 1 from the window the increment
   * arrives in -- those are usually the same window and occasionally are not.
   */
  excludeFromCount?: string;
}

/**
 * Roll a window's entries up into the `{ amount, count }` the engine compares
 * against `max_amount` and `max_count`.
 *
 * `count` is the number of **authorized transactions** in the window:
 *
 *   - a transaction with a `CAPTURE` is counted, always. Money moved. This is
 *     the defect the second independent review found (its R6): `count` was
 *     computed as `reservations - releases`, and settlement writes a `RELEASE`
 *     of the hold plus a `CAPTURE` of the settled amount, so every completed
 *     payment silently returned its slot. Under `max_count: 1` an agent could
 *     make unlimited payments by letting each one settle first -- the amount
 *     limits still held, so this was a velocity control that only worked while
 *     nothing had finished.
 *   - a transaction with a `CAPTURE` and no prior `RESERVATION` is counted
 *     too: a force capture (D-84) is money that moved without ever being
 *     asked about, which is exactly the case `reservations - releases` could
 *     not see at all.
 *   - a transaction released **without** a capture is not counted: a
 *     reversal, an expiry, a declined or expired step-up, a failed execution
 *     (D-83). Nothing moved, so the slot is free.
 *   - a transaction still holding a `RESERVATION` is counted: a pending
 *     payment occupies a slot while it is outstanding.
 *
 * `CREDIT` entries (refunds, D-82) never change the count. A refunded payment
 * still happened; `refunds_credit_budget` decides only whether the money comes
 * back to the amount budget.
 */
export function rollUpWindow(
  entries: Iterable<LedgerRollupEntry>,
  accounting: Pick<Accounting, "refunds_credit_budget">,
  options: RollUpOptions = {},
): WindowSpend {
  let amount = 0;
  const transactions = new Map<string, { reserved: boolean; released: boolean; captured: boolean }>();

  for (const entry of entries) {
    if (entry.type === "CREDIT" && !accounting.refunds_credit_budget) continue;
    amount += entry.amount;
    if (entry.type === "CREDIT") continue;

    let seen = transactions.get(entry.transactionKey);
    if (!seen) {
      seen = { reserved: false, released: false, captured: false };
      transactions.set(entry.transactionKey, seen);
    }
    if (entry.type === "RESERVATION") seen.reserved = true;
    else if (entry.type === "RELEASE") seen.released = true;
    else seen.captured = true;
  }

  let count = 0;
  for (const [key, seen] of transactions) {
    if (key === options.excludeFromCount) continue;
    if (seen.captured) count += 1;
    else if (seen.released) continue;
    else if (seen.reserved) count += 1;
  }

  return { amount, count };
}
