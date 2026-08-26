/**
 * AgentPay Policy, version 1.
 *
 * A Policy is the machine-enforceable form of a Mandate. It is produced by the
 * intent compiler from natural language, confirmed by the principal, frozen,
 * and then evaluated by deterministic code. Nothing in this file calls a model;
 * nothing in this file is allowed to be ambiguous.
 *
 * Design rules:
 *  - Every amount is integer minor units (see money.ts).
 *  - Every field that could default silently instead defaults *explicitly*, so
 *    that a receipt can show exactly what was enforced.
 *  - `unlisted` dispositions are required, not inferred. "Amazon and Staples are
 *    approved" does not say what happens at Best Buy; the compiler must decide
 *    and the principal must see the decision before authenticating.
 */

import { z } from "zod";
import { CurrencySchema, MinorUnitsSchema } from "./money.js";
import { MerchantRefSchema } from "./merchant.js";

export const POLICY_SCHEMA_VERSION = "agentpay.policy/v1" as const;

/** What to do with something that is on neither the allowlist nor the denylist. */
export const UnlistedDisposition = {
  ALLOW: "ALLOW",
  DENY: "DENY",
  STEP_UP: "STEP_UP",
} as const;

export const UnlistedDispositionSchema = z.nativeEnum(UnlistedDisposition);

/** Rolling/calendar windows a cumulative limit can be scoped to. */
export const LimitWindow = {
  /** Calendar day in the policy's timezone. */
  DAY: "day",
  /** Calendar week (Monday start) in the policy's timezone. */
  WEEK: "week",
  /** Calendar month in the policy's timezone. */
  MONTH: "month",
  /** For the entire life of the mandate. */
  MANDATE: "mandate",
} as const;

export const LimitWindowSchema = z.nativeEnum(LimitWindow);

export const CumulativeLimitSchema = z.object({
  window: LimitWindowSchema,
  max_amount: MinorUnitsSchema,
  /** Optional cap on the number of transactions in the same window. */
  max_count: z.number().int().positive().optional(),
});

/**
 * Budget accounting semantics. The PRD said "$500 per month" without saying
 * against what, so it is explicit here and stamped into every receipt.
 */
export const AccountingSchema = z.object({
  /** IANA timezone that defines calendar window boundaries. */
  timezone: z.string().min(1).default("America/New_York"),
  /**
   * `authorization` counts spend when AgentPay authorizes it — conservative,
   * and the right default when agents can fire many actions quickly.
   * `settlement` counts it only once the PSP settles.
   */
  basis: z.enum(["authorization", "settlement"]).default("authorization"),
  /** Does a pending STEP_UP hold budget while it waits for a human? */
  reserve_on_step_up: z.boolean().default(true),
  /** Do refunds and reversals credit the budget back? */
  refunds_credit_budget: z.boolean().default(true),
});

export const TimeWindowSchema = z.object({
  /** 0 = Sunday. Empty/omitted means every day. */
  days_of_week: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  /**
   * Local time "HH:MM" in the policy timezone. If both are set and
   * `start_time > end_time`, the window wraps past midnight (e.g.
   * "22:00"-"06:00" permits 10pm through 6am); otherwise it's a same-day
   * range. See engine/evaluate.ts `evaluateTimeWindow`.
   */
  start_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  end_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
});

export const MerchantRulesSchema = z.object({
  allow: z.array(MerchantRefSchema).default([]),
  deny: z.array(MerchantRefSchema).default([]),
  unlisted: UnlistedDispositionSchema,
  /** Require human approval the first time a given merchant is used. */
  step_up_on_first_use: z.boolean().default(false),
});

export const CategoryRulesSchema = z.object({
  /** Free-form category slugs, e.g. "office_supplies", "lodging", "gambling". */
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
  /** Four-digit MCCs that are always denied regardless of category mapping. */
  deny_mcc: z.array(z.string().regex(/^\d{4}$/)).default([]),
  unlisted: UnlistedDispositionSchema,
});

export const StepUpRulesSchema = z.object({
  /** Any single transaction at or above this amount requires human approval. */
  above_amount: MinorUnitsSchema.optional(),
  /** Cumulative spend at or above this amount in the window requires approval. */
  above_cumulative: z
    .object({
      window: LimitWindowSchema,
      amount: MinorUnitsSchema,
    })
    .optional(),
  /** How long a pending step-up stays open before it expires. */
  ttl_seconds: z.number().int().positive().default(900),
});

/**
 * Obligations the agent must attest to. These are what §9 of the PRD calls
 * fulfillment — "refundable", "nonstop". AgentPay cannot independently verify
 * most of them in the MVP, so each is recorded as an *agent attestation* and
 * labeled as such on the receipt. `required: true` means a missing or false
 * attestation is a DENY.
 */
export const ConstraintSchema = z.object({
  key: z.string().min(1),
  operator: z.enum(["equals", "not_equals", "lte", "gte", "in", "not_in"]),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ]),
  required: z.boolean().default(true),
  /** Always true in the MVP: nothing here is independently verified. */
  verification: z.enum(["agent_attested", "provider_verified"]).default(
    "agent_attested",
  ),
});

export const PolicySchema = z.object({
  schema_version: z.literal(POLICY_SCHEMA_VERSION),

  /** Human-readable summary shown to the principal before they authenticate. */
  summary: z.string().min(1),

  currency: CurrencySchema,

  /** Per-transaction ceiling. Omitted means no per-transaction ceiling. */
  per_transaction_max: MinorUnitsSchema.optional(),

  cumulative_limits: z.array(CumulativeLimitSchema).default([]),

  merchants: MerchantRulesSchema,
  categories: CategoryRulesSchema,
  step_up: StepUpRulesSchema,
  accounting: AccountingSchema,

  time_window: TimeWindowSchema.optional(),

  constraints: z.array(ConstraintSchema).default([]),

  /** Absolute expiry. Required — no mandate is open-ended. */
  expires_at: z.string().datetime(),

  /** Free-form notes from the compiler about how it read the instruction. */
  compiler_notes: z.array(z.string()).default([]),
});

export type Policy = z.infer<typeof PolicySchema>;
export type CumulativeLimit = z.infer<typeof CumulativeLimitSchema>;
export type MerchantRules = z.infer<typeof MerchantRulesSchema>;
export type CategoryRules = z.infer<typeof CategoryRulesSchema>;
export type StepUpRules = z.infer<typeof StepUpRulesSchema>;
export type Accounting = z.infer<typeof AccountingSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

// --- Cross-field validation -------------------------------------------------

export interface PolicyIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

/**
 * Checks the schema cannot express: internal contradictions that would make the
 * policy unenforceable or misleading. Errors block activation; warnings are
 * surfaced to the principal at confirmation time.
 */
export function validatePolicyCoherence(policy: Policy): PolicyIssue[] {
  const issues: PolicyIssue[] = [];

  const stepUpAbove = policy.step_up.above_amount;
  if (
    stepUpAbove !== undefined &&
    policy.per_transaction_max !== undefined &&
    stepUpAbove >= policy.per_transaction_max
  ) {
    issues.push({
      path: "/step_up/above_amount",
      message:
        "step-up threshold is at or above the per-transaction maximum, so it can never trigger; anything that large is denied outright",
      severity: "warning",
    });
  }

  for (const [i, limit] of policy.cumulative_limits.entries()) {
    if (
      policy.per_transaction_max !== undefined &&
      limit.max_amount < policy.per_transaction_max
    ) {
      issues.push({
        path: `/cumulative_limits/${i}/max_amount`,
        message: `the ${limit.window} cumulative limit is below the per-transaction maximum, so a single permitted transaction could never be paid`,
        severity: "warning",
      });
    }
  }

  const windows = policy.cumulative_limits.map((l) => l.window);
  const duplicateWindow = windows.find(
    (w, i) => windows.indexOf(w) !== i,
  );
  if (duplicateWindow) {
    issues.push({
      path: "/cumulative_limits",
      message: `more than one cumulative limit for window "${duplicateWindow}"; combine them into one`,
      severity: "error",
    });
  }

  if (
    policy.merchants.unlisted === UnlistedDisposition.ALLOW &&
    policy.merchants.allow.length > 0
  ) {
    issues.push({
      path: "/merchants/unlisted",
      message:
        "an allowlist is present but unlisted merchants are allowed anyway, which makes the allowlist meaningless",
      severity: "warning",
    });
  }

  for (const [i, ref] of policy.merchants.allow.entries()) {
    if (ref.scheme === "name") {
      issues.push({
        path: `/merchants/allow/${i}`,
        message:
          "a merchant allowlisted only by name can never be verified, so it will always require step-up; add a domain",
        severity: "warning",
      });
    }
    if (ref.scheme === "mcc") {
      issues.push({
        path: `/merchants/allow/${i}`,
        message:
          "an MCC identifies a category, not a merchant; move it to categories",
        severity: "error",
      });
    }
  }

  const expiresAt = new Date(policy.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    issues.push({
      path: "/expires_at",
      message: "expires_at is not a valid timestamp",
      severity: "error",
    });
  }

  const overlap = policy.categories.allow.filter((c) =>
    policy.categories.deny.includes(c),
  );
  if (overlap.length > 0) {
    issues.push({
      path: "/categories",
      message: `category appears in both allow and deny: ${overlap.join(", ")}`,
      severity: "error",
    });
  }

  const bothMerchant = policy.merchants.allow.filter((a) =>
    policy.merchants.deny.some(
      (d) => d.scheme === a.scheme && d.value.toLowerCase() === a.value.toLowerCase(),
    ),
  );
  if (bothMerchant.length > 0) {
    issues.push({
      path: "/merchants",
      message: `merchant appears in both allow and deny: ${bothMerchant
        .map((m) => m.value)
        .join(", ")}`,
      severity: "error",
    });
  }

  return issues;
}

export type PolicyParseResult =
  | { ok: true; policy: Policy; issues: PolicyIssue[] }
  | { ok: false; policy?: undefined; issues: PolicyIssue[] };

/** Parse + coherence-check in one step. This is the only sanctioned entry point. */
export function parsePolicy(input: unknown): PolicyParseResult {
  const parsed = PolicySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: `/${issue.path.join("/")}`,
        message: issue.message,
        severity: "error" as const,
      })),
    };
  }

  const issues = validatePolicyCoherence(parsed.data);
  const hasErrors = issues.some((i) => i.severity === "error");
  if (hasErrors) {
    return { ok: false, issues };
  }
  return { ok: true, policy: parsed.data, issues };
}

/**
 * Canonical JSON for hashing and signing: object keys sorted recursively, no
 * insignificant whitespace. Two semantically identical policies must produce
 * byte-identical output so a receipt's policy hash is stable.
 */
export function canonicalizePolicy(policy: Policy): string {
  return JSON.stringify(sortKeysDeep(policy));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}
