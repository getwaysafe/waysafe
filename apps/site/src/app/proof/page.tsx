import type { Metadata } from "next";
import proof from "@/data/proof.json";
import { CopyButton } from "@/components/CopyButton";

export const metadata: Metadata = {
  title: "Proof — Waysafe",
  description: "One real run against the local Waysafe stack, captured once and committed as static JSON.",
};

type Decision = "ALLOW" | "DENY" | "STEP_UP";

function DecisionBadge({ decision }: { decision: string }) {
  const cls = decision === "ALLOW" ? "badge-allow" : decision === "DENY" ? "badge-deny" : "badge-step-up";
  return <span className={`badge ${cls}`}>{decision as Decision}</span>;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function truncate(hex: string, lead = 10, tail = 8): string {
  if (hex.length <= lead + tail + 3) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

const VERIFY_SNIPPET = `import { verifyEvidenceIndependently } from "@waysafe/sdk";

// events: from GET /v1/evidence (or the "evidence.events" array in proof.json)
// publicKey: from GET /v1/evidence/public-key (or "evidence.public_key" below)
const result = verifyEvidenceIndependently(events, publicKey);
// { ok: true, signed: true } -- checked locally, no network call,
// no trust in the server that produced the data.`;

export default function ProofPage() {
  const capturedDate = new Date(proof.captured_at).toISOString().slice(0, 10);
  const settlement = proof.allow_attempt.settlement as { ok: true; tx_hash: string } | { ok: false; note: string };

  return (
    <div className="section-light section">
      <div className="container">
        <p className="kicker">Proof</p>
        <h1 className="display" style={{ fontSize: "clamp(1.8rem, 4vw, 2.6rem)", marginTop: 8 }}>
          One real run, captured and static
        </h1>
        <p style={{ fontSize: "1.05rem", maxWidth: 720, lineHeight: 1.7 }}>
          {proof.note} Captured on <strong>{capturedDate}</strong>. This page renders that one run's
          own evidence records — it is not a live endpoint, and nothing on it updates on its own.
        </p>

        <h2 style={{ marginTop: 48 }}>Mandates</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Mandate</th>
                <th>Policy hash</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {proof.mandates.map((m) => (
                <tr key={m.mandate_id}>
                  <td>{m.label}</td>
                  <td>
                    <code className="mono" style={{ fontSize: "0.8rem" }}>
                      {m.mandate_id}
                    </code>
                  </td>
                  <td>
                    <code className="mono" style={{ fontSize: "0.8rem" }}>
                      {truncate(m.policy_hash)}
                    </code>
                  </td>
                  <td>{m.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 style={{ marginTop: 48 }}>Card authorizations (Stripe Issuing, replayed)</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Amount</th>
                <th>Decision</th>
                <th>Reason codes</th>
              </tr>
            </thead>
            <tbody>
              {proof.card_attempts.map((a) => (
                <tr key={a.authorization_id}>
                  <td>{a.label}</td>
                  <td>{formatCents(a.amount_cents)}</td>
                  <td>
                    <DecisionBadge decision={a.decision} />
                  </td>
                  <td className="mono muted" style={{ fontSize: "0.78rem" }}>
                    {a.reason_codes.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 style={{ marginTop: 48 }}>On-chain bypass rejections (Polygon Amoy, live)</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Description</th>
                <th>Rejected</th>
                <th>Revert reason</th>
              </tr>
            </thead>
            <tbody>
              {proof.onchain_rejections.map((c) => (
                <tr key={c.name}>
                  <td>
                    <code className="mono" style={{ fontSize: "0.8rem" }}>
                      {c.name}
                    </code>
                  </td>
                  <td>{c.description}</td>
                  <td>
                    <span className="badge badge-deny">{c.rejected ? "REJECTED" : "ACCEPTED"}</span>
                  </td>
                  <td className="mono muted" style={{ fontSize: "0.78rem" }}>
                    {c.revert_reason_summary}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 style={{ marginTop: 48 }}>The genuine ALLOW (x402, on-chain)</h2>
        <div className="card">
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <DecisionBadge decision={proof.allow_attempt.decision} />
            <code className="mono muted" style={{ fontSize: "0.82rem" }}>
              {proof.allow_attempt.reason_codes.join(", ")}
            </code>
          </div>
          <p style={{ margin: "4px 0" }}>
            <span className="muted">Mandate: </span>
            <code className="mono" style={{ fontSize: "0.82rem" }}>
              {proof.allow_attempt.mandate_id}
            </code>
          </p>
          <p style={{ margin: "4px 0" }}>
            <span className="muted">Safe: </span>
            <code className="mono" style={{ fontSize: "0.82rem" }}>
              {proof.allow_attempt.safe_address}
            </code>
          </p>
          <p style={{ margin: "12px 0 0", fontSize: "0.95rem" }}>
            {settlement.ok ? (
              <>
                <span className="badge badge-allow">SETTLED</span>{" "}
                <code className="mono" style={{ fontSize: "0.8rem" }}>{settlement.tx_hash}</code>
              </>
            ) : (
              <>
                <span className="badge" style={{ color: "var(--slate)", border: "1px solid var(--slate)" }}>
                  NOT SETTLED
                </span>{" "}
                {settlement.note}
              </>
            )}
          </p>
        </div>

        <h2 style={{ marginTop: 48 }}>Evidence chain</h2>
        <p style={{ maxWidth: 720 }}>
          Sequence {proof.evidence.events[0].sequence}–{proof.evidence.events[proof.evidence.events.length - 1].sequence}
          , seven contiguous events from this run's real chain. Each entry's <code>hash</code> is computed
          over its own fields plus the previous entry's hash, and each entry is independently Ed25519-signed.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Seq</th>
                <th>Type</th>
                <th>Subject</th>
                <th>Previous hash</th>
                <th>Hash</th>
                <th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {proof.evidence.events.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.sequence}</td>
                  <td className="mono" style={{ fontSize: "0.78rem" }}>
                    {e.type}
                  </td>
                  <td className="mono muted" style={{ fontSize: "0.78rem" }}>
                    {truncate(e.subject_id, 8, 6)}
                  </td>
                  <td className="mono muted" style={{ fontSize: "0.78rem" }} title={e.previous_hash ?? undefined}>
                    {e.previous_hash ? truncate(e.previous_hash) : "—"}
                  </td>
                  <td className="mono muted" style={{ fontSize: "0.78rem" }} title={e.hash}>
                    {truncate(e.hash)}
                  </td>
                  <td className="mono muted" style={{ fontSize: "0.78rem" }} title={e.signature}>
                    {truncate(e.signature, 8, 6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 style={{ marginTop: 48 }}>Verify it yourself</h2>
        <p style={{ maxWidth: 720 }}>
          {proof.verification.ok ? "This chain verified" : "This chain did not verify"} against Waysafe's
          published Ed25519 public key, signature: <strong>{String(proof.verification.signed)}</strong>.
          Run the same check yourself, locally, with no network call and no trust in this page:
        </p>
        <div style={{ position: "relative" }}>
          <CopyButton text={VERIFY_SNIPPET} />
          <pre>{VERIFY_SNIPPET}</pre>
        </div>

        <h3 style={{ marginTop: 32 }}>Public key</h3>
        <div style={{ position: "relative" }}>
          <CopyButton text={proof.evidence.public_key} />
          <pre style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>{proof.evidence.public_key}</pre>
        </div>
      </div>
    </div>
  );
}
