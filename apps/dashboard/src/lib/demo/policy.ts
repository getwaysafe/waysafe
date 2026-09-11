import "server-only";
import { POLICY_SCHEMA_VERSION, type Policy } from "@waysafe/core";
import type { Waysafe } from "@waysafe/sdk";
import { DEMO_INSTRUCTION, GOODBEANS_PAY_TO } from "./constants";

/**
 * D-42: an on-chain `payTo` address is infrastructure a policy author
 * configures, not something derivable from natural language -- no
 * compiler, real or fixture, could have produced this allowlist entry from
 * `DEMO_INSTRUCTION` alone. This is attached identically regardless of
 * whether compilation below succeeds live or falls back offline; it is not
 * part of what makes the fallback a fallback.
 */
const MERCHANT_POLICY: Policy["merchants"] = {
  allow: [{ scheme: "onchain_address", value: GOODBEANS_PAY_TO, label: "GoodBeans API" }],
  deny: [],
  unlisted: "DENY",
  step_up_on_first_use: false,
};

/** Used only when live/fixture compilation doesn't produce a usable
 * policy for `DEMO_INSTRUCTION` (no `ANTHROPIC_API_KEY` configured and no
 * matching recorded fixture -- true of a stock checkout of this repo).
 * `POST /v1/policies/validate` is the product's own sanctioned path for a
 * hand-authored policy (see server.ts's doc comment on that route) -- this
 * is not a fabricated "model output" standing in for a real one. */
function handAuthoredPolicy(): Policy {
  const expiresAt = new Date();
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 30);

  return {
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "Up to $20/day, $10 per transaction, only the allowed merchant.",
    currency: "USD",
    merchants: MERCHANT_POLICY,
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    per_transaction_max: 1000,
    cumulative_limits: [{ window: "day", max_amount: 2000 }],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: expiresAt.toISOString(),
  } as unknown as Policy;
}

export interface DemoPolicyResult {
  policy: Policy;
  compiledLive: boolean;
  assumptions: string[];
  summary: string;
}

/**
 * Attempts real compilation of `DEMO_INSTRUCTION` first (a live model call
 * if the API server has `ANTHROPIC_API_KEY` set, or a recorded fixture
 * otherwise) and always ends up with a policy whose merchant allowlist is
 * the on-chain `payTo` above -- see this file's own comment on why that
 * override is not a compromise. Falls back to `handAuthoredPolicy()` only
 * when compilation itself doesn't produce one (no fixture recorded for
 * this exact sentence, or the compiler asked for clarification).
 */
export async function buildDemoPolicy(waysafe: Waysafe): Promise<DemoPolicyResult> {
  // A 422 (no recorded fixture for this exact sentence, or the compiler
  // itself rejected it) throws from the SDK, same as "needs_clarification"
  // (a valid but unusable-here outcome) -- both mean "no live/fixture
  // compilation available," and both fall back the same way.
  try {
    const compiled = await waysafe.compileMandate({ instruction: DEMO_INSTRUCTION });
    if (compiled.status === "compiled") {
      const policy: Policy = { ...compiled.policy, merchants: MERCHANT_POLICY };
      return {
        policy,
        compiledLive: true,
        assumptions: compiled.confirmation.assumptions,
        summary: compiled.confirmation.summary,
      };
    }
  } catch {
    // fall through to the hand-authored policy below
  }

  const policy = handAuthoredPolicy();
  return { policy, compiledLive: false, assumptions: [], summary: policy.summary };
}
