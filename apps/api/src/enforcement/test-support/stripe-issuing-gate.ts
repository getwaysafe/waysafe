/**
 * Same shape as payments/test-support/stripe-gate.ts, for the same reason:
 * self-skip when there's nothing to test against (no Issuing key
 * configured yet), but fail loudly instead of silently when
 * WAYSAFE_REQUIRE_STRIPE_ISSUING=1 says there should be one.
 *
 * `probeStripeIssuingKey` itself lives in ../stripe-issuing.ts, not here --
 * this file imports `vitest` at module scope, which must never end up in
 * the server's runtime import graph.
 */

import { describe, it } from "vitest";

export function requireStripeIssuingOrExplainSkip(suiteName: string, reachable: boolean): void {
  if (reachable) return;
  if (process.env.WAYSAFE_REQUIRE_STRIPE_ISSUING !== "1") return;

  describe(suiteName, () => {
    it("requires a configured STRIPE_ISSUING_SECRET_KEY because WAYSAFE_REQUIRE_STRIPE_ISSUING=1", () => {
      throw new Error(
        `WAYSAFE_REQUIRE_STRIPE_ISSUING=1 but STRIPE_ISSUING_SECRET_KEY is unset or still the ` +
          `placeholder -- refusing to silently skip "${suiteName}". Set a real test-mode key, or ` +
          `unset WAYSAFE_REQUIRE_STRIPE_ISSUING to allow skipping.`,
      );
    });
  });
}
