"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTOPLAY_PAUSE_MS,
  SCENES,
  currentScene,
  initialSceneState,
  isLastScene,
  nextScene,
  prevScene,
  type SceneId,
  type SceneState,
} from "@/lib/demo/scenes";
import { LogPane } from "@/lib/demo/LogPane";
import type { LogEntry } from "@/lib/demo/log";
import { polygonScanAddressUrl } from "@/lib/demo/log";
import { verifyEvidenceChainInBrowser, type BrowserChainVerificationResult, type BrowserEvidenceEvent } from "@/lib/demo/browser-verify";

interface MandateInfo {
  mandate_id: string;
  policy_hash: string;
  instrument_id: string;
  safe_address: string;
  compiled_live: boolean;
  summary: string;
}

interface PayResult {
  decision: string;
  reason_codes: string[];
  co_signature: { pay_to: string; amount_atomic: string } | null;
  settlement: { tx_hash: string } | { error: string } | null;
}

interface BypassCase {
  name: string;
  description: string;
  rejected: boolean;
  revert_reason: string | null;
}
interface BypassResult {
  safe_address: string;
  cases: BypassCase[];
}

type PayScenario = "allowed" | "denied";

function DecisionBadge({ label, kind }: { label: string; kind: "allow" | "deny" | "rejected" | "pending" }) {
  return <span className={`demo-badge demo-badge--${kind}`}>{label}</span>;
}

export function DemoClient({ autoplay, commit }: { autoplay: boolean; commit: string }) {
  const [scene, setScene] = useState<SceneState>(initialSceneState());
  const [log, setLog] = useState<LogEntry[]>([]);
  const [visibleCount, setVisibleCount] = useState(0);

  const [mandate, setMandate] = useState<MandateInfo | null>(null);
  const [mandateLoading, setMandateLoading] = useState(false);
  const [mandateError, setMandateError] = useState<string | null>(null);

  const [payResults, setPayResults] = useState<Record<PayScenario, PayResult | null>>({ allowed: null, denied: null });
  const [payLoading, setPayLoading] = useState<Record<PayScenario, boolean>>({ allowed: false, denied: false });

  const [bypass, setBypass] = useState<BypassResult | null>(null);
  const [bypassLoading, setBypassLoading] = useState(false);

  const [evidence, setEvidence] = useState<{ events: BrowserEvidenceEvent[]; publicKey: string } | null>(null);
  const [verifyResult, setVerifyResult] = useState<BrowserChainVerificationResult | null>(null);
  const [verifyTampered, setVerifyTampered] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);

  const ranRef = useRef<Set<SceneId>>(new Set());

  const appendLog = useCallback((entries: LogEntry[] | undefined) => {
    if (!entries || entries.length === 0) return;
    setLog((prev) => [...prev, ...entries]);
  }, []);

  // Reveals log lines one at a time -- the content is real and unedited;
  // only the pacing of revealing already-fetched lines is cosmetic, for a
  // legible recording.
  useEffect(() => {
    if (visibleCount >= log.length) return;
    const t = setTimeout(() => setVisibleCount((c) => c + 1), 80);
    return () => clearTimeout(t);
  }, [log, visibleCount]);

  const runMandate = useCallback(async () => {
    setMandateLoading(true);
    setMandateError(null);
    try {
      const res = await fetch("/api/demo/mandate", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMandate(body);
      appendLog(body.log);
    } catch (err) {
      setMandateError(err instanceof Error ? err.message : String(err));
    } finally {
      setMandateLoading(false);
    }
  }, [appendLog]);

  const runPay = useCallback(
    async (scenario: PayScenario, m: MandateInfo) => {
      setPayLoading((p) => ({ ...p, [scenario]: true }));
      try {
        const res = await fetch("/api/demo/pay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenario, instrument_id: m.instrument_id, safe_address: m.safe_address }),
        });
        const body = await res.json();
        appendLog(body.log);
        if (res.ok) setPayResults((p) => ({ ...p, [scenario]: body }));
      } finally {
        setPayLoading((p) => ({ ...p, [scenario]: false }));
      }
    },
    [appendLog],
  );

  const runBypass = useCallback(
    async (m: MandateInfo) => {
      setBypassLoading(true);
      try {
        const res = await fetch("/api/demo/bypass", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instrument_id: m.instrument_id }),
        });
        const body = await res.json();
        appendLog(body.log);
        if (res.ok) setBypass(body);
      } finally {
        setBypassLoading(false);
      }
    },
    [appendLog],
  );

  const runVerify = useCallback(async () => {
    setVerifyLoading(true);
    try {
      const res = await fetch("/api/demo/evidence");
      const body = await res.json();
      if (!res.ok) return;
      setEvidence({ events: body.events, publicKey: body.public_key });
      const result = await verifyEvidenceChainInBrowser(body.events, body.public_key);
      setVerifyResult(result);
      appendLog([
        {
          kind: "http",
          label: "GET /v1/evidence, GET /v1/evidence/public-key",
          detail: `${body.events.length} events fetched`,
        },
        {
          kind: "info",
          label: "verifying in this browser tab, against the public key only",
          detail: "SHA-256 + Ed25519 via window.crypto.subtle -- no call back to Waysafe to ask if it's valid",
        },
      ]);
    } finally {
      setVerifyLoading(false);
    }
  }, [appendLog]);

  const toggleTamper = useCallback(async () => {
    if (!evidence) return;
    const next = !verifyTampered;
    setVerifyTampered(next);
    const events = next
      ? evidence.events.map((e, i) =>
          i === evidence.events.length - 1
            ? { ...e, payload: { ...e.payload, __tampered: true } }
            : e,
        )
      : evidence.events;
    const result = await verifyEvidenceChainInBrowser(events, evidence.publicKey);
    setVerifyResult(result);
    appendLog([
      next
        ? { kind: "warn", label: "flipped one byte of the last event's payload", detail: "re-verifying..." }
        : { kind: "info", label: "restored the original payload", detail: "re-verifying..." },
    ]);
  }, [evidence, verifyTampered, appendLog]);

  const reset = useCallback(() => {
    ranRef.current.clear();
    setScene(initialSceneState());
    setLog([]);
    setVisibleCount(0);
    setMandate(null);
    setMandateError(null);
    setPayResults({ allowed: null, denied: null });
    setBypass(null);
    setEvidence(null);
    setVerifyResult(null);
    setVerifyTampered(false);
  }, []);

  // Scene-entry actions: fire once per scene visit per run.
  useEffect(() => {
    const id = currentScene(scene).id;
    if (ranRef.current.has(id)) return;
    if (id === "mandate") {
      ranRef.current.add(id);
      void runMandate();
    } else if (id === "allowed" && mandate) {
      ranRef.current.add(id);
      void runPay("allowed", mandate);
    } else if (id === "denied" && mandate) {
      ranRef.current.add(id);
      void runPay("denied", mandate);
    } else if (id === "bypass" && mandate) {
      ranRef.current.add(id);
      void runBypass(mandate);
    } else if (id === "verify") {
      ranRef.current.add(id);
      void runVerify();
    }
  }, [scene, mandate, runMandate, runPay, runBypass, runVerify]);

  // Keyboard: space advances, backspace/left goes back.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space") {
        e.preventDefault();
        setScene((s) => nextScene(s));
      } else if (e.code === "Backspace" || e.code === "ArrowLeft") {
        setScene((s) => prevScene(s));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Autoplay: ~4s per scene, hands-free.
  useEffect(() => {
    if (!autoplay || isLastScene(scene)) return;
    const t = setTimeout(() => setScene((s) => nextScene(s)), AUTOPLAY_PAUSE_MS);
    return () => clearTimeout(t);
  }, [autoplay, scene]);

  const scn = currentScene(scene);
  const visibleLog = useMemo(() => log.slice(0, visibleCount), [log, visibleCount]);

  return (
    <div className="demo-root">
      <div className="demo-topbar">
        <span className="demo-title">Waysafe -- live demo</span>
        <div className="demo-topbar-right">
          <div className="demo-scene-dots">
            {SCENES.map((s) => (
              <span key={s.id} className={`demo-scene-dot ${s.id === scn.id ? "demo-scene-dot--active" : ""}`} />
            ))}
          </div>
          <button className="demo-reset" onClick={reset}>
            reset
          </button>
        </div>
      </div>

      <div className="demo-caption">{scn.caption}</div>

      <div className="demo-main">
        <div className="demo-left">
          {scn.id === "mandate" && (
            <>
              <div className="demo-card">
                <div className="demo-card-title">The instruction</div>
                <div className="demo-card-body">&ldquo;You may spend up to $20 per day. Never spend more than $10 in a single transaction. Ask me before paying any merchant I haven&rsquo;t approved.&rdquo;</div>
              </div>
              <div className="demo-card">
                <div className="demo-card-title">Mandate</div>
                {mandateLoading && <div className="demo-card-body">compiling and authenticating...</div>}
                {mandateError && <div className="demo-card-body demo-verify-fail">{mandateError}</div>}
                {mandate && (
                  <div className="demo-card-body">
                    <div>{mandate.compiled_live ? "compiled live" : "compiled (offline fixture path)"}: {mandate.summary}</div>
                    <div className="demo-mono">policy_hash {mandate.policy_hash}</div>
                    <div className="demo-mono">
                      Safe{" "}
                      <a className="demo-link" href={polygonScanAddressUrl(mandate.safe_address)} target="_blank" rel="noreferrer">
                        {mandate.safe_address}
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {(scn.id === "allowed" || scn.id === "denied") && (
            <>
              <div className="demo-card">
                <div className="demo-card-title">The agent</div>
                <div className="demo-card-body">
                  {scn.id === "allowed"
                    ? "Trying to pay GoodBeans API $0.50 for one inference credit -- on the mandate's allowlist."
                    : "Trying to pay ShinyGadgets API $2.50 for a SKU lookup -- not on the mandate's allowlist."}
                </div>
              </div>
              <div className="demo-card">
                <div className="demo-card-title">Decision</div>
                {payLoading[scn.id] && <DecisionBadge label="EVALUATING" kind="pending" />}
                {payResults[scn.id] && (
                  <>
                    <DecisionBadge
                      label={payResults[scn.id]!.decision}
                      kind={payResults[scn.id]!.decision === "ALLOW" ? "allow" : "deny"}
                    />
                    <div className="demo-card-body" style={{ marginTop: 10 }}>
                      {payResults[scn.id]!.reason_codes.map((c) => (
                        <div key={c} className="demo-mono">{c}</div>
                      ))}
                    </div>
                    {payResults[scn.id]!.settlement && "tx_hash" in payResults[scn.id]!.settlement! && (
                      <div className="demo-card-body" style={{ marginTop: 10 }}>
                        actor: instrument (Safe {mandate ? `••••${mandate.safe_address.slice(-4)}` : ""})
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {scn.id === "bypass" && (
            <>
              <div className="demo-card">
                <div className="demo-card-title">The attacker</div>
                <div className="demo-card-body">Has the stolen session key. Has no Waysafe SDK, no agent API key, no way to call evaluate().</div>
              </div>
              <div className="demo-card">
                <div className="demo-card-title">On-chain result</div>
                {bypassLoading && <DecisionBadge label="SIMULATING" kind="pending" />}
                {bypass && (
                  <>
                    <DecisionBadge label="REJECTED ON-CHAIN" kind="rejected" />
                    <div className="demo-card-body" style={{ marginTop: 10 }}>
                      {bypass.cases.map((c) => (
                        <div key={c.name}>
                          {c.rejected ? "✓" : "✗"} {c.description}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {scn.id === "card_rail" && (
            <div className="demo-card">
              <div className="demo-card-title">Card rail</div>
              <div className="demo-card-body">
                Waysafe also enforces on card networks (D-32/D-33), the same required-signer position, via Stripe
                Issuing&rsquo;s synchronous authorization webhook. This environment&rsquo;s Issuing financial account
                is still <code>status: &quot;pending&quot;</code> -- this demo does not fake a Stripe scene against an
                unfunded sandbox account.
              </div>
            </div>
          )}

          {scn.id === "verify" && (
            <div className="demo-card">
              <div className="demo-card-title">Verify it yourself</div>
              {verifyLoading && <div className="demo-card-body">fetching evidence chain...</div>}
              {verifyResult && (
                <div className="demo-card-body">
                  <div className={verifyResult.ok ? "demo-verify-pass" : "demo-verify-fail"}>
                    {verifyResult.ok ? "VERIFIED" : `NOT VERIFIED (${verifyResult.reason})`}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button className="demo-reset" onClick={() => void toggleTamper()}>
                      {verifyTampered ? "restore the original byte" : "flip one byte"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="demo-right">
          <LogPane entries={visibleLog} />
        </div>
      </div>

      <div className="demo-footer">
        <span>Polygon Amoy testnet -- test USDC only, no real funds move.</span>
        <span>commit {commit}</span>
      </div>
    </div>
  );
}
