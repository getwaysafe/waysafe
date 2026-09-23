/**
 * The rail-initiated counterpart to PaymentAdapter (D-13, D-32).
 *
 * PaymentAdapter is how Waysafe *executes* a payment after evaluate() has
 * already decided. EnforcementAdapter is the missing sibling: how a rail
 * *asks* Waysafe for that decision in the first place -- synchronously,
 * before it will let money move at all. Enforcement is rail-initiated
 * (D-32; CLAUDE.md non-negotiable #9): the rail calls Waysafe and the agent
 * never has to, so neither a compromised agent's disobedience nor a stolen
 * credential's use can skip the decision the way skipping an `authorize()`
 * call would.
 *
 * evaluate() never imports this file, and never will (I-9): this is a
 * *caller* of evaluate(), not a new path into it -- the same discipline
 * PaymentAdapter holds for execution. Nothing here names a provider,
 * imports a provider SDK, or assumes a provider's authorization protocol.
 * A rail's own webhook/callback shape (`TCallback`) is translated into an
 * `EnforcementRequest` by the adapter that knows that shape
 * (apps/api/src/enforcement/*.ts is the only place it's allowed to exist),
 * and a `Decision` is translated back into whatever response shape
 * (`TResponse`) that rail's protocol expects.
 */

import type { ProposedAction } from "./domain.js";
import type { EngineResult } from "./engine/types.js";

export interface EnforcementRequest {
  /**
   * The Waysafe-recognized reference for the spend instrument's authority
   * behind this callback -- for the card rail, the mandate id a card is
   * provisioned for (D-32: a card is provisioned per mandate, not per
   * agent). Never inspected outside the adapter that produced it, the same
   * opacity rule as PaymentAdapter's `paymentMethodRef`.
   */
  instrumentRef: string;
  action: ProposedAction;
}

export interface EnforcementAdapter<TCallback = unknown, TResponse = unknown> {
  /** An identifier ("stripe_issuing", ...), never branched on inside `core`. */
  readonly name: string;

  /**
   * Turn the rail's own authorization callback into a request `evaluate()`
   * can be run against. Returns `null` when the callback carries nothing
   * Waysafe can attribute to a mandate at all (e.g. an instrument with no
   * recognizable reference) -- the caller decides how to fail closed in
   * that case, since that's a rail-specific policy question, not a core one.
   */
  parseRequest(callback: TCallback): EnforcementRequest | null;

  /**
   * Turn a decision back into whatever shape this rail's protocol expects
   * as its synchronous response.
   *
   * May return a promise (D-63): an adapter that signs its response --
   * x402's co-signature -- now goes through a `Signer`, whose `sign` is
   * async because a KMS-backed implementation is a network call. Adapters
   * that sign nothing (Stripe Issuing, whose response is a bare
   * `{approved}`) still return synchronously; both satisfy this type, and
   * every caller awaits. The rail's own window is unchanged -- this is an
   * in-process signature today, resolving immediately.
   */
  toResponse(result: EngineResult, callback: TCallback): TResponse | Promise<TResponse>;
}
