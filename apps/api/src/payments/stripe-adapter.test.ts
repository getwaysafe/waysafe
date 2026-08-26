/**
 * Runs against real Stripe test mode, not a mock -- same standard as the
 * Postgres/WebAuthn suites: a fake HTTP client would only prove this
 * adapter's plumbing, never that a real PaymentIntent actually succeeds,
 * carries a real fee, or that Stripe's own idempotency guarantee holds.
 *
 * Self-skips (test-support/stripe-gate.ts) until STRIPE_SECRET_KEY is a
 * real test-mode key -- see DECISIONS.md for the restricted-key scope this
 * key should be minted with (Payment Intents: Write, nothing else).
 */

import { describe, expect, it } from "vitest";
import { probeStripeKey } from "./stripe-key.js";
import { requireStripeOrExplainSkip } from "./test-support/stripe-gate.js";
import { StripeAdapter } from "./stripe-adapter.js";

const reachable = probeStripeKey();
const SUITE_NAME = "StripeAdapter against real Stripe test mode";
requireStripeOrExplainSkip(SUITE_NAME, reachable);

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

describe.skipIf(!reachable)(SUITE_NAME, () => {
  it("executes a real test-mode PaymentIntent and reports a genuine provider fee", async () => {
    const adapter = new StripeAdapter(process.env.STRIPE_SECRET_KEY!);

    const result = await adapter.execute({
      authorizationId: uniqueId("auth"),
      amount: 8300,
      currency: "USD",
      // Stripe's well-known test-mode PaymentMethod id -- always succeeds,
      // reusable across PaymentIntents in test mode.
      paymentMethodRef: "pm_card_visa",
      idempotencyKey: uniqueId("idem"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.providerReference).toMatch(/^pi_/);
    expect(result.providerFee).toBeGreaterThan(0);
  }, 30_000);

  it("THE ATTACK: an unknown payment method is rejected, not silently accepted", async () => {
    const adapter = new StripeAdapter(process.env.STRIPE_SECRET_KEY!);

    const result = await adapter.execute({
      authorizationId: uniqueId("auth"),
      amount: 1000,
      currency: "USD",
      paymentMethodRef: "pm_this_does_not_exist_12345",
      idempotencyKey: uniqueId("idem"),
    });

    expect(result.ok).toBe(false);
  }, 30_000);

  it("reuses the same idempotency key without double-charging -- Stripe's own guarantee, not this adapter's", async () => {
    const adapter = new StripeAdapter(process.env.STRIPE_SECRET_KEY!);
    const request = {
      authorizationId: uniqueId("auth"),
      amount: 5000,
      currency: "USD",
      paymentMethodRef: "pm_card_visa",
      idempotencyKey: uniqueId("idem"),
    };

    const first = await adapter.execute(request);
    const second = await adapter.execute(request);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.providerReference).toBe(first.providerReference);
  }, 30_000);
});
