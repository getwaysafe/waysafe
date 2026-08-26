/**
 * Same shape as test-support/db-gate.ts, for the same reason: self-skip
 * when there's nothing to test against (no Stripe key configured yet), but
 * fail loudly instead of silently when AGENTPAY_REQUIRE_STRIPE=1 says there
 * should be one.
 *
 * `probeStripeKey` itself lives in ../stripe-key.ts, not here -- it's also
 * called from production code (server.ts), and this file imports `vitest`
 * at module scope, which must never end up in the server's runtime import
 * graph. Import `probeStripeKey` from ../stripe-key.js directly.
 */

import { describe, it } from "vitest";

export function requireStripeOrExplainSkip(suiteName: string, reachable: boolean): void {
  if (reachable) return;
  if (process.env.AGENTPAY_REQUIRE_STRIPE !== "1") return;

  describe(suiteName, () => {
    it("requires a configured STRIPE_SECRET_KEY because AGENTPAY_REQUIRE_STRIPE=1", () => {
      throw new Error(
        `AGENTPAY_REQUIRE_STRIPE=1 but STRIPE_SECRET_KEY is unset or still the placeholder -- ` +
          `refusing to silently skip "${suiteName}". Set a real test-mode key, or unset ` +
          `AGENTPAY_REQUIRE_STRIPE to allow skipping.`,
      );
    });
  });
}
