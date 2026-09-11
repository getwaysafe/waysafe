/**
 * D-43: the mandate the `/story` simulation evaluates every attempt against.
 *
 * Deliberately not compiled from natural language (contrast `lib/demo/
 * policy.ts`, which runs the real compiler). The story's premise is a fleet
 * already operating under an existing, active mandate at the moment of
 * compromise -- there is no "principal types an instruction" beat in this
 * narrative, so a hand-authored policy is the honest choice, not a shortcut
 * around a missing fixture. `POST /v1/policies/validate` is the product's
 * own sanctioned path for a hand-authored policy (see server.ts's doc
 * comment), the same justification `lib/demo/policy.ts`'s
 * `handAuthoredPolicy()` already relies on.
 *
 * Runs in the browser: no `server-only` import, no fetch. Pure data.
 */

import {
  createStaticDirectory,
  POLICY_SCHEMA_VERSION,
  type MerchantDirectory,
  type Policy,
} from "@waysafe/core/browser";

/** The one recurring vendor this fleet's mandate actually names. */
export const LEGIT_VENDOR_DOMAIN = "acmecloud-billing.com";
export const LEGIT_VENDOR_LABEL = "Acme Cloud Billing";

export function buildStoryDirectory(): MerchantDirectory {
  return createStaticDirectory([
    { domain: LEGIT_VENDOR_DOMAIN, display_name: LEGIT_VENDOR_LABEL, mcc: "7372" },
  ]);
}

/**
 * $2,000/day ceiling, $500/transaction, one allowed vendor, high-risk
 * categories denied per D-10. Every number here is deliberately small
 * relative to the attack's attempted volume, so the RIGHT side's "$ out"
 * counter visibly plateaus instead of just always reading zero -- the
 * mandate has *some* room, exactly like a real fleet's real budget, and
 * the story is that the ceiling holds, not that spending is impossible.
 */
export function buildStoryPolicy(): Policy {
  const expiresAt = new Date();
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 30);

  return {
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "Up to $2,000/day, $500 per transaction, only the named vendor.",
    currency: "USD",
    merchants: {
      allow: [{ scheme: "domain", value: LEGIT_VENDOR_DOMAIN, label: LEGIT_VENDOR_LABEL }],
      deny: [],
      unlisted: "DENY",
      step_up_on_first_use: false,
    },
    categories: {
      allow: [],
      deny: ["gambling", "cash_advance", "crypto", "adult", "firearms"],
      deny_mcc: [],
      unlisted: "ALLOW",
    },
    per_transaction_max: 50_000,
    cumulative_limits: [{ window: "day", max_amount: 200_000 }],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    constraints: [],
    expires_at: expiresAt.toISOString(),
  } as unknown as Policy;
}
