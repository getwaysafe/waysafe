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

// A transaction that reverts before submission never had a chance to cost
// gas or get mined -- that's a stronger result than a broadcast revert, not
// a gap in the evidence. This label makes the two states visually parallel
// (badge + badge) rather than one being a hash/link and the other a blank.
function OnChainLabel({ submitted }: { submitted: boolean }) {
  return submitted ? (
    <span className="badge badge-allow">SUBMITTED · MINED</span>
  ) : (
    <span className="badge" style={{ color: "var(--slate)", border: "1px solid var(--slate)" }}>
      REJECTED · PRE-BROADCAST
    </span>
  );
}

// Zero-install: node:crypto only, no @waysafe/sdk, no network call. Save as
// verify.mjs, run `node verify.mjs`, paste "events", "public_key", and
// "key_directory" from below (or from a live GET /v1/evidence + GET
// /v1/evidence/public-key). Same algorithm as
// packages/core/src/evidence.ts's computeEventHash/verifyEvidenceChain and
// evidence-signing.ts's verifyEventSignature -- reimplemented here, not
// imported, so this file is genuinely self-contained. key_directory routing
// mirrors D-53: an event carrying a key_id is checked against the matching
// directory entry; an event with none (written before the key directory
// existed) falls back to publicKey, the one key this chain has ever used.
const VERIFY_SNIPPET = `import { createHash, createPublicKey, verify } from "node:crypto";

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((acc, k) => ((acc[k] = sortKeysDeep(v[k])), acc), {});
  }
  return v;
}
const hashEvent = (c) => createHash("sha256").update(JSON.stringify(sortKeysDeep(c))).digest("hex");
const loadKey = (base64) => createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });

function verifyEvidenceChain(events, publicKeyBase64, keyDirectory = []) {
  const publicKey = loadKey(publicKeyBase64);
  const directory = new Map(keyDirectory.map((k) => [k.key_id, loadKey(k.public_key)]));
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
    // No key_id at all -> this chain's one key, publicKey. A key_id present
    // but not in the directory fails closed -- never silently falls back.
    const signingKey = e.key_id ? directory.get(e.key_id) : publicKey;
    try {
      if (!signingKey || !verify(null, Buffer.from(e.hash, "hex"), signingKey, Buffer.from(e.signature, "base64")))
        return { ok: false, brokenAtSequence: e.sequence, reason: "signature_invalid" };
    } catch {
      return { ok: false, brokenAtSequence: e.sequence, reason: "signature_invalid" };
    }
    previousHash = e.hash;
    expectedSequence += 1;
  }
  return { ok: true, signed: true };
}

// Paste "events", "public_key", and "key_directory" from this page (or from
// GET /v1/evidence + GET /v1/evidence/public-key) below, then run this file.
// A passing result proves Waysafe signed this exact record and nothing in
// it was altered afterward -- it does NOT prove completeness (that nothing
// happened outside this chain); see the note below the snippets.
const events = [ /* evidence.events from this page */ ];
const publicKey = "..."; // evidence.public_key from this page
const keyDirectory = [ /* evidence.key_directory from this page */ ];
console.log(verifyEvidenceChain(events, publicKey, keyDirectory));`;

const VERIFY_SNIPPET_SDK = `import { verifyEvidenceIndependently } from "@waysafe/sdk";

// events: from GET /v1/evidence (or "evidence.events" in proof.json)
// publicKey: from GET /v1/evidence/public-key's "public_key" (or "evidence.public_key" below)
// keyDirectory: that same response's "key_directory" (or "evidence.key_directory" below) --
// an event carrying a key_id is checked against the matching entry; an
// event with none falls back to publicKey.
const result = verifyEvidenceIndependently(events, publicKey, keyDirectory);
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
          All three were broadcast to Polygon Amoy and reverted on-chain. Each row links to the
          transaction.
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
                  <td style={{ fontSize: "0.8rem" }}>
                    <OnChainLabel submitted={c.on_chain.submitted} />
                    {c.on_chain.tx_hash && c.on_chain.explorer_url && (
                      <div style={{ marginTop: 4 }}>
                        <a
                          className="link mono"
                          style={{ fontSize: "0.78rem" }}
                          href={c.on_chain.explorer_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {truncate(c.on_chain.tx_hash, 10, 8)} ↗
                        </a>
                      </div>
                    )}
                    <div className="muted" style={{ marginTop: 4, fontSize: "0.75rem" }}>
                      {c.on_chain.method}
                    </div>
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
            On-chain reference: <OnChainLabel submitted={proof.allow_attempt.on_chain.submitted} />{" "}
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
              <span className="muted" style={{ fontWeight: 400 }}>{proof.allow_attempt.on_chain.method}</span>
            )}
          </p>
        </div>

        <h2 style={{ marginTop: 48 }}>Evidence chain</h2>
        <p style={{ maxWidth: 720 }}>
          Sequence {proof.evidence.events[0].sequence}–{proof.evidence.events[proof.evidence.events.length - 1].sequence}
          , {proof.evidence.events.length} contiguous events from this run's real chain. Each entry's{" "}
          <code>hash</code> is computed over its own fields plus the previous entry's hash, each
          entry is independently Ed25519-signed, and each carries a <code>key_id</code> naming which
          key in the directory below signed it.
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
                <th>Key</th>
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
                  <td className="mono muted" style={{ fontSize: "0.78rem" }} title={e.key_id ?? undefined}>
                    {e.key_id ? truncate(e.key_id, 6, 4) : "— (pre-key-directory)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 style={{ marginTop: 48 }}>Verify it yourself</h2>
        <p style={{ maxWidth: 720 }}>
          Below is the full evidence slice (the table above) and Waysafe&rsquo;s published Ed25519
          key directory. This page doesn&rsquo;t ask you to take its word for what they prove —
          paste the data into the script below and run it yourself. It needs nothing but
          Node&rsquo;s built-in <code>node:crypto</code>: no install, no{" "}
          <code>@waysafe/sdk</code>, no network call, no trust in this page or the server that
          produced the data.
        </p>
        <p style={{ maxWidth: 720 }}>
          <strong>What a passing result actually proves:</strong> that Waysafe signed this exact
          record, and that no entry has been altered since — a forged or edited event fails at{" "}
          <code>hash_mismatch</code> or <code>signature_invalid</code> above, not silently pass. What
          it does <strong>not</strong> prove is completeness — that nothing happened outside this
          chain. This capture has no external anchor (a timestamping service, a public ledger
          commitment) tying &ldquo;the chain ends here&rdquo; to anything outside Waysafe&rsquo;s own
          database. That would be a separate, stronger claim this page doesn&rsquo;t make.
        </p>
        <div style={{ position: "relative" }}>
          <CopyButton text={VERIFY_SNIPPET} />
          <pre>{VERIFY_SNIPPET}</pre>
        </div>

        <p style={{ maxWidth: 720, marginTop: 24 }}>
          Once <code>@waysafe/sdk</code> is published, it will ship the same check as a function
          — for reference, not something you can run today:
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

        <h3 style={{ marginTop: 32 }}>Key directory</h3>
        <p style={{ maxWidth: 720 }}>
          Every key a signature above might have been made under, oldest first — what a real key
          rotation would add a second entry to, without invalidating anything signed under the
          first. This run has exactly one, matching the public key above.
        </p>
        <div style={{ position: "relative" }}>
          <CopyButton text={JSON.stringify(proof.evidence.key_directory, null, 2)} />
          <pre style={{ maxHeight: 240, overflow: "auto" }}>
            {JSON.stringify(proof.evidence.key_directory, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
