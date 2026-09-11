/**
 * Same shape as test-support/stripe-issuing-gate.ts, for the same reason:
 * self-skip when there's nothing to test against, but fail loudly instead
 * of silently when WAYSAFE_REQUIRE_X402_LIVE=1 says there should be one.
 *
 * D-40 left this gated on a single missing piece: no 2-of-2 payer account
 * existed at all. D-41 builds that account (`x402-safe.ts`'s
 * `deploySafeTwoOfTwo`), so `reachable` (`probeX402SafeAccount()`) now
 * checks the fuller set of real prerequisites the live test actually
 * needs: `WAYSAFE_SAFE_COSIGNER_KEY` (the real secp256k1 owner key),
 * `POLYGON_AMOY_RPC_URL`, `WAYSAFE_X402_LIVE_PAYER_ACCOUNT` (the deployed
 * Safe's address), and `WAYSAFE_X402_TEST_SESSION_KEY` (this test's own
 * stand-in for "the agent's runtime"). Any one missing is still an honest
 * skip, not a failure -- this file only escalates to a hard failure when
 * WAYSAFE_REQUIRE_X402_LIVE=1 explicitly says skipping is unacceptable.
 */

import { describe, it } from "vitest";

export function requireX402LiveOrExplainSkip(suiteName: string, reachable: boolean): void {
  if (reachable) return;
  if (process.env.WAYSAFE_REQUIRE_X402_LIVE !== "1") return;

  describe(suiteName, () => {
    it("requires a deployed and funded 2-of-2 payer Safe because WAYSAFE_REQUIRE_X402_LIVE=1", () => {
      throw new Error(
        `WAYSAFE_REQUIRE_X402_LIVE=1 but one of WAYSAFE_SAFE_COSIGNER_KEY, POLYGON_AMOY_RPC_URL, ` +
          `WAYSAFE_X402_LIVE_PAYER_ACCOUNT, or WAYSAFE_X402_TEST_SESSION_KEY is unset -- refusing to ` +
          `silently skip "${suiteName}". Run \`npm run deploy-x402-safe -w @waysafe/api\` (D-41) to ` +
          "deploy the Safe and populate these, or unset WAYSAFE_REQUIRE_X402_LIVE to allow skipping.",
      );
    });
  });
}
