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
import type { ExecutionRequest, ExecutionResult, PaymentAdapter, RailCapability } from "@bles/core";

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
          metadata: { bles_authorization_id: request.authorizationId },
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
        providerFee: extractFee(paymentIntent),
        executedAt: new Date(),
      };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        return { ok: false, reason: err.message };
      }
      throw err;
    }
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
