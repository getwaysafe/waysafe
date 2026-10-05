/**
 * Machine-readable reason codes.
 *
 * Week 2's exit criteria depends on these, so they are defined in Week 1 and
 * treated as a public API surface: codes are additive-only and never renamed.
 * Every authorization decision carries at least one code, and the code — not the
 * prose — is what SDK consumers and the dashboard branch on.
 */

export const Decision = {
  ALLOW: "ALLOW",
  DENY: "DENY",
  STEP_UP: "STEP_UP",
} as const;

export type Decision = (typeof Decision)[keyof typeof Decision];

export const ReasonCode = {
  // --- ALLOW -------------------------------------------------------------
  ALLOW_WITHIN_MANDATE: "ALLOW_WITHIN_MANDATE",

  // --- DENY: mandate state ----------------------------------------------
  DENY_NO_ACTIVE_MANDATE: "DENY_NO_ACTIVE_MANDATE",
  DENY_MANDATE_EXPIRED: "DENY_MANDATE_EXPIRED",
  DENY_MANDATE_REVOKED: "DENY_MANDATE_REVOKED",
  /**
   * D-73: the step-up's own TTL had already passed when an approver tried
   * to resolve it. Distinct from DENY_MANDATE_EXPIRED (the mandate's
   * authority lapsed) and from a step-up swept by the expiry worker (which
   * has no decision of its own to carry a code) -- this is a resolution
   * attempt refused because the window to resolve it had closed.
   */
  DENY_STEP_UP_EXPIRED: "DENY_STEP_UP_EXPIRED",
  /**
   * D-75: the caller supplied a resource URL that Waysafe's fetch policy
   * refuses -- a non-permitted scheme, a hostname resolving to a private,
   * loopback, link-local or otherwise non-public address, too many
   * redirects, an oversized response, or a timeout.
   *
   * Distinct from every existing code on purpose. DENY_MERCHANT_UNRESOLVED
   * means a merchant was fetched and could not be identified;
   * DENY_ASSET_NOT_IN_REGISTRY means a requirement was fetched and named an
   * unknown token. This one means **nothing was fetched at all**, because
   * Waysafe declined to make the request. Reusing either would report a
   * fact about a response that does not exist.
   */
  DENY_RESOURCE_URL_NOT_PERMITTED: "DENY_RESOURCE_URL_NOT_PERMITTED",
  DENY_MANDATE_SUPERSEDED: "DENY_MANDATE_SUPERSEDED",
  DENY_MANDATE_NOT_AUTHENTICATED: "DENY_MANDATE_NOT_AUTHENTICATED",

  // --- DENY: actor ------------------------------------------------------
  DENY_AGENT_NOT_BOUND: "DENY_AGENT_NOT_BOUND",
  DENY_AGENT_SUSPENDED: "DENY_AGENT_SUSPENDED",
  DENY_PRINCIPAL_MISMATCH: "DENY_PRINCIPAL_MISMATCH",

  // --- DENY: the proposed action ----------------------------------------
  DENY_CURRENCY_NOT_PERMITTED: "DENY_CURRENCY_NOT_PERMITTED",
  DENY_TRANSACTION_LIMIT_EXCEEDED: "DENY_TRANSACTION_LIMIT_EXCEEDED",
  DENY_CUMULATIVE_LIMIT_EXCEEDED: "DENY_CUMULATIVE_LIMIT_EXCEEDED",
  DENY_VELOCITY_LIMIT_EXCEEDED: "DENY_VELOCITY_LIMIT_EXCEEDED",
  DENY_MERCHANT_BLOCKED: "DENY_MERCHANT_BLOCKED",
  DENY_MERCHANT_NOT_ALLOWLISTED: "DENY_MERCHANT_NOT_ALLOWLISTED",
  DENY_CATEGORY_BLOCKED: "DENY_CATEGORY_BLOCKED",
  DENY_CATEGORY_NOT_ALLOWLISTED: "DENY_CATEGORY_NOT_ALLOWLISTED",
  DENY_OUTSIDE_TIME_WINDOW: "DENY_OUTSIDE_TIME_WINDOW",
  DENY_CONSTRAINT_NOT_SATISFIED: "DENY_CONSTRAINT_NOT_SATISFIED",

  /**
   * The agent asserted a merchant we could not resolve to a verifiable
   * identity. See merchant.ts — an unverified merchant assertion can never
   * produce ALLOW.
   */
  DENY_MERCHANT_UNRESOLVED: "DENY_MERCHANT_UNRESOLVED",

  // --- DENY: asset identity (D-68) ---------------------------------------
  /**
   * The `(chain, contract address)` pair is not in the asset registry, so
   * Waysafe cannot say what this token is or what its decimal scale is.
   * Non-negotiable #3 applied to assets: an identifier Waysafe cannot
   * independently resolve never produces ALLOW. Matching is by address,
   * never by symbol -- a hostile merchant can type "USDC".
   */
  DENY_ASSET_NOT_IN_REGISTRY: "DENY_ASSET_NOT_IN_REGISTRY",
  /**
   * The counterparty supplied a decimal scale that disagrees with the
   * registry's. A loud refusal, never a silent correction -- the same
   * pattern D-66 applies to the WebAuthn `mode` field: the claim is never
   * consulted for the decision, and disagreement is an error rather than
   * something to quietly discard.
   */
  DENY_ASSET_DECIMALS_MISMATCH: "DENY_ASSET_DECIMALS_MISMATCH",
  /**
   * The payment requirement named no asset or no network, so there is
   * nothing to resolve. Previously reached `DENY_MERCHANT_UNRESOLVED`,
   * which describes the merchant rather than the asset (D-68).
   */
  DENY_ASSET_UNSPECIFIED: "DENY_ASSET_UNSPECIFIED",

  // --- DENY: approver-mandate step-up resolution (D-62) ------------------
  /**
   * The credential resolving a step-up belongs to the same mandate that
   * produced it. The core D-59 fix: a mandate can never approve its own
   * escalation, no matter how valid its credential otherwise is.
   */
  DENY_STEP_UP_SELF_APPROVAL: "DENY_STEP_UP_SELF_APPROVAL",
  /**
   * The credential resolving a step-up is a real, valid mandate -- just
   * not one named in the principal mandate's `escalation.approvers`.
   */
  DENY_MANDATE_NOT_AN_APPROVER: "DENY_MANDATE_NOT_AN_APPROVER",
  /**
   * The approver's own `evaluate()` also returned STEP_UP for this action.
   * Approval authority is single-level (D-62): an approver can authorize
   * within its own mandate, never escalate to a further approver.
   */
  DENY_APPROVER_WOULD_ESCALATE: "DENY_APPROVER_WOULD_ESCALATE",
  /**
   * `escalation.approvers`, combined with mandates that already exist,
   * would form a cycle -- a mandate naming itself (the degenerate
   * 1-cycle) or two mandates naming each other. Rejected at mandate
   * creation, not at step-up resolution (D-62). Cycles of three or more
   * are not caught here -- see DECISIONS.md D-62 and THREAT-MODEL.md for
   * why that's a deliberate, bounded gap rather than an oversight.
   */
  DENY_APPROVER_CYCLE: "DENY_APPROVER_CYCLE",

  // --- STEP_UP ----------------------------------------------------------
  STEP_UP_AMOUNT_THRESHOLD: "STEP_UP_AMOUNT_THRESHOLD",
  STEP_UP_CUMULATIVE_THRESHOLD: "STEP_UP_CUMULATIVE_THRESHOLD",
  STEP_UP_MERCHANT_NOT_ALLOWLISTED: "STEP_UP_MERCHANT_NOT_ALLOWLISTED",
  STEP_UP_CATEGORY_NOT_ALLOWLISTED: "STEP_UP_CATEGORY_NOT_ALLOWLISTED",
  STEP_UP_MERCHANT_UNVERIFIED: "STEP_UP_MERCHANT_UNVERIFIED",
  STEP_UP_FIRST_TIME_MERCHANT: "STEP_UP_FIRST_TIME_MERCHANT",
  STEP_UP_MANDATE_REQUIRES_REAUTH: "STEP_UP_MANDATE_REQUIRES_REAUTH",
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

/** Which decision each code belongs to. Used to assert engine self-consistency. */
export function decisionForReasonCode(code: ReasonCode): Decision {
  if (code.startsWith("ALLOW_")) return Decision.ALLOW;
  if (code.startsWith("DENY_")) return Decision.DENY;
  return Decision.STEP_UP;
}

/**
 * Operator- and end-user-facing prose. The dashboard renders these; SDK
 * consumers should branch on the code, not this string.
 */
export const REASON_CODE_DESCRIPTIONS: Record<ReasonCode, string> = {
  ALLOW_WITHIN_MANDATE: "The action is within the delegated authority.",
  DENY_NO_ACTIVE_MANDATE:
    "No active mandate delegates this authority to this agent.",
  DENY_MANDATE_EXPIRED: "The mandate has expired.",
  DENY_MANDATE_REVOKED: "The mandate was revoked by the principal.",
  DENY_STEP_UP_EXPIRED:
    "The step-up's time limit had already passed, so it can no longer be approved.",
  DENY_RESOURCE_URL_NOT_PERMITTED:
    "Waysafe refused to fetch the resource URL supplied, so no payment requirement was ever read.",
  DENY_MANDATE_SUPERSEDED:
    "The mandate version referenced has been replaced by a newer version.",
  DENY_MANDATE_NOT_AUTHENTICATED:
    "The mandate was never authenticated by the principal.",
  DENY_AGENT_NOT_BOUND: "This agent is not bound to the mandate.",
  DENY_AGENT_SUSPENDED: "This agent is suspended.",
  DENY_PRINCIPAL_MISMATCH:
    "The mandate belongs to a different principal than the one named.",
  DENY_CURRENCY_NOT_PERMITTED: "The mandate does not permit this currency.",
  DENY_TRANSACTION_LIMIT_EXCEEDED:
    "The amount exceeds the per-transaction limit.",
  DENY_CUMULATIVE_LIMIT_EXCEEDED:
    "The amount would exceed a cumulative spending limit.",
  DENY_VELOCITY_LIMIT_EXCEEDED:
    "The action would exceed a transaction-count limit.",
  DENY_MERCHANT_BLOCKED: "The merchant is explicitly blocked by the mandate.",
  DENY_MERCHANT_NOT_ALLOWLISTED:
    "The merchant is not on the mandate's allowlist.",
  DENY_CATEGORY_BLOCKED: "The category is explicitly blocked by the mandate.",
  DENY_CATEGORY_NOT_ALLOWLISTED:
    "The category is not on the mandate's allowlist.",
  DENY_OUTSIDE_TIME_WINDOW:
    "The action falls outside the mandate's permitted time window.",
  DENY_CONSTRAINT_NOT_SATISFIED:
    "A required constraint of the mandate is not satisfied by this action.",
  DENY_MERCHANT_UNRESOLVED:
    "The merchant could not be resolved to a verifiable identity.",
  DENY_ASSET_NOT_IN_REGISTRY:
    "The payment's asset is not a token this deployment recognizes, so its value cannot be determined.",
  DENY_ASSET_DECIMALS_MISMATCH:
    "The payment requirement's declared decimals disagree with the registered asset's.",
  DENY_ASSET_UNSPECIFIED:
    "The payment requirement did not name an asset and network that could be resolved.",
  DENY_STEP_UP_SELF_APPROVAL:
    "A mandate cannot resolve its own step-up; the resolving credential must belong to a different, authorized approver mandate.",
  DENY_MANDATE_NOT_AN_APPROVER:
    "This mandate is not named in the principal mandate's list of approvers.",
  DENY_APPROVER_WOULD_ESCALATE:
    "The approver's own policy also requires escalation for this action; approval authority is single-level and cannot chain to a further approver.",
  DENY_APPROVER_CYCLE:
    "This mandate's approvers would form a cycle with a mandate that already exists.",
  STEP_UP_AMOUNT_THRESHOLD:
    "The amount is above the mandate's step-up threshold.",
  STEP_UP_CUMULATIVE_THRESHOLD:
    "Cumulative spend is above the mandate's step-up threshold.",
  STEP_UP_MERCHANT_NOT_ALLOWLISTED:
    "The merchant is not on the allowlist and the mandate requires approval for unlisted merchants.",
  STEP_UP_CATEGORY_NOT_ALLOWLISTED:
    "The category is not on the allowlist and the mandate requires approval for unlisted categories.",
  STEP_UP_MERCHANT_UNVERIFIED:
    "The merchant identity was asserted but not verified, so human approval is required.",
  STEP_UP_FIRST_TIME_MERCHANT:
    "This is the first transaction with this merchant under this mandate.",
  STEP_UP_MANDATE_REQUIRES_REAUTH:
    "The mandate requires re-authentication before further actions.",
};

export interface Reason {
  code: ReasonCode;
  /** Human-readable explanation, specific to this evaluation. */
  message: string;
  /** The policy field that produced this reason, as a JSON pointer. */
  policy_path?: string;
  /** Structured detail — limits, observed values — for the receipt. */
  detail?: Record<string, unknown>;
}
