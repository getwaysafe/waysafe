/**
 * Same shape as test-support/db-gate.ts, for the same reason: self-skip
 * when there's nothing to test against (no Stripe key configured yet), but
 * fail loudly instead of silently when AGENTPAY_REQUIRE_STRIPE=1 says there
 * should be one.
 */

import { describe, it } from "vitest";

/** True only for a real-looking test-mode key -- not unset, and not the
 * literal placeholder ".env.example" ships with. */
export function probeStripeKey(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return false;
  if (key.includes("...")) return false;
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}

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
