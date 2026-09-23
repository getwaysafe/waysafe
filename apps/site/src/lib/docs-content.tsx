import proof from "@/data/proof.json";
import { CopyButton } from "@/components/CopyButton";

export const METHODS: {
  name: string;
  signature: string;
  description: string;
  throws: string;
}[] = [
  {
    name: "compileMandate",
    signature: "compileMandate(request: CompileMandateRequest): Promise<CompileMandateResponse>",
    description:
      "Compiles a natural-language instruction into a policy. Does not create a mandate — a compiled result must be shown to the principal and authenticated before it can authorize anything.",
    throws: "ValidationError, NetworkError, UnauthorizedError",
  },
  {
    name: "createPrincipal",
    signature: "createPrincipal(request: CreatePrincipalRequest): Promise<PrincipalDetail>",
    description: "Registers the person (or org) a mandate delegates authority over.",
    throws: "ValidationError, UnauthorizedError, NetworkError",
  },
  {
    name: "getPrincipal",
    signature: "getPrincipal(principalId: string): Promise<PrincipalDetail>",
    description: "Fetches a principal by id.",
    throws: "NotFoundError, UnauthorizedError, NetworkError",
  },
  {
    name: "createMandate",
    signature: "createMandate(request: CreateMandateRequest): Promise<CreatedMandate>",
    description:
      "Persists a compiled, confirmed policy as a mandate, status PENDING_AUTHENTICATION. Not usable by authorize() until the principal authenticates it.",
    throws: "ValidationError, NotFoundError, NetworkError",
  },
  {
    name: "getMandate",
    signature: "getMandate(mandateId: string): Promise<MandateDetail>",
    description: "Fetches the full mandate: policy, intent text, assumptions, and bound agents.",
    throws: "NotFoundError, NetworkError",
  },
  {
    name: "listMandates",
    signature: "listMandates(options?: { limit?: number }): Promise<MandateListItem[]>",
    description: "Lists mandates in your organization, most-recent-first.",
    throws: "UnauthorizedError, NetworkError",
  },
  {
    name: "getInstrument",
    signature: "getInstrument(instrumentId: string): Promise<InstrumentDetail>",
    description:
      "Fetches a rail-specific spend instrument — the actor a rail-initiated decision is attributed to when actor_kind is \"instrument\".",
    throws: "NotFoundError, UnauthorizedError, NetworkError",
  },
  {
    name: "getMandateAuthenticationOptions",
    signature: "getMandateAuthenticationOptions(mandateId: string): Promise<MandateAuthenticationOptions>",
    description:
      "Returns whether the principal needs to register a first passkey or sign with one on file — hand challenge/rp_id/origin to your own frontend's WebAuthn call.",
    throws: "NotFoundError, NetworkError",
  },
  {
    name: "verifyMandateAuthentication",
    signature:
      "verifyMandateAuthentication(mandateId: string, request: VerifyMandateAuthenticationRequest): Promise<MandateAuthenticationResult>",
    description:
      "Completes the registration or authentication ceremony your frontend started. Only mode \"authenticate\" activates the mandate.",
    throws: "ValidationError, NotFoundError, NetworkError",
  },
  {
    name: "authorize",
    signature: "authorize(request: AuthorizeRequest): Promise<AuthorizationDecision>",
    description:
      "Asks whether an agent may take an action under a mandate. DENY and STEP_UP are normal return values, not errors — this only throws when the request couldn't be decided at all.",
    throws: "NoActiveMandateError, IdempotencyConflictError, ValidationError, NetworkError",
  },
  {
    name: "execute",
    signature: "execute(decision: ExecutableDecision, params: ExecuteParams): Promise<AuthorizationDecision>",
    description:
      "Executes an authorized action against a payment rail. Only accepts what asExecutable() returns — a DENIED or still-pending decision can't be passed here even by mistake.",
    throws: "ExecutionRejectedError, UnknownRailError, AuthorizationStatusConflictError, NetworkError",
  },
  {
    name: "verify",
    signature: "verify(authorizationId: string): Promise<AuthorizationDecision>",
    description: "Fetches the current state of an authorization — the receipt.",
    throws: "NotFoundError, NetworkError",
  },
  {
    name: "resolveStepUp",
    signature:
      "resolveStepUp(authorizationId: string, approver: { agentId: string; principalId: string; mandateId?: string; idempotencyKey?: string }): Promise<AuthorizationDecision>",
    description:
      "Resolves a needs-higher-authority step-up as an approver mandate (D-62). Never a bare approve/decline flag — the real evaluate() engine runs against the approver's own policy. ALLOW resolves to STEP_UP_APPROVED; DENY or STEP_UP resolves to STEP_UP_DECLINED. Already resolved or expired: replays the recorded outcome, never re-evaluates.",
    throws: "StepUpResolutionRejectedError, AuthorizationStatusConflictError, NetworkError",
  },
  {
    name: "listAuthorizations",
    signature: "listAuthorizations(options?: { limit?: number }): Promise<AuthorizationDecision[]>",
    description: "Lists authorizations in your organization, most-recent-first.",
    throws: "UnauthorizedError, NetworkError",
  },
  {
    name: "listReasonCodes",
    signature: "listReasonCodes(): Promise<{ code: ReasonCode; description: string }[]>",
    description: "Returns the reason-code dictionary with operator-facing prose. Branch on the code, not this text.",
    throws: "UnauthorizedError, NetworkError",
  },
  {
    name: "createAgent",
    signature: "createAgent(request: CreateAgentRequest): Promise<CreatedAgent>",
    description: "Registers an agent.",
    throws: "ValidationError, UnauthorizedError, NetworkError",
  },
  {
    name: "listAgents",
    signature: "listAgents(): Promise<AgentSummary[]>",
    description: "Lists agents in your organization.",
    throws: "UnauthorizedError, NetworkError",
  },
  {
    name: "createAgentKey",
    signature: "createAgentKey(agentId: string, request: { name: string }): Promise<CreatedAgentKey>",
    description:
      "Mints an agent API key. The full key is shown exactly once in this return value — it is never retrievable again.",
    throws: "NotFoundError, ValidationError, NetworkError",
  },
  {
    name: "listKeys",
    signature: "listKeys(): Promise<AgentKeySummary[]>",
    description: "Lists every key in your organization — agent keys and org credentials alike, never the full key.",
    throws: "UnauthorizedError, NetworkError",
  },
  {
    name: "listEvidence",
    signature: "listEvidence(options?: { subject?: string }): Promise<EvidenceRecord[]>",
    description: "Fetches the evidence chain for your organization, optionally filtered to one subject.",
    throws: "UnauthorizedError, NetworkError",
  },
  {
    name: "getEvidencePublicKey",
    signature: "getEvidencePublicKey(): Promise<EvidencePublicKey>",
    description:
      "The Ed25519 public key every evidence event's signature is checked against. No credential required — a third party auditing a receipt has none. Pin this value once verified out-of-band.",
    throws: "NetworkError",
  },
  {
    name: "verifyEvidenceChain",
    signature: "verifyEvidenceChain(): Promise<ChainVerificationResult>",
    description:
      "Asks the server to verify its own chain — hash consistency plus every signature. A convenience call that still trusts the server's own judgment.",
    throws: "UnauthorizedError, NetworkError",
  },
  {
    name: "asExecutable",
    signature: "asExecutable(decision: AuthorizationDecision): ExecutableDecision | null",
    description:
      "The only constructor for ExecutableDecision. Returns null for any status other than AUTHORIZED or STEP_UP_APPROVED — passing a DENIED decision to execute() is a compile error, not a runtime check.",
    throws: "Never throws.",
  },
  {
    name: "verifyEvidenceIndependently",
    signature: "verifyEvidenceIndependently(events: EvidenceRecord[], publicKeyBase64: string): ChainVerificationResult",
    description:
      "Verifies a chain's hash consistency and every signature locally — no network call, no trust in this server's own judgment. Runs on events from listEvidence() and the key from getEvidencePublicKey().",
    throws: "Throws if publicKeyBase64 is not a valid Ed25519 SPKI key.",
  },
];

export const REASON_CODES: { code: string; decision: "ALLOW" | "DENY" | "STEP_UP"; description: string }[] = [
  { code: "ALLOW_WITHIN_MANDATE", decision: "ALLOW", description: "The action is within the delegated authority." },
  {
    code: "DENY_NO_ACTIVE_MANDATE",
    decision: "DENY",
    description: "No active mandate delegates this authority to this agent.",
  },
  { code: "DENY_MANDATE_EXPIRED", decision: "DENY", description: "The mandate has expired." },
  { code: "DENY_MANDATE_REVOKED", decision: "DENY", description: "The mandate was revoked by the principal." },
  {
    code: "DENY_MANDATE_SUPERSEDED",
    decision: "DENY",
    description: "The mandate version referenced has been replaced by a newer version.",
  },
  {
    code: "DENY_MANDATE_NOT_AUTHENTICATED",
    decision: "DENY",
    description: "The mandate was never authenticated by the principal.",
  },
  { code: "DENY_AGENT_NOT_BOUND", decision: "DENY", description: "This agent is not bound to the mandate." },
  { code: "DENY_AGENT_SUSPENDED", decision: "DENY", description: "This agent is suspended." },
  {
    code: "DENY_PRINCIPAL_MISMATCH",
    decision: "DENY",
    description: "The mandate belongs to a different principal than the one named.",
  },
  {
    code: "DENY_CURRENCY_NOT_PERMITTED",
    decision: "DENY",
    description: "The mandate does not permit this currency.",
  },
  {
    code: "DENY_TRANSACTION_LIMIT_EXCEEDED",
    decision: "DENY",
    description: "The amount exceeds the per-transaction limit.",
  },
  {
    code: "DENY_CUMULATIVE_LIMIT_EXCEEDED",
    decision: "DENY",
    description: "The amount would exceed a cumulative spending limit.",
  },
  {
    code: "DENY_VELOCITY_LIMIT_EXCEEDED",
    decision: "DENY",
    description: "The action would exceed a transaction-count limit.",
  },
  {
    code: "DENY_MERCHANT_BLOCKED",
    decision: "DENY",
    description: "The merchant is explicitly blocked by the mandate.",
  },
  {
    code: "DENY_MERCHANT_NOT_ALLOWLISTED",
    decision: "DENY",
    description: "The merchant is not on the mandate's allowlist.",
  },
  {
    code: "DENY_CATEGORY_BLOCKED",
    decision: "DENY",
    description: "The category is explicitly blocked by the mandate.",
  },
  {
    code: "DENY_CATEGORY_NOT_ALLOWLISTED",
    decision: "DENY",
    description: "The category is not on the mandate's allowlist.",
  },
  {
    code: "DENY_OUTSIDE_TIME_WINDOW",
    decision: "DENY",
    description: "The action falls outside the mandate's permitted time window.",
  },
  {
    code: "DENY_CONSTRAINT_NOT_SATISFIED",
    decision: "DENY",
    description: "A required constraint of the mandate is not satisfied by this action.",
  },
  {
    code: "DENY_MERCHANT_UNRESOLVED",
    decision: "DENY",
    description: "The merchant could not be resolved to a verifiable identity.",
  },
  {
    code: "DENY_STEP_UP_SELF_APPROVAL",
    decision: "DENY",
    description:
      "A mandate cannot resolve its own step-up; the resolving credential must belong to a different, authorized approver mandate.",
  },
  {
    code: "DENY_MANDATE_NOT_AN_APPROVER",
    decision: "DENY",
    description: "This mandate is not named in the principal mandate's list of approvers.",
  },
  {
    code: "DENY_APPROVER_WOULD_ESCALATE",
    decision: "DENY",
    description:
      "The approver's own policy also requires escalation for this action; approval authority is single-level and cannot chain to a further approver.",
  },
  {
    code: "DENY_APPROVER_CYCLE",
    decision: "DENY",
    description: "This mandate's approvers would form a cycle with a mandate that already exists.",
  },
  {
    code: "STEP_UP_AMOUNT_THRESHOLD",
    decision: "STEP_UP",
    description: "The amount is above the mandate's step-up threshold.",
  },
  {
    code: "STEP_UP_CUMULATIVE_THRESHOLD",
    decision: "STEP_UP",
    description: "Cumulative spend is above the mandate's step-up threshold.",
  },
  {
    code: "STEP_UP_MERCHANT_NOT_ALLOWLISTED",
    decision: "STEP_UP",
    description: "The merchant is not on the allowlist and the mandate requires approval for unlisted merchants.",
  },
  {
    code: "STEP_UP_CATEGORY_NOT_ALLOWLISTED",
    decision: "STEP_UP",
    description: "The category is not on the allowlist and the mandate requires approval for unlisted categories.",
  },
  {
    code: "STEP_UP_MERCHANT_UNVERIFIED",
    decision: "STEP_UP",
    description: "The merchant identity was asserted but not verified, so human approval is required.",
  },
  {
    code: "STEP_UP_FIRST_TIME_MERCHANT",
    decision: "STEP_UP",
    description: "This is the first transaction with this merchant under this mandate.",
  },
  {
    code: "STEP_UP_MANDATE_REQUIRES_REAUTH",
    decision: "STEP_UP",
    description: "The mandate requires re-authentication before further actions.",
  },
];

export function DecisionBadge({ decision }: { decision: "ALLOW" | "DENY" | "STEP_UP" }) {
  const cls = decision === "ALLOW" ? "badge-allow" : decision === "DENY" ? "badge-deny" : "badge-step-up";
  return <span className={`badge ${cls}`}>{decision}</span>;
}

// --- Policy Schema Reference -------------------------------------------------
//
// Verified directly against packages/core/src/policy.ts, engine/evaluate.ts,
// engine/types.ts, merchant.ts, money.ts, and reason-codes.ts -- not inferred
// from the PRD. IMPLEMENTED means evaluate() (or a function it calls) actually
// reads and enforces this field today, cited against the exact function.
// SPECIFIED means the schema defines it but nothing in the engine enforces it
// yet. RESERVED means a name exists in code (an enum member, a reason code) to
// prevent a future collision, with no behavior behind it yet. A field with no
// row in its dimension's table, or listed as "not in schema", has none of the
// three -- it was checked for directly and does not exist, at any status.

export type FieldStatus = "IMPLEMENTED" | "SPECIFIED" | "RESERVED";

export function StatusBadge({ status }: { status: FieldStatus }) {
  const style =
    status === "IMPLEMENTED"
      ? { background: "var(--teal)", color: "#fff" }
      : status === "SPECIFIED"
        ? { color: "var(--slate)", border: "1px solid var(--slate)" }
        : { color: "#a66a00", border: "1px solid #e0a83f" };
  return (
    <span className="badge" style={{ ...style, fontSize: "0.72rem" }}>
      {status}
    </span>
  );
}

export interface PolicyFieldRow {
  field: string;
  type: string;
  status: FieldStatus | "not in schema";
  reasonCode: string;
  semantics: string;
}

export function PolicyFieldTable({ rows }: { rows: PolicyFieldRow[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th style={{ width: "20%" }}>Field</th>
            <th style={{ width: "16%" }}>Type</th>
            <th style={{ width: "13%" }}>Status</th>
            <th style={{ width: "20%" }}>Reason code</th>
            <th>Semantics</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.field}>
              <td>
                <code style={{ fontSize: "0.8rem" }}>{r.field}</code>
              </td>
              <td className="muted" style={{ fontSize: "0.82rem" }}>
                {r.type}
              </td>
              <td>
                {r.status === "not in schema" ? (
                  <span className="muted mono" style={{ fontSize: "0.75rem" }}>
                    not in schema
                  </span>
                ) : (
                  <StatusBadge status={r.status} />
                )}
              </td>
              <td className="mono muted" style={{ fontSize: "0.78rem" }}>
                {r.reasonCode}
              </td>
              <td style={{ fontSize: "0.92rem" }}>{r.semantics}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const AMOUNT_FIELDS: PolicyFieldRow[] = [
  {
    field: "per_transaction_max",
    type: "integer minor units, optional",
    status: "IMPLEMENTED",
    reasonCode: "DENY_TRANSACTION_LIMIT_EXCEEDED",
    semantics: "Single-transaction ceiling. See Invariant 1 for what omitting it means.",
  },
  {
    field: "cumulative_limits[].max_amount (window: day | week | month)",
    type: "integer minor units",
    status: "IMPLEMENTED",
    reasonCode: "DENY_CUMULATIVE_LIMIT_EXCEEDED",
    semantics: "Cumulative spend ceiling within one fixed calendar window. evaluateLimits().",
  },
  {
    field: "cumulative_limits[].max_amount (window: mandate)",
    type: "integer minor units",
    status: "IMPLEMENTED",
    reasonCode: "DENY_CUMULATIVE_LIMIT_EXCEEDED",
    semantics: "Lifetime ceiling — \"mandate\" is a fourth window value: the entire life of the mandate, not a period that resets.",
  },
  {
    field: "per-merchant amount cap",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "cumulative_limits apply mandate-wide only; nothing scopes a limit to one merchant.",
  },
  {
    field: "per-category amount cap",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "categories.allow/deny gate identity, never amount. No amount field exists under categories.",
  },
];

export const PERIOD_FIELDS: PolicyFieldRow[] = [
  {
    field: "cumulative_limits[].window",
    type: "enum: day | week | month | mandate",
    status: "IMPLEMENTED",
    reasonCode: "(scopes DENY_CUMULATIVE_LIMIT_EXCEEDED / DENY_VELOCITY_LIMIT_EXCEEDED)",
    semantics: "A fixed calendar window in accounting.timezone — day boundary, Monday-start week, calendar month. Not a rolling window.",
  },
  {
    field: "rolling N-day window",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "No such concept anywhere in the schema or SpendSnapshot, which computes exactly day/week/month/mandate and nothing else. \"Trailing 30 days\" cannot be expressed — approximating it with \"month\" is not the same guarantee and the compiler should not be trusted to conflate them.",
  },
];

export const COUNTERPARTY_FIELDS: PolicyFieldRow[] = [
  {
    field: "merchants.allow[] (scheme: domain)",
    type: "array of { scheme, value, label? }",
    status: "IMPLEMENTED",
    reasonCode: "STEP_UP_MERCHANT_UNVERIFIED / DENY_MERCHANT_NOT_ALLOWLISTED / STEP_UP_MERCHANT_NOT_ALLOWLISTED",
    semantics: "Domain allowlist. Satisfies ALLOW only at VERIFIED trust (directory-corroborated) — an asserted-only domain match caps at STEP_UP regardless (non-negotiable #3).",
  },
  {
    field: "merchants.allow[]/deny[] (scheme: psp_account)",
    type: "array",
    status: "IMPLEMENTED",
    reasonCode: "same as domain, plus DENY_MERCHANT_BLOCKED for deny[]",
    semantics: "VERIFIED only when a payment rail's own callback supplied the value (D-34); the same value asserted by the agent on the request caps at ASSERTED, same ceiling as a bare name.",
  },
  {
    field: "merchants.allow[]/deny[] (scheme: network_mid)",
    type: "array",
    status: "IMPLEMENTED",
    reasonCode: "same as psp_account",
    semantics: "Card-network merchant ID. Same D-34 rail-vs-agent rule as psp_account.",
  },
  {
    field: "merchants.allow[]/deny[] (scheme: onchain_address)",
    type: "array",
    status: "IMPLEMENTED",
    reasonCode: "same as psp_account",
    semantics: "x402 payee address (D-40). Same D-34 rule: rail-attested verifies, agent-attested caps at ASSERTED.",
  },
  {
    field: "merchants.allow[] (scheme: name)",
    type: "array",
    status: "IMPLEMENTED",
    reasonCode: "STEP_UP_MERCHANT_UNVERIFIED",
    semantics: "Can never itself produce ALLOW: a name can never be VERIFIED (no corroboration source exists for free text), so a name-only allow entry always caps the outcome at STEP_UP.",
  },
  {
    field: "categories.deny_mcc[]",
    type: "array of 4-digit strings",
    status: "IMPLEMENTED",
    reasonCode: "DENY_CATEGORY_BLOCKED",
    semantics: "MCC is categorical, not identity (merchant.ts) — denylist only. There is no MCC allowlist; an MCC can never itself satisfy an allowlist entry.",
  },
  {
    field: "country",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "No country scheme, no country field, anywhere in MerchantScheme or MerchantAssertion.",
  },
];

export const TIME_FIELDS: PolicyFieldRow[] = [
  {
    field: "expires_at",
    type: "ISO-8601 timestamp, required",
    status: "IMPLEMENTED",
    reasonCode: "DENY_MANDATE_EXPIRED",
    semantics: "Absolute expiry instant, not a duration. A natural-language \"90 days\" is resolved to an absolute timestamp at compile time — the field itself never stores a TTL. Required: no mandate is open-ended.",
  },
  {
    field: "time_window.start_time / end_time",
    type: "\"HH:MM\", optional",
    status: "IMPLEMENTED",
    reasonCode: "DENY_OUTSIDE_TIME_WINDOW",
    semantics: "Time-of-day window in accounting.timezone. start > end wraps past midnight (e.g. 22:00–06:00).",
  },
  {
    field: "time_window.days_of_week",
    type: "array of 0–6 (0 = Sunday), optional",
    status: "IMPLEMENTED",
    reasonCode: "DENY_OUTSIDE_TIME_WINDOW",
    semantics: "Restricts which days of the week the mandate permits anything at all.",
  },
];

export const VELOCITY_FIELDS: PolicyFieldRow[] = [
  {
    field: "cumulative_limits[].max_count",
    type: "positive integer, optional",
    status: "IMPLEMENTED",
    reasonCode: "DENY_VELOCITY_LIMIT_EXCEEDED",
    semantics: "Max transaction count within the same fixed window (day/week/month/mandate) the amount limit uses.",
  },
  {
    field: "minimum interval between transactions",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "No field expresses a minimum gap between two transactions.",
  },
  {
    field: "burst ceiling (rolling window)",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "Blocked by the same gap as Period's rolling window — max_count only ever scopes to a fixed calendar window, never a rolling one.",
  },
];

export const INSTRUMENT_FIELDS: PolicyFieldRow[] = [
  {
    field: "currency",
    type: "enum, single value, required",
    status: "IMPLEMENTED",
    reasonCode: "DENY_CURRENCY_NOT_PERMITTED",
    semantics: "Exactly one currency per mandate, not a permitted set. SUPPORTED_CURRENCIES (money.ts) is USD-only today, so this can currently only ever reject a non-USD request — the enum itself has no second member to permit.",
  },
  {
    field: "permitted rails",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "Not a policy concept. Which rail executes is chosen by the caller of execute() and by which adapters are registered on the deployment — outside the policy entirely.",
  },
  {
    field: "specific cards or wallets",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "Instrument (rail, external_ref) is a separate domain entity, never referenced by Policy.",
  },
];

export const EVIDENCE_FIELDS: PolicyFieldRow[] = [
  {
    field: "(no field — hardcoded)",
    type: "n/a",
    status: "IMPLEMENTED",
    reasonCode: "STEP_UP_MERCHANT_UNVERIFIED (cap) / ALLOW_WITHIN_MANDATE (when met)",
    semantics: "Not configurable. D-34: VERIFIED trust is required for ALLOW via an identity scheme, unconditionally, for every mandate. There is no policy field to raise or lower this bar — every mandate gets the same fixed minimum trust tier. See DECISIONS.md for this session's note on documenting it as a settable field.",
  },
];

export const ESCALATION_FIELDS: PolicyFieldRow[] = [
  {
    field: "step_up.above_amount",
    type: "integer minor units, optional",
    status: "IMPLEMENTED",
    reasonCode: "STEP_UP_AMOUNT_THRESHOLD",
    semantics: "Single-transaction step-up threshold.",
  },
  {
    field: "step_up.above_cumulative",
    type: "{ window, amount }, optional",
    status: "IMPLEMENTED",
    reasonCode: "STEP_UP_CUMULATIVE_THRESHOLD",
    semantics: "Cumulative step-up threshold, same fixed-window semantics as Period.",
  },
  {
    field: "step_up.ttl_seconds",
    type: "positive integer, default 900",
    status: "IMPLEMENTED",
    reasonCode: "(governs the expiry-to-DENY path, D-31)",
    semantics: "How long a pending step-up stays open before it expires. See Invariant on expiry below.",
  },
  {
    field: "merchants.unlisted = STEP_UP",
    type: "enum value",
    status: "IMPLEMENTED",
    reasonCode: "STEP_UP_MERCHANT_NOT_ALLOWLISTED",
    semantics: "Escalates instead of denying an unlisted merchant.",
  },
  {
    field: "categories.unlisted = STEP_UP",
    type: "enum value",
    status: "IMPLEMENTED",
    reasonCode: "STEP_UP_CATEGORY_NOT_ALLOWLISTED",
    semantics: "Escalates instead of denying an unlisted category.",
  },
  {
    field: "escalation.approvers",
    type: "string[] (mandate ids), default []",
    status: "IMPLEMENTED",
    reasonCode: "DENY_STEP_UP_SELF_APPROVAL / DENY_MANDATE_NOT_AN_APPROVER",
    semantics:
      "D-62: who may resolve a needs-higher-authority step-up on this mandate. Absent or empty means unresolvable — expires to DENY (D-31). See Approver Mandates below — this closes the D-59 gap that section used to describe.",
  },
  {
    field: "an approver mandate escalating further",
    type: "—",
    status: "IMPLEMENTED",
    reasonCode: "DENY_APPROVER_WOULD_ESCALATE",
    semantics: "Single-level by design, enforced as a refusal: an approver's own STEP_UP declines the resolution rather than chaining to a further approver.",
  },
  {
    field: "escalation.approvers forming a cycle",
    type: "—",
    status: "IMPLEMENTED",
    reasonCode: "DENY_APPROVER_CYCLE",
    semantics:
      "Enforced at mandate-creation time, not resolve time: a mandate naming itself, or two mandates naming each other, is rejected. Cycles of three or more are not caught here; see Approver Mandates below for the bounded-risk reasoning.",
  },
  {
    field: "mandate re-authentication requirement",
    type: "reason code exists; no policy field",
    status: "RESERVED",
    reasonCode: "STEP_UP_MANDATE_REQUIRES_REAUTH",
    semantics: "A real, permanent name in reason-codes.ts. Never emitted anywhere in evaluate() or the authorization service today — checked directly, not inferred.",
  },
];

// Commands verified against a clean clone just before writing this page:
// git clone (local path, not network) + npm install + build core/sdk +
// npm run quickstart, timed end to end, finished in ~12s on a warm npm
// cache. A first install over the real network will take longer; nothing
// in this sequence waits on a database, a compiler API key, or anything
// else external -- see D-55.
export const QUICKSTART_COMMANDS = `git clone https://github.com/getwaysafe/waysafe.git
cd waysafe
npm install
npm run build -w @waysafe/core -w @waysafe/sdk
npm run quickstart`;

// Real, unedited stdout from an actual run of examples/quickstart.ts
// (npm run quickstart), sections 1-4 -- connect, compile, create and
// authenticate a mandate, and the first decision. Section numbers are the
// script's own; nothing renumbered.
export const QUICKSTART_OUTPUT_ALLOW = `1. Connect
  started a local Waysafe API on 127.0.0.1:54400 (in-memory, no database)
  connected to http://127.0.0.1:54400

2. Compile a natural-language instruction into a policy
  summary: Spend up to $500 per calendar month on office supplies at Amazon and Staples, never more than $150 at once, with your approval required at any other merchant.
  assumption: Read 'never more than $150' as a hard limit: transactions above it are denied, not sent to you for approval. Say 'ask me before spending more than $150' if you would rather approve them.
  assumption: Mapped 'Amazon' to amazon.com and 'Staples' to staples.com.
  assumption: Blocked gambling, cash advance, crypto, adult, and firearms outright.
  assumption: Set this authority to expire in 30 days.

3. Register an agent, and create + authenticate a mandate for it
  mandate: mdt_01m2rnka6g0c8acmtq2ka9e3wv (PENDING_AUTHENTICATION)
  authenticated -- the mandate is now ACTIVE
  agent key minted: wsf_live_a463ba08...  (shown once -- store it now)

4. Ask permission for a purchase that's clearly within the mandate
  decision: ALLOW  status: AUTHORIZED
    - ALLOW_WITHIN_MANDATE: The action is within the delegated authority.`;

// Same run, section 7 -- the DENY. Sections 5-6 and 8-10 (execution, a
// step-up resolved by a real approver mandate after a rejected self-approval
// attempt (D-62), a malformed-request error, and independent evidence-chain
// verification) are elided here, not edited out of the script; run it
// yourself to see them.
export const QUICKSTART_OUTPUT_DENY = `7. A purchase over the hard cap -- DENY. This is a normal return value, not a thrown error
  decision: DENY  status: DENIED
    - DENY_TRANSACTION_LIMIT_EXCEEDED: The amount exceeds the per-transaction maximum of $150.00.
  asExecutable() on a DENY: null`;

// D-55: real, not hand-written -- pulled live from the same captured run
// /proof publishes, so this example can never drift from what's actually
// in that file.
export const EVIDENCE_EXAMPLE = proof.evidence.events.find((e) => e.type === "mandate.authenticated");

