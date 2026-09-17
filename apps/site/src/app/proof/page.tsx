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

// Zero-install: node:crypto only, no @waysafe/sdk, no network call. Save as
// verify.mjs, run `node verify.mjs`, paste the "events" array and
// "public_key" from below (or from a live GET /v1/evidence + GET
// /v1/evidence/public-key). Same algorithm as
// packages/core/src/evidence.ts's computeEventHash/verifyEvidenceChain and
// evidence-signing.ts's verifyEventSignature -- reimplemented here, not
// imported, so this file is genuinely self-contained.
const VERIFY_SNIPPET = `import { createHash, createPublicKey, verify } from "node:crypto";

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((acc, k) => ((acc[k] = sortKeysDeep(v[k])), acc), {});
  }
  return v;
}
const hashEvent = (c) => createHash("sha256").update(JSON.stringify(sortKeysDeep(c))).digest("hex");

function verifyEvidenceChain(events, publicKeyBase64) {
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
  let expectedSequence = events[0].sequence;
  let previousHash = events[0].previous_hash;
  for (const e of events) {
    if (e.sequence !== expectedSequence) return { ok: false, brokenAtSequence: e.sequence, reason: "sequence_gap" };
    if (e.previous_hash !== previousHash) return { ok: false, brokenAtSequence: e.sequence, reason: "previous_hash_mismatch" };
    const expected = hashEvent({
      organization_id: e.organization_id, sequence: e.sequence, type: e.type, subject_type: e.subject_type,
      subject_id: e.subject_id, payload: e.payload, previous_hash: e.previous_hash, created_at: e.created_at,
    });
    if (expected !== e.hash) return { ok: false, brokenAtSequence: e.sequence, reason: "hash_mismatch" };
    try {
      if (!verify(null, Buffer.from(e.hash, "hex"), publicKey, Buffer.from(e.signature, "base64")))
        return { ok: false, brokenAtSequence: e.sequence, reason: "signature_invalid" };
    } catch {
      return { ok: false, brokenAtSequence: e.sequence, reason: "signature_invalid" };
    }
    previousHash = e.hash;
    expectedSequence += 1;
  }
  return { ok: true, signed: true };
}

// Paste the "events" array and "public_key" string from this page (or from
// GET /v1/evidence + GET /v1/evidence/public-key) below, then run this file.
const events = [ /* evidence.events from this page */ ];
const publicKey = "..."; // evidence.public_key from this page
console.log(verifyEvidenceChain(events, publicKey));`;

const VERIFY_SNIPPET_SDK = `import { verifyEvidenceIndependently } from "@waysafe/sdk";

// events: from GET /v1/evidence (or the "evidence.events" array in proof.json)
// publicKey: from GET /v1/evidence/public-key (or "evidence.public_key" below)
const result = verifyEvidenceIndependently(events, publicKey);
// { ok: true, signed: true } -- checked locally, no network call,
// no trust in the server that produced the data. Same algorithm as the
// self-contained node:crypto version above; this is the SDK's own copy of it.`;

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
        <p style={{ maxWidth: 720 }}>
          All three cases below are <code>eth_call</code> simulations (viem&rsquo;s{" "}
          <code>simulateContract</code>) — a real call against the deployed Safe&rsquo;s actual
          on-chain state, but never broadcast, so none of them has a transaction hash. That is the
          honest state of these three: rejected before submission, not reverted after it.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Description</th>
                <th>Rejected</th>
                <th>Revert reason</th>
                <th>On-chain</th>
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
                    {c.revert_reason_gloss ?? c.revert_reason_summary}
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ cursor: "pointer" }}>full revert text</summary>
                      <pre style={{ marginTop: 6, fontSize: "0.72rem", whiteSpace: "pre-wrap" }}>
                        {c.revert_reason_full}
                      </pre>
                    </details>
                  </td>
                  <td className="muted" style={{ fontSize: "0.8rem" }}>
                    Never submitted (gas estimation only)
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
          <p style={{ margin: "12px 0 0", fontSize: "0.95rem", fontWeight: 600 }}>
            On-chain reference:{" "}
            {proof.allow_attempt.on_chain.tx_hash ? (
              <a
                className="link mono"
                style={{ fontSize: "0.85rem", fontWeight: 400 }}
                href={proof.allow_attempt.on_chain.explorer_url!}
                target="_blank"
                rel="noopener noreferrer"
              >
                {proof.allow_attempt.on_chain.tx_hash} ↗
              </a>
            ) : (
              <span className="muted" style={{ fontWeight: 400 }}>none — {proof.allow_attempt.on_chain.method}</span>
            )}
          </p>
        </div>

        <h2 style={{ marginTop: 48 }}>Evidence chain</h2>
        <p style={{ maxWidth: 720 }}>
          Sequence {proof.evidence.events[0].sequence}–{proof.evidence.events[proof.evidence.events.length - 1].sequence}
          , {proof.evidence.events.length} contiguous events from this run's real chain. Each entry's{" "}
          <code>hash</code> is computed over its own fields plus the previous entry's hash, and each
          entry is independently Ed25519-signed.
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
          Below is the full evidence slice (the table above) and Waysafe&rsquo;s published Ed25519
          public key. This page doesn&rsquo;t ask you to take its word for what they prove — paste
          both into the script below and run it yourself. It needs nothing but Node&rsquo;s built-in{" "}
          <code>node:crypto</code>: no install, no <code>@waysafe/sdk</code>, no network call, no
          trust in this page or the server that produced the data.
        </p>
        <div style={{ position: "relative" }}>
          <CopyButton text={VERIFY_SNIPPET} />
          <pre>{VERIFY_SNIPPET}</pre>
        </div>

        <p style={{ maxWidth: 720, marginTop: 24 }}>
          If you&rsquo;re already integrating against <code>@waysafe/sdk</code>, it ships the same
          check as a function:
        </p>
        <div style={{ position: "relative" }}>
          <CopyButton text={VERIFY_SNIPPET_SDK} />
          <pre>{VERIFY_SNIPPET_SDK}</pre>
        </div>

        <h3 style={{ marginTop: 32 }}>Evidence events (JSON)</h3>
        <p style={{ maxWidth: 720 }}>The exact array the script above expects as <code>events</code>:</p>
        <div style={{ position: "relative" }}>
          <CopyButton text={JSON.stringify(proof.evidence.events, null, 2)} />
          <pre style={{ maxHeight: 320, overflow: "auto" }}>{JSON.stringify(proof.evidence.events, null, 2)}</pre>
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
