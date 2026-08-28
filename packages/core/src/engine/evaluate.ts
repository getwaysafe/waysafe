/**
 * The deterministic authorization engine.
 *
 * `evaluate()` checks every dimension of a policy against a proposed action
 * and combines the results under one rule: DENY > STEP_UP > ALLOW. Every
 * dimension below can only ever *add* a reason at its own tier or above; none
 * of them can downgrade a decision another dimension already forced upward.
 * The final result carries only the reasons at the winning tier — a DENY
 * receipt is not cluttered with step-up notes that turned out to be moot.
 *
 * Known gap, not solved here: `action.category` is an agent-supplied claim
 * with no independent corroboration, unlike merchant identity (D-3). A
 * misbehaving agent could mislabel a purchase to dodge `categories.deny`.
 * `deny_mcc` is checked against `resolved.mcc`, which is *not* limited to a
 * directory- or PSP-sourced code — an agent-asserted MCC reaches it too, by
 * design: a claim of a blocked MCC is disqualifying, exactly as a claim of a
 * blocked merchant name is (`matchesDenylist`). What `deny_mcc` gives you
 * that `categories.deny` doesn't is provenance: `resolved.mcc_source` records
 * whether the code came from the agent's claim or a corroborated source, so a
 * receipt can show which. See DECISIONS.md D-14.
 */

import {
  isIdentityScheme,
  matchesDenylist,
  merchantRefKey,
  satisfiesAllowlist,
  MerchantTrust,
  type ResolvedMerchant,
} from "../merchant.js";
import { formatMoney, type Currency } from "../money.js";
import {
  UnlistedDisposition,
  type CategoryRules,
  type Constraint,
  type LimitWindow,
  type MerchantRules,
  type Policy,
  type StepUpRules,
  type TimeWindow,
} from "../policy.js";
import type { ProposedAction } from "../domain.js";
import { Decision, ReasonCode, decisionForReasonCode, type Reason } from "../reason-codes.js";
import { zonedParts } from "../time.js";
import type { EngineInput, EngineResult, SpendSnapshot } from "./types.js";

export function evaluate(input: EngineInput): EngineResult {
  const { policy, action, merchant, spend, now } = input;

  const reasons: Reason[] = [
    ...evaluateExpiry(policy, now),
    ...evaluateCurrency(policy, action),
    ...evaluateTimeWindow(policy.time_window, policy.accounting.timezone, now),
    ...evaluateMerchant(policy.merchants, merchant, spend),
    ...evaluateCategory(policy.categories, action, merchant),
    ...evaluateConstraints(policy.constraints, action),
    ...evaluateLimits(policy, action, spend),
    ...evaluateStepUpThresholds(policy.step_up, action, spend, policy.currency),
  ];

  const denies = reasons.filter(
    (r) => decisionForReasonCode(r.code) === Decision.DENY,
  );
  if (denies.length > 0) return { decision: Decision.DENY, reasons: denies };

  const stepUps = reasons.filter(
    (r) => decisionForReasonCode(r.code) === Decision.STEP_UP,
  );
  if (stepUps.length > 0) return { decision: Decision.STEP_UP, reasons: stepUps };

  return {
    decision: Decision.ALLOW,
    reasons: [
      {
        code: ReasonCode.ALLOW_WITHIN_MANDATE,
        message: "The action is within the delegated authority.",
      },
    ],
  };
}

// --- Mandate expiry -----------------------------------------------------

function evaluateExpiry(policy: Policy, now: Date): Reason[] {
  if (now.getTime() < new Date(policy.expires_at).getTime()) return [];
  return [
    {
      code: ReasonCode.DENY_MANDATE_EXPIRED,
      message: `The mandate expired at ${policy.expires_at}.`,
      policy_path: "/expires_at",
      detail: { expires_at: policy.expires_at, now: now.toISOString() },
    },
  ];
}

// --- Currency -------------------------------------------------------------

function evaluateCurrency(policy: Policy, action: ProposedAction): Reason[] {
  if (action.currency === policy.currency) return [];
  return [
    {
      code: ReasonCode.DENY_CURRENCY_NOT_PERMITTED,
      message: `The mandate is denominated in ${policy.currency}, not ${action.currency}.`,
      policy_path: "/currency",
      detail: { policy_currency: policy.currency, action_currency: action.currency },
    },
  ];
}

// --- Time window ------------------------------------------------------------

function evaluateTimeWindow(
  timeWindow: TimeWindow | undefined,
  timezone: string,
  now: Date,
): Reason[] {
  if (!timeWindow) return [];
  const parts = zonedParts(now, timezone);

  if (
    timeWindow.days_of_week &&
    timeWindow.days_of_week.length > 0 &&
    !timeWindow.days_of_week.includes(parts.weekday)
  ) {
    return [
      {
        code: ReasonCode.DENY_OUTSIDE_TIME_WINDOW,
        message: "The action falls on a day of the week the mandate does not permit.",
        policy_path: "/time_window/days_of_week",
        detail: { weekday: parts.weekday, permitted: timeWindow.days_of_week },
      },
    ];
  }

  const minutesOfDay = parts.hour * 60 + parts.minute;

  if (timeWindow.start_time && timeWindow.end_time) {
    const startMinutes = parseClockTime(timeWindow.start_time);
    const endMinutes = parseClockTime(timeWindow.end_time);
    // start > end means the window wraps past midnight (e.g. 22:00-06:00):
    // permitted is everything from start to midnight, plus midnight to end.
    const overnight = startMinutes > endMinutes;
    const withinWindow = overnight
      ? minutesOfDay >= startMinutes || minutesOfDay <= endMinutes
      : minutesOfDay >= startMinutes && minutesOfDay <= endMinutes;
    if (!withinWindow) {
      return [
        {
          code: ReasonCode.DENY_OUTSIDE_TIME_WINDOW,
          message: `The action is outside the mandate's permitted window of ${timeWindow.start_time}-${timeWindow.end_time}.`,
          policy_path: "/time_window",
          detail: { timezone, hour: parts.hour, minute: parts.minute, overnight },
        },
      ];
    }
    return [];
  }

  if (timeWindow.start_time) {
    const startMinutes = parseClockTime(timeWindow.start_time);
    if (minutesOfDay < startMinutes) {
      return [
        {
          code: ReasonCode.DENY_OUTSIDE_TIME_WINDOW,
          message: `The action is before the mandate's permitted start time of ${timeWindow.start_time}.`,
          policy_path: "/time_window/start_time",
          detail: { timezone, hour: parts.hour, minute: parts.minute },
        },
      ];
    }
  }

  if (timeWindow.end_time) {
    const endMinutes = parseClockTime(timeWindow.end_time);
    if (minutesOfDay > endMinutes) {
      return [
        {
          code: ReasonCode.DENY_OUTSIDE_TIME_WINDOW,
          message: `The action is after the mandate's permitted end time of ${timeWindow.end_time}.`,
          policy_path: "/time_window/end_time",
          detail: { timezone, hour: parts.hour, minute: parts.minute },
        },
      ];
    }
  }

  return [];
}

/** "HH:MM" -> minutes since midnight. */
function parseClockTime(value: string): number {
  const [h = 0, m = 0] = value.split(":").map(Number);
  return h * 60 + m;
}

// --- Merchant identity --------------------------------------------------

function evaluateMerchant(
  rules: MerchantRules,
  merchant: ResolvedMerchant,
  spend: SpendSnapshot,
): Reason[] {
  if (merchant.trust === MerchantTrust.UNKNOWN) {
    return [
      {
        code: ReasonCode.DENY_MERCHANT_UNRESOLVED,
        message: "The agent's merchant assertion carried no usable identity at all.",
        policy_path: "/merchants",
      },
    ];
  }

  const denyMatch = matchesDenylist(rules.deny, merchant);
  if (denyMatch.matched) {
    return [
      {
        code: ReasonCode.DENY_MERCHANT_BLOCKED,
        message: `The merchant matches a blocked entry (${denyMatch.via?.scheme}:${denyMatch.via?.value}).`,
        policy_path: "/merchants/deny",
        detail: { matched_via: denyMatch.via },
      },
    ];
  }

  const allow = satisfiesAllowlist(rules.allow, merchant);
  const reasons: Reason[] = [];

  if (allow.matched && !allow.verified) {
    // Matched an allow entry by value, but D-3: an unverified assertion can
    // never itself produce ALLOW.
    reasons.push(unverifiedMerchantReason());
  } else if (!allow.matched) {
    // `unlisted` is evaluated first and unconditionally -- a DENY or STEP_UP
    // it produces is never softened by anything below. See DECISIONS.md D-3
    // amendment for the full matrix.
    switch (rules.unlisted) {
      case UnlistedDisposition.DENY:
        reasons.push({
          code: ReasonCode.DENY_MERCHANT_NOT_ALLOWLISTED,
          message: "The merchant is not on the mandate's allowlist.",
          policy_path: "/merchants/unlisted",
        });
        break;
      case UnlistedDisposition.STEP_UP:
        reasons.push({
          code: ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
          message: "The merchant is not on the allowlist, so approval is required.",
          policy_path: "/merchants/unlisted",
        });
        break;
      case UnlistedDisposition.ALLOW:
        break;
    }

    // The D-3 unverified cap is always evaluated too, unconditionally, not
    // only when `unlisted` had nothing else to say. "Not on the allowlist"
    // and "not verifiably who it claims to be" are independently true facts
    // about the same merchant -- a receipt (and a human deciding a step-up)
    // needs both, not whichever one happened to run first. This can only
    // ever *add* a reason at STEP_UP or below; it never replaces or softens
    // whatever `unlisted` already decided, and the top-level DENY > STEP_UP
    // precedence in `evaluate()` still drops it entirely from the final
    // result whenever `unlisted` already forced a DENY.
    if (merchant.trust !== MerchantTrust.VERIFIED) {
      reasons.push(unverifiedMerchantReason());
    }
  }

  if (
    rules.step_up_on_first_use &&
    merchant.trust === MerchantTrust.VERIFIED &&
    !merchant.refs.some((ref) => spend.seenMerchants.has(merchantRefKey(ref)))
  ) {
    reasons.push({
      code: ReasonCode.STEP_UP_FIRST_TIME_MERCHANT,
      message: "This is the first transaction with this merchant under this mandate.",
      policy_path: "/merchants/step_up_on_first_use",
    });
  }

  return reasons;
}

function unverifiedMerchantReason(): Reason {
  return {
    code: ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
    message:
      "The merchant identity was asserted but could not be verified, so human approval is required.",
    policy_path: "/merchants",
  };
}

// --- Categories -----------------------------------------------------------

function evaluateCategory(
  rules: CategoryRules,
  action: ProposedAction,
  merchant: ResolvedMerchant,
): Reason[] {
  const reasons: Reason[] = [];

  if (merchant.mcc && rules.deny_mcc.includes(merchant.mcc)) {
    reasons.push({
      code: ReasonCode.DENY_CATEGORY_BLOCKED,
      message: `The merchant's category code ${merchant.mcc} is blocked.`,
      policy_path: "/categories/deny_mcc",
      // mcc_source may be "assertion" -- an agent's claim of a blocked MCC is
      // disqualifying on its own (D-14), same as matchesDenylist. Recorded
      // here so the receipt shows whether it was corroborated or just claimed.
      detail: { mcc: merchant.mcc, mcc_source: merchant.mcc_source },
    });
  }

  const category = action.category;

  if (category && rules.deny.includes(category)) {
    reasons.push({
      code: ReasonCode.DENY_CATEGORY_BLOCKED,
      message: `The category "${category}" is explicitly blocked by the mandate.`,
      policy_path: "/categories/deny",
      detail: { category },
    });
    return reasons;
  }

  const listed = category !== undefined && rules.allow.includes(category);
  if (!listed) {
    switch (rules.unlisted) {
      case UnlistedDisposition.DENY:
        reasons.push({
          code: ReasonCode.DENY_CATEGORY_NOT_ALLOWLISTED,
          message: category
            ? `The category "${category}" is not on the mandate's allowlist.`
            : "No category was asserted and the mandate requires one from the allowlist.",
          policy_path: "/categories/unlisted",
          detail: { category },
        });
        break;
      case UnlistedDisposition.STEP_UP:
        reasons.push({
          code: ReasonCode.STEP_UP_CATEGORY_NOT_ALLOWLISTED,
          message: category
            ? `The category "${category}" is not on the allowlist, so approval is required.`
            : "No category was asserted, so approval is required.",
          policy_path: "/categories/unlisted",
          detail: { category },
        });
        break;
      case UnlistedDisposition.ALLOW:
        break;
    }
  }

  return reasons;
}

// --- Constraints ------------------------------------------------------------

function evaluateConstraints(
  constraints: Constraint[],
  action: ProposedAction,
): Reason[] {
  const reasons: Reason[] = [];
  for (const [i, constraint] of constraints.entries()) {
    if (!constraint.required) continue;
    const actual = action.attestations[constraint.key];
    if (constraintSatisfied(constraint, actual)) continue;
    reasons.push({
      code: ReasonCode.DENY_CONSTRAINT_NOT_SATISFIED,
      message: `Required constraint "${constraint.key} ${constraint.operator} ${JSON.stringify(constraint.value)}" was not satisfied.`,
      policy_path: `/constraints/${i}`,
      detail: {
        key: constraint.key,
        operator: constraint.operator,
        expected: constraint.value,
        actual,
      },
    });
  }
  return reasons;
}

function constraintSatisfied(constraint: Constraint, actual: unknown): boolean {
  if (actual === undefined) return false;
  switch (constraint.operator) {
    case "equals":
      return actual === constraint.value;
    case "not_equals":
      return actual !== constraint.value;
    case "lte":
      return typeof actual === "number" && typeof constraint.value === "number" && actual <= constraint.value;
    case "gte":
      return typeof actual === "number" && typeof constraint.value === "number" && actual >= constraint.value;
    case "in":
      return (
        Array.isArray(constraint.value) &&
        (typeof actual === "string" || typeof actual === "number") &&
        constraint.value.includes(actual)
      );
    case "not_in":
      return (
        Array.isArray(constraint.value) &&
        (typeof actual === "string" || typeof actual === "number") &&
        !constraint.value.includes(actual)
      );
  }
}

// --- Transaction and cumulative limits ---------------------------------

function evaluateLimits(
  policy: Policy,
  action: ProposedAction,
  spend: SpendSnapshot,
): Reason[] {
  const reasons: Reason[] = [];

  if (policy.per_transaction_max !== undefined && action.amount > policy.per_transaction_max) {
    reasons.push({
      code: ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED,
      message: `The amount exceeds the per-transaction maximum of ${formatMoney({ amount: policy.per_transaction_max, currency: policy.currency })}.`,
      policy_path: "/per_transaction_max",
      detail: { amount: action.amount, max: policy.per_transaction_max },
    });
  }

  for (const [i, limit] of policy.cumulative_limits.entries()) {
    const window = spend[limit.window];
    const projectedAmount = window.amount + action.amount;
    if (projectedAmount > limit.max_amount) {
      reasons.push({
        code: ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED,
        message: `The action would bring ${limit.window} spend to ${formatMoney({ amount: projectedAmount, currency: policy.currency })}, over the limit of ${formatMoney({ amount: limit.max_amount, currency: policy.currency })}.`,
        policy_path: `/cumulative_limits/${i}`,
        detail: { window: limit.window, projected: projectedAmount, max: limit.max_amount },
      });
    }
    if (limit.max_count !== undefined) {
      const projectedCount = window.count + 1;
      if (projectedCount > limit.max_count) {
        reasons.push({
          code: ReasonCode.DENY_VELOCITY_LIMIT_EXCEEDED,
          message: `The action would bring the ${limit.window} transaction count to ${projectedCount}, over the limit of ${limit.max_count}.`,
          policy_path: `/cumulative_limits/${i}/max_count`,
          detail: { window: limit.window, projected: projectedCount, max: limit.max_count },
        });
      }
    }
  }

  return reasons;
}

// --- Step-up thresholds -------------------------------------------------

function evaluateStepUpThresholds(
  stepUp: StepUpRules,
  action: ProposedAction,
  spend: SpendSnapshot,
  currency: Currency,
): Reason[] {
  const reasons: Reason[] = [];

  if (stepUp.above_amount !== undefined && action.amount >= stepUp.above_amount) {
    reasons.push({
      code: ReasonCode.STEP_UP_AMOUNT_THRESHOLD,
      message: `The amount is at or above the mandate's step-up threshold of ${formatMoney({ amount: stepUp.above_amount, currency })}.`,
      policy_path: "/step_up/above_amount",
      detail: { amount: action.amount, threshold: stepUp.above_amount },
    });
  }

  if (stepUp.above_cumulative) {
    const window = spend[stepUp.above_cumulative.window];
    const projected = window.amount + action.amount;
    if (projected >= stepUp.above_cumulative.amount) {
      reasons.push({
        code: ReasonCode.STEP_UP_CUMULATIVE_THRESHOLD,
        message: `Projected ${stepUp.above_cumulative.window} spend of ${formatMoney({ amount: projected, currency })} is at or above the step-up threshold of ${formatMoney({ amount: stepUp.above_cumulative.amount, currency })}.`,
        policy_path: "/step_up/above_cumulative",
        detail: {
          window: stepUp.above_cumulative.window,
          projected,
          threshold: stepUp.above_cumulative.amount,
        },
      });
    }
  }

  return reasons;
}
