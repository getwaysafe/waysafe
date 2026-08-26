/**
 * Production code -- `buildServer()` (server.ts) calls this at startup to
 * decide whether to register the Stripe adapter. Deliberately kept out of
 * test-support/stripe-gate.ts even though the two are related: that file
 * imports `vitest` at module scope, which is fine for a file only ever
 * imported from `*.test.ts`, but would make `vitest` a hard runtime
 * dependency of the server itself if server.ts imported from it -- a crash
 * in any environment that installs production dependencies only.
 */

/** True only for a real-looking test-mode key -- not unset, and not the
 * literal placeholder ".env.example" ships with. */
export function probeStripeKey(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return false;
  if (key.includes("...")) return false;
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}
