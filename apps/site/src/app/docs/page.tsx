import type { Metadata } from "next";
import { CONTACT_EMAIL } from "@/lib/constants";
import proof from "@/data/proof.json";
import { CopyButton } from "@/components/CopyButton";

export const metadata: Metadata = {
  title: "Docs — Waysafe",
  description: "Install, quickstart, method reference, and the full reason-code dictionary.",
};

const METHODS: {
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

const REASON_CODES: { code: string; decision: "ALLOW" | "DENY" | "STEP_UP"; description: string }[] = [
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

function DecisionBadge({ decision }: { decision: "ALLOW" | "DENY" | "STEP_UP" }) {
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

type FieldStatus = "IMPLEMENTED" | "SPECIFIED" | "RESERVED";

function StatusBadge({ status }: { status: FieldStatus }) {
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

interface PolicyFieldRow {
  field: string;
  type: string;
  status: FieldStatus | "not in schema";
  reasonCode: string;
  semantics: string;
}

function PolicyFieldTable({ rows }: { rows: PolicyFieldRow[] }) {
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

const AMOUNT_FIELDS: PolicyFieldRow[] = [
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

const PERIOD_FIELDS: PolicyFieldRow[] = [
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

const COUNTERPARTY_FIELDS: PolicyFieldRow[] = [
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

const TIME_FIELDS: PolicyFieldRow[] = [
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

const VELOCITY_FIELDS: PolicyFieldRow[] = [
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

const INSTRUMENT_FIELDS: PolicyFieldRow[] = [
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

const EVIDENCE_FIELDS: PolicyFieldRow[] = [
  {
    field: "(no field — hardcoded)",
    type: "n/a",
    status: "IMPLEMENTED",
    reasonCode: "STEP_UP_MERCHANT_UNVERIFIED (cap) / ALLOW_WITHIN_MANDATE (when met)",
    semantics: "Not configurable. D-34: VERIFIED trust is required for ALLOW via an identity scheme, unconditionally, for every mandate. There is no policy field to raise or lower this bar — every mandate gets the same fixed minimum trust tier. See DECISIONS.md for this session's note on documenting it as a settable field.",
  },
];

const ESCALATION_FIELDS: PolicyFieldRow[] = [
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
    field: "who may approve",
    type: "—",
    status: "not in schema",
    reasonCode: "—",
    semantics: "No approver concept anywhere in Policy. See Approver Mandates below — and the D-59 gap it names.",
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
const QUICKSTART_COMMANDS = `git clone https://github.com/getwaysafe/waysafe.git
cd waysafe
npm install
npm run build -w @waysafe/core -w @waysafe/sdk
npm run quickstart`;

// Real, unedited stdout from an actual run of examples/quickstart.ts
// (npm run quickstart), sections 1-4 -- connect, compile, create and
// authenticate a mandate, and the first decision. Section numbers are the
// script's own; nothing renumbered.
const QUICKSTART_OUTPUT_ALLOW = `1. Connect
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
// step-up you approve yourself, a malformed-request error, and independent
// evidence-chain verification) are elided here, not edited out of the
// script; run it yourself to see them.
const QUICKSTART_OUTPUT_DENY = `7. A purchase over the hard cap -- DENY. This is a normal return value, not a thrown error
  decision: DENY  status: DENIED
    - DENY_TRANSACTION_LIMIT_EXCEEDED: The amount exceeds the per-transaction maximum of $150.00.
  asExecutable() on a DENY: null`;

// D-55: real, not hand-written -- pulled live from the same captured run
// /proof publishes, so this example can never drift from what's actually
// in that file.
const EVIDENCE_EXAMPLE = proof.evidence.events.find((e) => e.type === "mandate.authenticated");

export default function DocsPage() {
  return (
    <div className="section-light section">
      <div className="container">
        <p className="kicker">Docs</p>
        <h1 className="display" style={{ fontSize: "clamp(1.8rem, 4vw, 2.6rem)", marginTop: 8 }}>
          @waysafe/sdk
        </h1>
        <p style={{ fontSize: "1.05rem", maxWidth: 700, lineHeight: 1.7 }}>
          A thin, typed HTTP client. Every method here is a direct wrapper around one REST call —
          nothing here is a framework, a UI, or a required flow.
        </p>

        <h2 style={{ marginTop: 48 }}>Quickstart</h2>
        <p style={{ maxWidth: 700 }}>
          There&rsquo;s no hosted API yet — email{" "}
          <a className="link" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>{" "}
          for repo access. Once you have it, this is the fastest path to a real decision: not a
          mock, the actual <code>evaluate()</code> engine, running locally. In-memory, not a
          database — <code>packages/db</code>&rsquo;s schema uses native Postgres enums,{" "}
          <code>String[]</code> columns, and (the disqualifying one) real{" "}
          <code>SELECT ... FOR UPDATE</code> row locking that D-4&rsquo;s cumulative-spend
          guarantee depends on, none of which SQLite can express — so the in-memory adapter
          already built for <code>npm test</code> is the honest zero-setup path, not a shortcut
          around it. Verified from a clean clone just before writing this page, ~13.5 seconds
          end to end on a warm npm cache (a first install over the real network will take
          longer; nothing here waits on a database or a compiler API key):
        </p>
        <pre>{QUICKSTART_COMMANDS}</pre>
        <p style={{ maxWidth: 700 }}>
          The build step is real, not optional — <code>dist/</code> is gitignored, so a clean
          clone has no <code>@waysafe/sdk</code> to import until it&rsquo;s built. Real,
          unedited output from that run, sections 1–4 (connect, compile, create and authenticate
          a mandate, and the first decision — an <strong>ALLOW</strong>, from the real engine):
        </p>
        <pre>{QUICKSTART_OUTPUT_ALLOW}</pre>
        <p style={{ maxWidth: 700 }}>Same run, same mandate, a purchase over the hard cap:</p>
        <pre>{QUICKSTART_OUTPUT_DENY}</pre>
        <p style={{ maxWidth: 700 }}>
          Sections 5–6 and 8–10 of the same run (execution, a step-up you approve yourself, a
          typed SDK error, and independently verifying the signed evidence chain) are elided
          here for density — run <code>npm run quickstart</code> yourself to see them, or read{" "}
          <code>examples/quickstart.ts</code> directly.
        </p>

        <h2 style={{ marginTop: 56 }}>Concepts</h2>
        <p style={{ maxWidth: 700 }}>
          Four objects, in the order they come into existence. Skip this if you just ran the
          quickstart above — you already saw all four.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Mandate.</strong> A stable handle: which principal, and a lifecycle status
          (<code>PENDING_AUTHENTICATION</code>, <code>ACTIVE</code>, <code>EXPIRED</code>,{" "}
          <code>REVOKED</code>, <code>SUPERSEDED</code>). It carries no policy of its own.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Mandate version.</strong> The actual policy — immutable once written: the
          compiled policy, the original instruction text, a SHA-256 <code>policy_hash</code>,
          and the agents it delegates to. A Mandate points at one current version. Authenticated
          once by the principal over WebAuthn; editing writes a new version rather than mutating
          this one, so an authorization can always cite the exact bytes it was decided against,
          even after the mandate changes.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Authorization.</strong> One decision: <code>evaluate()</code> run against a
          specific mandate version&rsquo;s policy for one proposed action, at one instant. Cites
          that <code>mandate_version_id</code> and <code>policy_hash</code> directly. Always
          exactly one of <code>ALLOW</code>, <code>DENY</code>, or <code>STEP_UP</code>.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Evidence entry.</strong> One append-only, hash-chained, signed log row
          recording that something happened — a mandate version authenticated, a decision made.
          Real example, from the same captured run <code>/proof</code> publishes:
        </p>
        {EVIDENCE_EXAMPLE && (
          <div style={{ position: "relative" }}>
            <CopyButton text={JSON.stringify(EVIDENCE_EXAMPLE, null, 2)} />
            <pre>{JSON.stringify(EVIDENCE_EXAMPLE, null, 2)}</pre>
          </div>
        )}

        <h2 style={{ marginTop: 56 }}>Install and instantiate</h2>
        <p style={{ maxWidth: 700 }}>
          Once you have a real deployment (email{" "}
          <a className="link" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>{" "}
          for access — not yet on npm):
        </p>
        <pre>{`npm install @waysafe/sdk

import { Waysafe } from "@waysafe/sdk";

const waysafe = new Waysafe({
  baseUrl: "https://api.your-waysafe-deployment.example",
  apiKey: process.env.WAYSAFE_API_KEY, // an org or agent credential
});`}</pre>

        <h2 style={{ marginTop: 56 }}>Method reference</h2>
        <p style={{ maxWidth: 700 }}>
          The public surface of <code>@waysafe/sdk</code>. For the full request/response shapes on
          the calls that decide whether money moves, see the raw REST reference below.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: "34%" }}>Method</th>
                <th style={{ width: "38%" }}>Description</th>
                <th>Throws</th>
              </tr>
            </thead>
            <tbody>
              {METHODS.map((m) => (
                <tr key={m.name}>
                  <td>
                    <code style={{ fontSize: "0.82rem" }}>{m.signature}</code>
                  </td>
                  <td>{m.description}</td>
                  <td className="mono muted" style={{ fontSize: "0.8rem" }}>
                    {m.throws}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 style={{ marginTop: 56 }}>Raw REST reference</h2>
        <p style={{ maxWidth: 700 }}>
          The SDK is a thin wrapper — this is the wire format underneath, for the two calls that
          decide whether money moves. Shapes below are transcribed from{" "}
          <code>apps/api/src/server.ts</code> and <code>packages/core/src/domain.ts</code>.
        </p>

        <h3 style={{ marginTop: 40 }}>
          <code>POST /v1/authorizations</code>
        </h3>
        <p style={{ maxWidth: 700 }}>Request body:</p>
        <pre>{`{
  "agent_id": "agt_...",
  "principal_id": "prin_...",
  "mandate_id": "mdt_...",            // optional -- pins evaluation to one mandate
  "action": {
    "amount": 4200,                    // integer minor units -- $42.00, never a float
    "currency": "USD",
    "merchant": {
      "name": "Staples",               // agent's own claims -- optional, any/all of these
      "domain": "staples.com",
      "psp_account": "acct_...",
      "network_mid": "...",
      "mcc": "5943",
      "onchain_address": "0x..."
    },
    "category": "office_supplies",     // optional
    "description": "Copier paper, 10 reams",  // optional, shown on the receipt
    "attestations": {}                 // optional agent claims, evaluated as claims not facts
  },
  "idempotency_key": "a-client-generated-key-8-255-chars",  // optional, required in production
  "context": {}                        // optional, arbitrary caller context recorded on the receipt
}`}</pre>
        <p style={{ maxWidth: 700 }}>
          <code>merchant</code> carries only what the agent asserts on this call. Which field a
          value sits in never upgrades its trust — a rail-attested <code>psp_account</code> or{" "}
          <code>network_mid</code> (one the payment rail&rsquo;s own callback supplied, not one the
          agent typed here) verifies; the same field asserted directly on this request caps out at{" "}
          <code>STEP_UP</code>, exactly like an unverified <code>name</code>.
        </p>
        <p style={{ maxWidth: 700 }}>
          Response status: <code>201</code> on a fresh decision, <code>200</code> if{" "}
          <code>idempotency_key</code> matches a prior request and the stored result is replayed,{" "}
          <code>404</code> (<code>{`{"error":"no_active_mandate"}`}</code>) if no active mandate
          covers this request, <code>409</code> (
          <code>{`{"error":"idempotency_conflict"}`}</code>) if the same key was reused with a
          different body.
        </p>
        <p style={{ maxWidth: 700 }}>The three decision shapes, all the same receipt envelope:</p>
        <pre>{`// decision: "ALLOW"
{
  "id": "auth_...",
  "actor_kind": "agent",               // or "instrument" for a rail-initiated decision
  "agent_id": "agt_...",
  "instrument_id": null,
  "principal_id": "prin_...",
  "mandate_id": "mdt_...",
  "mandate_version_id": "mdv_...",
  "policy_hash": "...",
  "decision": "ALLOW",
  "status": "AUTHORIZED",
  "reasons": [{ "code": "ALLOW_WITHIN_MANDATE", "message": "..." }],
  "action": { /* echoes the request's action */ },
  "merchant": { /* the engine's resolved view -- trust level, refs */ },
  "idempotency_key": "...",
  "step_up_expires_at": null,
  "created_at": "2026-09-16T03:14:03.431Z",
  "decided_at": "2026-09-16T03:14:03.431Z"
}

// decision: "DENY" -- same envelope, status: "DENIED".
// reasons can carry more than one code: a request can violate several
// constraints at once (e.g. an unlisted merchant AND over the per-
// transaction limit), and every one that applies is returned, not just
// the first.
"reasons": [
  { "code": "DENY_MERCHANT_NOT_ALLOWLISTED", "message": "..." },
  { "code": "DENY_TRANSACTION_LIMIT_EXCEEDED", "message": "..." }
]

// decision: "STEP_UP" -- status: "PENDING_STEP_UP", step_up_expires_at
// set. Resolved at POST /v1/authorizations/:id/step-up (approve/decline);
// approving does not execute -- POST .../execute is the separate step.
"status": "PENDING_STEP_UP",
"step_up_expires_at": "2026-09-16T03:29:03.431Z"`}</pre>

        <h3 style={{ marginTop: 40 }}>
          <code>POST /v1/mandates/compile</code>
        </h3>
        <p style={{ maxWidth: 700 }}>Request body:</p>
        <pre>{`{
  "intent_text": "Spend up to $500/month on office supplies from Amazon or Staples.",
  "timezone": "America/New_York",      // optional, defaults from the environment
  "currency": "USD",                   // optional
  "default_ttl_hours": 720             // optional
}`}</pre>
        <p style={{ maxWidth: 700 }}>
          Three response shapes, all HTTP <code>200</code> except <code>failed</code>:
        </p>
        <pre>{`// status: "compiled"
{ "status": "compiled", "policy": { /* ... */ }, "policy_hash": "...",
  "confirmation": { /* ... */ }, "diagnostics": { "compiler": "...", "attempts": 1, "duration_ms": 812 } }

// status: "needs_clarification" -- HTTP 200, not an error. Asking is a
// valid, expected outcome: the compiler never invents a spending ceiling
// the principal didn't state (non-negotiable #8).
{ "status": "needs_clarification",
  "clarifications": [
    { "path": "/limits/per_transaction", "question": "What's the most this can spend in one transaction?",
      "suggested_default": 15000, "rationale": "The instruction gave a monthly cap but no per-transaction limit." }
  ],
  "draft": { /* best-effort partial policy */ }, "diagnostics": { /* ... */ } }

// status: "failed" -- HTTP 422, the only error status of the three.
{ "status": "failed", "error": "policy_compilation_failed", "issues": [ /* ... */ ], "diagnostics": { /* ... */ } }`}</pre>

        <h3 style={{ marginTop: 40 }}>
          <code>GET /v1/evidence/public-key</code>
        </h3>
        <p style={{ maxWidth: 700 }}>
          No credential required — a third party auditing a receipt has none. One signing key
          covers every organization on a given deployment, so there&rsquo;s one key to publish,
          not one per tenant. Pin this value once verified out-of-band; a server that could change
          it at will could sign anything.
        </p>
        <pre>{`{ "algorithm": "Ed25519", "public_key": "MCowBQYDK2VwAyEA..." }`}</pre>
        <p style={{ maxWidth: 700 }}>
          Pair with <code>GET /v1/evidence</code> (returns the same <code>EvidenceRecord[]</code>{" "}
          shape <code>listEvidence()</code> does) and{" "}
          <code>verifyEvidenceIndependently</code> — or its self-contained <code>node:crypto</code>{" "}
          equivalent — to verify locally, with zero trust in the server that produced the data. See{" "}
          <a className="link" href="/proof">
            /proof
          </a>{" "}
          for a worked example against one real captured run.
        </p>

        <h2 style={{ marginTop: 56 }}>Reason codes</h2>
        <p style={{ maxWidth: 700 }}>
          A public API (additive-only, never renamed) — every decision carries at least one of
          these. Branch on the code, not the description. Source:{" "}
          <code>packages/core/src/reason-codes.ts</code>.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: "14%" }}>Decision</th>
                <th style={{ width: "36%" }}>Code</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {REASON_CODES.map((r) => (
                <tr key={r.code}>
                  <td>
                    <DecisionBadge decision={r.decision} />
                  </td>
                  <td>
                    <code style={{ fontSize: "0.82rem" }}>{r.code}</code>
                  </td>
                  <td>{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 style={{ marginTop: 56 }}>Policy Schema Reference</h2>
        <div className="card" style={{ marginTop: 8, marginBottom: 24, background: "#fff8e1", borderColor: "#f0c96b" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            This documents a field space, much of which is not implemented.
          </p>
          <p style={{ margin: "8px 0 0" }}>
            Every field below carries one of three statuses, verified directly against{" "}
            <code>packages/core</code> — not inferred from the PRD, not assumed from the field
            existing in a type. <strong>IMPLEMENTED</strong> means the engine enforces it today,
            cited against the exact function and reason code.{" "}
            <strong>SPECIFIED</strong> means the schema defines it but nothing enforces it yet.{" "}
            <strong>RESERVED</strong> means a name exists in code (an enum member, a reason code)
            to prevent a future collision, with no behavior behind it. Unimplemented and reserved
            fields are described here in the <em>future</em> tense — never as something a mandate
            can rely on today.
          </p>
        </div>
        <p style={{ maxWidth: 700 }}>
          Reason codes are additive-only and never renamed (non-negotiable #7) — every code named
          below, including the reserved one, is a permanent commitment once it ships. Amounts are
          integer minor units throughout, same as everywhere else in this SDK.
        </p>

        <h3 style={{ marginTop: 32 }}>Amount</h3>
        <PolicyFieldTable rows={AMOUNT_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Period</h3>
        <p style={{ maxWidth: 700 }}>
          Worth stating plainly because it&rsquo;s easy to conflate: every window Waysafe
          actually computes is a <strong>fixed calendar window</strong> — a calendar day, a
          Monday-start calendar week, a calendar month, each in the policy&rsquo;s own timezone.
          None of them is a <strong>rolling window</strong> (the trailing N days from now,
          sliding forward every second). &ldquo;No more than $500 in any rolling 30 days&rdquo;
          and &ldquo;no more than $500 per calendar month&rdquo; are different guarantees — the
          first resets continuously, the second resets on the 1st regardless of when in the prior
          month spending happened. Only the second is expressible today.
        </p>
        <PolicyFieldTable rows={PERIOD_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Counterparty</h3>
        <PolicyFieldTable rows={COUNTERPARTY_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Time</h3>
        <PolicyFieldTable rows={TIME_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Velocity</h3>
        <PolicyFieldTable rows={VELOCITY_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Instrument</h3>
        <PolicyFieldTable rows={INSTRUMENT_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Evidence</h3>
        <p style={{ maxWidth: 700 }}>
          The minimum merchant trust tier required to ALLOW is a real rule the engine enforces
          unconditionally (D-34) — it is not, today, a field a mandate can set.
        </p>
        <PolicyFieldTable rows={EVIDENCE_FIELDS} />

        <h3 style={{ marginTop: 32 }}>Escalation</h3>
        <PolicyFieldTable rows={ESCALATION_FIELDS} />

        <h3 style={{ marginTop: 40 }}>Invariants</h3>
        <p style={{ maxWidth: 700 }}>
          The security properties a reviewer checks — not a summary of the tables above, a
          separate set of claims about how any policy, present or future, must compose.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>1. Absence fails closed.</strong> An unset field never widens scope. Omitting{" "}
          <code>per_transaction_max</code> does not mean unlimited spend is intended — every
          mandate still has <code>expires_at</code>, a currency, and an{" "}
          <code>unlisted</code> disposition on both merchants and categories, each independently
          capable of stopping an action. A missing ceiling is a ceiling nobody set, not a ceiling
          of infinity.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>2. Composition is most-restrictive-wins.</strong> Every dimension in{" "}
          <code>evaluate()</code> can only ever <em>add</em> a reason at its own tier or above;
          none can downgrade a decision another dimension already forced upward. Precedence is{" "}
          <code>DENY</code> &gt; <code>STEP_UP</code> &gt; <code>ALLOW</code>. Adding a rule to a
          policy can never widen what it already permitted. And a decision carries{" "}
          <em>every</em> reason code that applies at its winning tier, not just the first one
          evaluated — a request that&rsquo;s both over the per-transaction cap and from an
          unlisted merchant returns both <code>DENY_TRANSACTION_LIMIT_EXCEEDED</code> and{" "}
          <code>DENY_MERCHANT_NOT_ALLOWLISTED</code>, so a receipt never hides a second real
          reason behind whichever check happened to run first.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>3. Policy change requires mandate-creation authority.</strong> An approval
          authorizes one action. It can never mutate a policy — not the mandate it was decided
          under, not any other. Widening a limit, adding a merchant, or extending an expiry is a
          new mandate version, created with the same authority (and, today, the same WebAuthn
          ceremony) that created the first one — never a side effect of approving a transaction.
        </p>

        <h3 style={{ marginTop: 40 }}>Approver Mandates</h3>
        <div className="card" style={{ marginTop: 8, marginBottom: 16, background: "#fff8e1", borderColor: "#f0c96b" }}>
          <p style={{ margin: 0 }}>
            <strong>Everything in this subsection is SPECIFIED — a design, not shipped
            behavior — unless a sentence says otherwise.</strong> No approver concept exists
            anywhere in <code>packages/core</code> today: no schema field names one, no reason
            code distinguishes one kind of approval from another.
          </p>
        </div>
        <p style={{ maxWidth: 700 }}>
          A step-up is not a pause waiting for a human. It is a second authorization, evaluated by
          the same <code>evaluate()</code> engine against a <em>different</em> mandate — the
          approver&rsquo;s — producing the same decision shape, the same evidence entries, and the
          same reason codes as any other authorization.
        </p>
        <p style={{ maxWidth: 700 }}>
          The principal signs the approver&rsquo;s authority <strong>once</strong>, at enrollment,
          via WebAuthn (D-20) — the same passkey ceremony that activates any mandate. After that,
          approvals run at machine speed with no human present. The human is in the{" "}
          <em>authority</em> path, not the <em>transaction</em> path.
        </p>
        <p style={{ maxWidth: 700 }}>
          An approver is any actor holding an approver mandate: a treasury service, a manager, a
          controller system, or the principal themselves. The human-in-the-loop, async-approval
          case most people picture first is the <strong>degenerate form</strong> of this model,
          not a separate mechanism from it — a human approving on their phone and a treasury
          service approving programmatically both resolve a step-up the identical way, through the
          identical engine.
        </p>
        <p style={{ maxWidth: 700 }}>
          An approver mandate is bounded by the same policy schema documented above — amount
          ceilings, merchant scope, time windows, velocity. An approver cannot approve outside its
          own mandate; it is a mandate, evaluated the same way any other is.
        </p>
        <p style={{ maxWidth: 700 }}>
          Authority is <strong>single-level</strong>: an approver may authorize transactions but
          may not mint another approver. A delegation-depth field is not currently reserved
          anywhere in <code>packages/core</code> — checked directly, not assumed — so this session
          notes the gap in <code>DECISIONS.md</code> rather than claiming a reservation that
          doesn&rsquo;t exist. The intent stands regardless of the naming: when an approver-mandate
          schema is built, a delegation-depth field belongs in it from the start, so chains can be
          added later without a schema migration.
        </p>
        <p style={{ maxWidth: 700 }}>
          Changing the approver set is itself a policy change, and requires mandate-creation
          authority (Invariant 3) signed by the principal. An approver cannot add approvers.
        </p>
        <p style={{ maxWidth: 700 }}>
          Approval authorizes <strong>one action</strong>. It never raises a cap, extends a
          window, or mutates the mandate in any way — approving a $9,000 purchase does not raise
          the mandate&rsquo;s per-transaction ceiling for the next one.
        </p>
        <p style={{ maxWidth: 700 }}>
          Step-up classes resolve differently, and the distinction matters:
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>(a) Needs-evidence</strong> (e.g. <code>STEP_UP_MERCHANT_UNVERIFIED</code>)
          would resolve the moment a better-attested source supplies the identifier — a
          rail&rsquo;s own callback corroborating a domain, for instance — with no approver, no
          human, at machine speed. This class of automatic resolution is SPECIFIED, not built: no
          code today re-evaluates a pending step-up when new evidence arrives, only when a human or
          system explicitly calls <code>approveStepUp</code>/<code>declineStepUp</code>. What is
          real today (D-34) is that the <em>same underlying trust rule</em> already runs on every
          fresh evaluation — a rail-attested merchant on a new request resolves to{" "}
          <code>VERIFIED</code> the same way it always does; nothing here re-checks a specific
          pending authorization automatically.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>(b) Needs-higher-authority</strong> resolves via an approver mandate, as
          described above.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>(c) Unresolvable</strong> is a <code>DENY</code> at evaluation time, not a
          step-up that sits around waiting to expire — consistent with OQ-1&rsquo;s resolution
          (D-27): a hard ceiling denies outright rather than escalating something that was never
          going to be approvable.
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>Expiry and fail direction:</strong> an unresolved step-up expires to{" "}
          <code>DENY</code>. This part is not aspirational —{" "}
          <code>step_up.ttl_seconds</code> and the expiry-sweep path (D-31) are real, implemented
          today (see Escalation above).
        </p>
        <p style={{ maxWidth: 700 }}>
          <strong>The D-59 gap, stated plainly, not softened:</strong> today,{" "}
          <code>POST /v1/authorizations/:id/step-up</code> checks only that the presented
          credential belongs to the same organization — the same agent key that produced a{" "}
          <code>STEP_UP</code> decision can call <code>approveStepUp</code> on it immediately
          after, with no human, no second credential, and no code path that refuses it. This lets
          an agent credential manufacture authority it was never granted, collapsing{" "}
          <code>STEP_UP</code> to the same outcome as <code>ALLOW</code> for anyone holding just
          that one key. This is a defect in the current implementation, not a documented
          limitation of the design above — the approver-mandate model this section describes is
          what closes it, by requiring a step-up&rsquo;s resolution to come from a{" "}
          <em>different</em> mandate&rsquo;s authority, never the same credential that triggered
          it.
        </p>
      </div>
    </div>
  );
}
