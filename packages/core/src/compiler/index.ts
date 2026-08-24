import { createHash } from "node:crypto";
import { canonicalizePolicy, type Policy } from "../policy.js";
import { AnthropicIntentCompiler } from "./anthropic.js";
import { FixtureIntentCompiler, type CompilerFixture } from "./fixture.js";
import type {
  CompileContext,
  CompileRequest,
  CompileResult,
  IntentCompiler,
} from "./types.js";

export * from "./types.js";
export { AnthropicIntentCompiler } from "./anthropic.js";
export { FixtureIntentCompiler, type CompilerFixture } from "./fixture.js";
export { extractJsonObject } from "./anthropic.js";

export const DEFAULT_COMPILE_CONTEXT: Omit<CompileContext, "now"> = {
  currency: "USD",
  timezone: "America/New_York",
  default_ttl_hours: 720, // 30 days
};

export function createCompileContext(
  overrides: Partial<CompileContext> = {},
): CompileContext {
  return {
    ...DEFAULT_COMPILE_CONTEXT,
    now: new Date(),
    ...overrides,
  };
}

/**
 * Select a compiler from the environment.
 *
 * AGENTPAY_COMPILER=anthropic (default) | fixture
 */
export function createCompilerFromEnv(
  fixtures: CompilerFixture[] = [],
): IntentCompiler {
  const kind = process.env.AGENTPAY_COMPILER ?? "anthropic";
  if (kind === "fixture") return new FixtureIntentCompiler(fixtures);
  return new AnthropicIntentCompiler();
}

/** SHA-256 over the canonical policy bytes. This is what the principal signs. */
export function hashPolicy(policy: Policy): string {
  return createHash("sha256").update(canonicalizePolicy(policy)).digest("hex");
}

/**
 * What the principal is shown before they authenticate a mandate.
 *
 * Confirmation is mandatory, not "where appropriate". A compiled policy the
 * principal has not seen is a guess about their money, and every guess the
 * compiler made is listed here in plain language.
 */
export interface MandateConfirmation {
  summary: string;
  policy_hash: string;
  /** Plain-language rendering of what will actually be enforced. */
  terms: string[];
  /** Everything the compiler decided that the principal did not say. */
  assumptions: string[];
  /** Non-blocking coherence warnings. */
  warnings: string[];
  expires_at: string;
}

export function buildConfirmation(
  result: Extract<CompileResult, { status: "compiled" }>,
): MandateConfirmation {
  const { policy } = result;
  return {
    summary: policy.summary,
    policy_hash: hashPolicy(policy),
    terms: describePolicy(policy),
    assumptions: result.assumptions,
    warnings: result.issues
      .filter((issue) => issue.severity === "warning")
      .map((issue) => `${issue.path}: ${issue.message}`),
    expires_at: policy.expires_at,
  };
}

/** Render a policy as the bullet list a human confirms. Display only. */
export function describePolicy(policy: Policy): string[] {
  const terms: string[] = [];
  const fmt = (minor: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: policy.currency,
    }).format(minor / 100);

  if (policy.per_transaction_max !== undefined) {
    terms.push(`No single transaction above ${fmt(policy.per_transaction_max)}.`);
  }

  for (const limit of policy.cumulative_limits) {
    const scope =
      limit.window === "mandate" ? "in total" : `per calendar ${limit.window}`;
    terms.push(`At most ${fmt(limit.max_amount)} ${scope}.`);
    if (limit.max_count !== undefined) {
      terms.push(`At most ${limit.max_count} transactions ${scope}.`);
    }
  }

  if (policy.merchants.allow.length > 0) {
    const names = policy.merchants.allow
      .map((m) => m.label ?? m.value)
      .join(", ");
    terms.push(`Approved merchants: ${names}.`);
  }
  if (policy.merchants.deny.length > 0) {
    const names = policy.merchants.deny
      .map((m) => m.label ?? m.value)
      .join(", ");
    terms.push(`Blocked merchants: ${names}.`);
  }
  terms.push(
    `Any other merchant: ${dispositionPhrase(policy.merchants.unlisted)}.`,
  );

  if (policy.categories.allow.length > 0) {
    terms.push(`Approved categories: ${policy.categories.allow.join(", ")}.`);
  }
  if (policy.categories.deny.length > 0) {
    terms.push(`Blocked categories: ${policy.categories.deny.join(", ")}.`);
  }

  if (policy.step_up.above_amount !== undefined) {
    terms.push(
      `You will be asked to approve anything at or above ${fmt(
        policy.step_up.above_amount,
      )}.`,
    );
  }
  if (policy.step_up.above_cumulative) {
    terms.push(
      `You will be asked to approve once spend reaches ${fmt(
        policy.step_up.above_cumulative.amount,
      )} per ${policy.step_up.above_cumulative.window}.`,
    );
  }
  if (policy.merchants.step_up_on_first_use) {
    terms.push("You will be asked the first time each new merchant is used.");
  }

  for (const constraint of policy.constraints) {
    if (!constraint.required) continue;
    terms.push(
      `The agent must confirm ${constraint.key} ${constraint.operator} ${JSON.stringify(
        constraint.value,
      )} (agent-reported, not independently verified).`,
    );
  }

  terms.push(
    `Spend counts at ${policy.accounting.basis} time, in ${policy.accounting.timezone}.`,
  );
  terms.push(
    `Pending approvals ${
      policy.accounting.reserve_on_step_up ? "hold" : "do not hold"
    } budget while they wait.`,
  );
  terms.push(`This authority expires ${policy.expires_at}.`);

  return terms;
}

function dispositionPhrase(disposition: string): string {
  if (disposition === "ALLOW") return "allowed";
  if (disposition === "DENY") return "blocked";
  return "requires your approval";
}

export type { CompileRequest, CompileResult, IntentCompiler };
