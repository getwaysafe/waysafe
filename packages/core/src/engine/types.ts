/**
 * The engine's inputs and outputs.
 *
 * `evaluate()` (see evaluate.ts) is pure: everything it needs is passed in as
 * plain data. It never reads a clock, a database, or a model. That is what
 * makes an authorization decision reproducible from a receipt alone — replay
 * the same policy, merchant resolution, spend snapshot, and instant, and the
 * decision is bit-for-bit the same.
 *
 * Deliberately absent: mandate lifecycle (expired/revoked/superseded/
 * unauthenticated) and actor state (agent suspended/not bound, principal
 * mismatch). Those depend on rows the engine has no business reading, so they
 * are resolved by the caller — the authorization service in apps/api — before
 * `evaluate()` is ever invoked. `evaluate()` only ever runs against a policy
 * already known to be the active, authenticated one. The one mandate-lifecycle
 * exception is expiry: `expires_at` is baked into the policy itself, so
 * checking it needs no row lookup, only the clock already being passed in.
 */

import type { CumulativeLimit, Policy } from "../policy.js";
import type { ProposedAction } from "../domain.js";
import type { ResolvedMerchant } from "../merchant.js";
import type { Reason } from "../reason-codes.js";
import type { Decision } from "../reason-codes.js";

/** "day" | "week" | "month" | "mandate" -- the window a cumulative limit can name. */
export type LimitWindowValue = CumulativeLimit["window"];

/** Spend already committed to a window, before the proposed action. */
export interface WindowSpend {
  /** Minor units: SUM of ledger entries in this window under the policy's accounting rules. */
  amount: number;
  /** Count of authorizations counted in this window under the same rules. */
  count: number;
}

/**
 * Everything the engine needs to know about spend history, precomputed by the
 * caller from the ledger (see D-4: a SUM over ledger_entries, never a counter
 * column). One entry per window a policy can reference, plus the mandate's
 * lifetime total for the `mandate` window.
 */
export interface SpendSnapshot {
  day: WindowSpend;
  week: WindowSpend;
  month: WindowSpend;
  mandate: WindowSpend;
  /**
   * Merchant identity refs (see merchantRefKey) this mandate has already
   * transacted with at VERIFIED trust, for `step_up_on_first_use`.
   */
  seenMerchants: ReadonlySet<string>;
}

export function emptySpendSnapshot(): SpendSnapshot {
  const zero = (): WindowSpend => ({ amount: 0, count: 0 });
  return {
    day: zero(),
    week: zero(),
    month: zero(),
    mandate: zero(),
    seenMerchants: new Set(),
  };
}

export function windowSpend(
  snapshot: SpendSnapshot,
  window: LimitWindowValue,
): WindowSpend {
  return snapshot[window];
}

export interface EngineInput {
  policy: Policy;
  action: ProposedAction;
  merchant: ResolvedMerchant;
  spend: SpendSnapshot;
  /** The instant to evaluate against. Never read from the system clock internally. */
  now: Date;
}

export interface EngineResult {
  decision: Decision;
  /** Reasons for the winning decision only, in evaluation order. Always at least one. */
  reasons: Reason[];
}
