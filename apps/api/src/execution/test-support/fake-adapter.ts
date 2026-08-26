/**
 * A real (if trivial) `PaymentAdapter` for testing execution orchestration
 * without touching Stripe or x402. Records every call it receives so tests
 * can assert not just the outcome but whether -- and how many times -- the
 * adapter was actually invoked (the idempotency and double-execution
 * proofs both depend on this).
 */

import type { ExecutionRequest, ExecutionResult, PaymentAdapter, RailCapability } from "@agentpay/core";

export interface FakeAdapterOptions {
  outcome?: "success" | "failure";
  providerFee?: number;
  failureReason?: string;
}

export class FakeAdapter implements PaymentAdapter {
  readonly name = "fake";
  readonly capabilities: RailCapability = {
    holdsFundsBeforeCapture: true,
    reversible: true,
    settlement: "instant",
  };

  readonly calls: ExecutionRequest[] = [];
  private readonly outcome: "success" | "failure";
  private readonly providerFee: number;
  private readonly failureReason: string;

  constructor(options: FakeAdapterOptions = {}) {
    this.outcome = options.outcome ?? "success";
    this.providerFee = options.providerFee ?? 0;
    this.failureReason = options.failureReason ?? "declined";
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    if (this.outcome === "failure") {
      return { ok: false, reason: this.failureReason };
    }
    return {
      ok: true,
      providerReference: `fake_ref_${this.calls.length}`,
      providerFee: this.providerFee,
      executedAt: new Date(),
    };
  }
}
