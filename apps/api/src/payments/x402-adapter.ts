/**
 * Proves the abstraction holds, not a working rail.
 *
 * x402 (HTTP 402-based stablecoin settlement) is a genuinely different kind
 * of rail from a card processor: settlement is atomic, there's no separate
 * authorization hold, and a completed transfer generally can't be reversed.
 * `capabilities` says so as data -- the same `RailCapability` shape Stripe's
 * adapter fills in differently, with no branch anywhere in core or in the
 * execution service that treats one rail specially.
 *
 * Registering this alongside `StripeAdapter` is what makes the router a
 * router: a second, structurally valid rail with a genuinely different
 * capability profile, not a second copy of the same one. `execute()`
 * deliberately does not move money -- wiring a live x402 settlement is out
 * of scope for Week 4; what's in scope is proving nothing in the router
 * assumes there is only ever one kind of rail.
 */

import type { ExecutionRequest, ExecutionResult, PaymentAdapter, RailCapability } from "@bles/core";

export class X402Adapter implements PaymentAdapter {
  readonly name = "x402";
  readonly capabilities: RailCapability = {
    holdsFundsBeforeCapture: false,
    reversible: false,
    settlement: "instant",
  };

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    void request;
    return {
      ok: false,
      reason: "x402 settlement is not implemented in this build -- this adapter demonstrates the multi-rail interface, not a live rail",
    };
  }
}
