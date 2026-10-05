/**
 * Same shape as test-support/db-gate.ts, for the same reason: self-skip
 * when there's nothing to test against (no Stripe key configured yet), but
 * fail loudly instead of silently when WAYSAFE_REQUIRE_STRIPE=1 says there
 * should be one.
 *
 * `probeStripeKey` itself lives in ../stripe-key.ts, not here -- it's also
 * called from production code (server.ts), and this file imports `vitest`
 * at module scope, which must never end up in the server's runtime import
 * graph. Import `probeStripeKey` from ../stripe-key.js directly.
 */

import { describe, it } from "vitest";
import { recordGatedSuite } from "../../test-support/skip-report.js";

export function requireStripeOrExplainSkip(suiteName: string, reachable: boolean): void {
  // D-77: recorded whether or not it ran, so the final summary can say how
  // many gated suites there are and which of them did not execute.
  recordGatedSuite(
    {
      suite: suiteName,
      needs: "STRIPE_SECRET_KEY (a real test-mode key)",
      requireFlag: "WAYSAFE_REQUIRE_STRIPE",
    },
    reachable,
  );
  if (reachable) return;
  if (process.env.WAYSAFE_REQUIRE_STRIPE !== "1") return;

  describe(suiteName, () => {
    it("requires a configured STRIPE_SECRET_KEY because WAYSAFE_REQUIRE_STRIPE=1", () => {
      throw new Error(
        `WAYSAFE_REQUIRE_STRIPE=1 but STRIPE_SECRET_KEY is unset or still the placeholder -- ` +
          `refusing to silently skip "${suiteName}". Set a real test-mode key, or unset ` +
          `WAYSAFE_REQUIRE_STRIPE to allow skipping.`,
      );
    });
  });
}
