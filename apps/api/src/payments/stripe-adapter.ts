/**
 * The one place Stripe's shape is allowed to exist. Nothing outside this
 * file imports the Stripe SDK or knows a PaymentIntent from a Charge --
 * `PaymentAdapter` (D-13) is the only surface `apps/api`'s execution
 * service talks to.
 *
 * Test mode only. The key this adapter is constructed with should be a
 * *restricted* key scoped to `Payment Intents: Write` and nothing else --
 * this adapter has no business touching Customers, Payouts, or anything
 * else in the account, so the credential it holds shouldn't be able to
 * either.
 */

import Stripe from "stripe";
import type { ExecutionRequest, ExecutionResult, PaymentAdapter, RailCapability } from "@waysafe/core";

/**
 * D-36: Stripe now creates a charge's `balance_transaction` asynchronously,
 * confirmed empirically against this account -- it is reliably still `null`
 * immediately after the PaymentIntent confirms `succeeded`, even with
 * `expand: ["latest_charge.balance_transaction"]` requested on the create
 * call itself, and appears roughly 3.5-4 seconds later. This was not true
 * when this adapter was first written (Week 4): the field being read was
 * always correct, but the assumption that it's populated synchronously no
 * longer holds. A receipt that can't show what the rail actually charged
 * isn't provable as neutral (D-13), so `execute()` polls briefly for the
 * real fee rather than silently reporting 0 forever. `FEE_POLL_ATTEMPTS` *
 * `FEE_POLL_INTERVAL_MS` gives comfortable margin above the observed delay.
 */
const FEE_POLL_ATTEMPTS = 10;
const FEE_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StripeAdapter implements PaymentAdapter {
  readonly name = "stripe";
  readonly capabilities: RailCapability = {
    // PaymentIntents support a genuine authorize-then-capture flow; this
    // adapter confirms immediately (Week 4 scope has no separate capture
    // step yet), but the rail itself does hold funds before capture.
    holdsFundsBeforeCapture: true,
    reversible: true,
    settlement: "instant",
  };

  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create(
        {
          amount: request.amount,
          currency: request.currency.toLowerCase(),
          payment_method: request.paymentMethodRef,
          payment_method_types: ["card"],
          confirm: true,
          off_session: true,
          metadata: { waysafe_authorization_id: request.authorizationId },
          expand: ["latest_charge.balance_transaction"],
        },
        { idempotencyKey: request.idempotencyKey },
      );

      if (paymentIntent.status !== "succeeded") {
        return { ok: false, reason: `payment_intent did not succeed (status: ${paymentIntent.status})` };
      }

      return {
        ok: true,
        providerReference: paymentIntent.id,
        providerFee: await this.resolveFee(paymentIntent),
        executedAt: new Date(),
      };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        return { ok: false, reason: err.message };
      }
      throw err;
    }
  }

  /**
   * D-36: `paymentIntent` (from the create/confirm call) almost always has
   * no balance_transaction yet -- see the class-level comment. Poll the
   * PaymentIntent a bounded number of times before giving up and reporting
   * 0, so `execute()` still returns promptly on a rail that never happens
   * to attach the fee in time, instead of hanging indefinitely.
   */
  private async resolveFee(paymentIntent: Stripe.PaymentIntent): Promise<number> {
    const immediate = extractFee(paymentIntent);
    if (immediate > 0) return immediate;

    for (let attempt = 0; attempt < FEE_POLL_ATTEMPTS; attempt += 1) {
      await sleep(FEE_POLL_INTERVAL_MS);
      const refreshed = await this.stripe.paymentIntents.retrieve(paymentIntent.id, {
        expand: ["latest_charge.balance_transaction"],
      });
      const fee = extractFee(refreshed);
      if (fee > 0) return fee;
    }
    return 0;
  }
}

/** The processing fee lives on the charge's balance transaction, not the
 * PaymentIntent itself -- reachable only via the `expand` requested above. */
function extractFee(paymentIntent: Stripe.PaymentIntent): number {
  const charge = paymentIntent.latest_charge;
  if (!charge || typeof charge === "string") return 0;
  const balanceTransaction = charge.balance_transaction;
  if (!balanceTransaction || typeof balanceTransaction === "string") return 0;
  return balanceTransaction.fee;
}
