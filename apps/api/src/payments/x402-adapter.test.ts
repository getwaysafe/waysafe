import { describe, expect, it } from "vitest";
import type { PaymentAdapter } from "@bles/core";
import { X402Adapter } from "./x402-adapter.js";

describe("X402Adapter", () => {
  it("declares capabilities reflecting atomic, irreversible settlement -- a genuinely different profile than a card rail", () => {
    const adapter = new X402Adapter();
    expect(adapter.capabilities).toEqual({
      holdsFundsBeforeCapture: false,
      reversible: false,
      settlement: "instant",
    });
  });

  it("does not execute -- this adapter proves the interface holds across rails, not a live settlement path", async () => {
    const adapter = new X402Adapter();
    const result = await adapter.execute({
      authorizationId: "auth_test",
      amount: 1000,
      currency: "USD",
      paymentMethodRef: "any",
      idempotencyKey: "key",
    });
    expect(result.ok).toBe(false);
  });

  it("satisfies PaymentAdapter structurally, same as StripeAdapter would -- the router can hold both in one list", () => {
    const adapters: PaymentAdapter[] = [new X402Adapter()];
    expect(adapters[0]?.name).toBe("x402");
  });
});
