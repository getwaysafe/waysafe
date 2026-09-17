import type { Metadata } from "next";
import { CONTACT_EMAIL } from "@/lib/constants";

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

const QUICKSTART_SNIPPET = `import { Waysafe, asExecutable } from "@waysafe/sdk";

const waysafe = new Waysafe({ baseUrl, apiKey });

const compiled = await waysafe.compileMandate({
  instruction: "Spend up to $500/month on office supplies from Amazon or Staples. Never over $150/transaction.",
});
if (compiled.status === "compiled") {
  const mandate = await waysafe.createMandate({
    principal_id, agent_ids: [agentId], policy: compiled.policy, intent_text: compiled.confirmation.summary,
  });
  // Your frontend runs the passkey ceremony here (getMandateAuthenticationOptions
  // -> navigator.credentials.create()/.get() -> verifyMandateAuthentication).

  const decision = await waysafe.authorize({
    agent_id: agentId, principal_id, mandate_id: mandate.mandate_id,
    action: { amount: 4200, currency: "USD", merchant: { domain: "staples.com" }, category: "office_supplies", attestations: {} },
  });

  const executable = asExecutable(decision);
  if (executable) await waysafe.execute(executable, { rail: "stripe", paymentMethodRef: "pm_..." });
}`;

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

        <h2 style={{ marginTop: 56 }}>Install and instantiate</h2>
        <div className="card" style={{ marginTop: 8, marginBottom: 16, background: "#fff8e1", borderColor: "#f0c96b" }}>
          <p style={{ margin: 0 }}>
            <strong>Not yet on npm.</strong> The hosted API is still in private testing, so
            there&rsquo;s no public base URL to point the SDK at yet — the full interface is
            documented below. Email{" "}
            <a className="link" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>{" "}
            to try it against a real deployment.
          </p>
        </div>
        <pre>{`npm install @waysafe/sdk

import { Waysafe } from "@waysafe/sdk";

const waysafe = new Waysafe({
  baseUrl: "https://api.your-waysafe-deployment.example",
  apiKey: process.env.WAYSAFE_API_KEY, // an org or agent credential
});`}</pre>

        <h2 style={{ marginTop: 48 }}>Quickstart: to a first decision</h2>
        <p style={{ maxWidth: 700 }}>
          Trimmed from <code>examples/quickstart.ts</code>, which runs end to end with zero
          setup and no environment variables required — the repo is private during testing;
          email{" "}
          <a className="link" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>{" "}
          for access, and run <code>npm run quickstart</code> once you have it. This snippet
          elides the browser-side passkey ceremony (your own frontend&rsquo;s job); the full
          script simulates it so it runs unattended.
        </p>
        <pre>{QUICKSTART_SNIPPET}</pre>

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
      </div>
    </div>
  );
}
