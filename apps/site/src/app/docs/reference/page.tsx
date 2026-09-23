import type { Metadata } from "next";
import { REPO_TREE } from "@/lib/docs-nav";
import { DecisionBadge, METHODS, REASON_CODES } from "@/lib/docs-content";

export const metadata: Metadata = {
  title: "Reference — Waysafe docs",
  description:
    "The @waysafe/sdk method table, the raw REST wire format, and the full reason-code dictionary.",
};

export default function Page() {
  return (
    <>
        <h2 style={{ marginTop: 56 }}>SDK reference</h2>
        <p style={{ maxWidth: 700, marginBottom: 4 }}>
          Source:{" "}
          <a className="link" href={`${REPO_TREE}/packages/sdk`} target="_blank" rel="noopener noreferrer">
            packages/sdk
          </a>
        </p>
        <p style={{ fontSize: "1.05rem", maxWidth: 700, lineHeight: 1.7 }}>
          A thin, typed HTTP client. Every method here is a direct wrapper around one REST call —
          nothing here is a framework, a UI, or a required flow.
        </p>

        <h2 style={{ marginTop: 56 }}>Install and instantiate</h2>
        <p style={{ maxWidth: 700 }}>
          <code>@waysafe/sdk</code> is real, public source — <code>packages/sdk</code> in this
          repo, the same package the quickstart above already ran, straight from a clone. It
          isn&rsquo;t published to npm yet because there&rsquo;s no hosted API yet for a
          published package to point at — nothing to publish for, not something being withheld.
          Once a hosted deployment exists, this is what installing and pointing it at one will
          look like:
        </p>
        <pre>{`# not yet published -- this is what it will look like once a hosted API exists
npm install @waysafe/sdk

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
        <p style={{ maxWidth: 700, marginBottom: 4 }}>
          Source:{" "}
          <a
            className="link"
            href={`${REPO_TREE}/packages/core/src/reason-codes.ts`}
            target="_blank"
            rel="noopener noreferrer"
          >
            packages/core/src/reason-codes.ts
          </a>
        </p>
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
    </>
  );
}
