/**
 * Same shape as test-support/stripe-issuing-gate.ts, for the same reason:
 * self-skip when there's nothing to test against, but fail loudly instead
 * of silently when WAYSAFE_REQUIRE_X402_LIVE=1 says there should be one.
 *
 * "Nothing to test against" means something different here than it does
 * for Stripe Issuing: there is no missing API key, because this codebase
 * deliberately never built the piece that would need one -- see x402.ts's
 * custody comment. What's missing is a deployed 2-of-2 smart account (or
 * equivalent) on a real network whose validator actually enforces "Waysafe's
 * co-signature is required." `WAYSAFE_X402_LIVE_PAYER_ACCOUNT` is where that
 * account's address would go once one exists.
 */

import { describe, it } from "vitest";

export function requireX402LiveOrExplainSkip(suiteName: string, reachable: boolean): void {
  if (reachable) return;
  if (process.env.WAYSAFE_REQUIRE_X402_LIVE !== "1") return;

  describe(suiteName, () => {
    it("requires a deployed 2-of-2 payer account because WAYSAFE_REQUIRE_X402_LIVE=1", () => {
      throw new Error(
        `WAYSAFE_REQUIRE_X402_LIVE=1 but WAYSAFE_X402_LIVE_PAYER_ACCOUNT is unset -- refusing to ` +
          `silently skip "${suiteName}". This proof needs a real, deployed payer smart account whose ` +
          `validator requires Waysafe's co-signature (D-40's custody comment in x402.ts) -- nothing in ` +
          `this codebase deploys one yet, deliberately. Set WAYSAFE_X402_LIVE_PAYER_ACCOUNT once one ` +
          "exists, or unset WAYSAFE_REQUIRE_X402_LIVE to allow skipping.",
      );
    });
  });
}
