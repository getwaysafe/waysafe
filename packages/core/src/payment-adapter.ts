/**
 * The payment-rail abstraction.
 *
 * D-13: this interface *is* the product surface, not an implementation
 * detail. The only reason AgentPay is a router and not a wrapper around one
 * provider's API is that two genuinely different rails (a card processor,
 * a stablecoin settlement protocol) can both satisfy it. Nothing in this
 * file names a provider, imports a provider SDK, or assumes a provider's
 * semantics -- a rail is free to hold funds before capture or settle
 * atomically, be reversible or not, settle instantly or on delay, and
 * `RailCapability` is how the difference is represented as data instead of
 * as an `if (provider === "stripe")` somewhere it shouldn't be.
 *
 * `evaluate()` never sees this file. Execution is a separate concern from
 * the authorization decision (I-9): a policy can ALLOW a purchase with no
 * idea which rail, or how many rails, will ever execute it.
 */

export interface RailCapability {
  /**
   * Card rails authorize a hold before capturing; the hold is a real,
   * separate step a payer can see reversed. A stablecoin transfer settles
   * atomically -- there is no intermediate hold to reserve against on the
   * rail itself. `false` here means `reserve_on_step_up` (D-4) is purely an
   * AgentPay-side ledger concept for this rail, not something mirrored by
   * an actual hold at the provider.
   */
  holdsFundsBeforeCapture: boolean;
  /**
   * Whether a captured payment on this rail can later be reversed. Card
   * payments generally can (refunds); many on-chain settlements cannot --
   * `refunds_credit_budget` (D-4) has nothing to credit back on a rail
   * where this is `false`.
   */
  reversible: boolean;
  /** When funds actually move, from the payer's perspective -- independent
   * of when AgentPay records the authorization decision. */
  settlement: "instant" | "delayed";
}

export interface ExecutionRequest {
  /** AgentPay's own id for the authorization being executed. The join key
   * back to a decision is always this, never a provider reference. */
  authorizationId: string;
  /** Integer minor units (D-2). */
  amount: number;
  currency: string;
  /**
   * A rail-specific instrument reference -- a tokenized card, a wallet
   * address, whatever this particular rail's `execute()` needs to move
   * money. Opaque to everything outside the adapter that issued or expects
   * it; core never inspects its shape.
   */
  paymentMethodRef: string;
  /**
   * For providers with their own idempotency mechanism. Distinct from
   * AgentPay's `idempotency_key` on the authorization request -- this one
   * is scoped to a single provider call, so retrying a failed `execute()`
   * for the same authorization doesn't double-charge even if the network
   * response was lost, not just the request.
   */
  idempotencyKey: string;
}

export type ExecutionResult =
  | {
      ok: true;
      /** The rail's own reference for this payment -- never used as the
       * join key back into AgentPay's records, only stored alongside it. */
      providerReference: string;
      /** Integer minor units, same currency as the request: what the
       * provider actually took. Kept separate from the authorized amount
       * so a receipt can show both -- a router that can't say what a rail
       * charged for itself isn't provable as neutral (D-13). */
      providerFee: number;
      executedAt: Date;
    }
  | {
      ok: false;
      reason: string;
    };

export interface PaymentAdapter {
  /** An identifier ("stripe", "x402"), never branched on inside `core` --
   * only ever used as a label for logging, receipts, and adapter lookup. */
  readonly name: string;
  readonly capabilities: RailCapability;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
