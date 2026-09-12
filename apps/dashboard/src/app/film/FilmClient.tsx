"use client";

/**
 * D-44: `/film`'s three-act orchestration. Unlike `/story`, which calls
 * `evaluate()` directly in the browser, every real decision here is
 * computed server-side (the real Stripe Issuing adapter, the real x402/
 * Safe path) and reaches this component only as an HTTP response --
 * see `lib/film/api-decisions.ts`'s own doc comment for why that module,
 * not a client-side stub of `evaluate()`, is this page's honesty boundary
 * for Act 2 and Act 3. The one place this page *does* call the real
 * `evaluate()` client-side is the optional fleet-glimpse beat, which
 * reuses `/story`'s own `buildStory` unchanged (`lib/film/fleet-glimpse.ts`).
 *
 * All real setup (a fresh mandate, the x402 Safe instrument, the card
 * replay, the on-chain rejections, the genuine ALLOW, the evidence chain)
 * is kicked off once, as early as possible, on mount -- not lazily at each
 * beat -- so a real recording has the best chance every result has already
 * arrived by the time its beat needs to show it. If something is still
 * pending when its beat arrives, the beat shows a real "evaluating..."
 * state, never a placeholder decision.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { RAILS } from "@/lib/story/attack-data";
import { verifyEvidenceChainInBrowser, type BrowserChainVerificationResult, type BrowserEvidenceEvent } from "@/lib/demo/browser-verify";
import { maskExternalRef, polygonScanTxUrl } from "@/lib/demo/log";
import {
  normalizeCardAttempt,
  normalizeStablecoinPayResult,
  normalizeStablecoinRejection,
  type CardAttemptResult,
  type StablecoinPayResult,
  type StablecoinRejection,
} from "@/lib/film/api-decisions";
import { balancesAtMs, buildAct1Notifications } from "@/lib/film/act1-timeline";
import {
  AGENT_REASONING_ATTRIBUTION,
  AGENT_REASONING_QUOTE,
  AGENT_TASKS,
  CARD_REPLAY_TAG,
  COMPROMISE_CAPTION,
  END_CARD_LINE_1A,
  END_CARD_LINE_1B,
  END_CARD_LINE_2,
  END_CARD_LINE_3,
  FLEET_GLIMPSE_CAPTION,
  STABLECOIN_REVERT_CAPTION,
  STABLECOIN_THRESHOLD_CAPTION,
  WHO_PAYS_LEFT_ANSWER,
  WHO_PAYS_QUESTION,
  WHO_PAYS_RIGHT_ANSWER,
} from "@/lib/film/constants";
import { buildFleetGlimpse } from "@/lib/film/fleet-glimpse";
import { DECLINE_STABLECOIN_CUT_MS, resolveBeat, totalDurationMs } from "@/lib/film/phases";
import { initialPlaybackState, restart, tick, togglePlay, type PlaybackState } from "@/lib/story/playback";

const CANVAS_W = 1920;
const CANVAS_H = 1080;

interface MandateInfo {
  mandate_id: string;
  policy_hash: string;
  instrument_id: string;
  safe_address: string;
  compiled_live: boolean;
  summary: string;
}

function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatUsdcAtomic(atomic: bigint): string {
  const usdc = Number(atomic) / 1_000_000;
  return `${usdc.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `${url} failed (HTTP ${res.status})`);
  return json as T;
}

// Module-scope, not nested inside FilmClient: a component defined inside
// another component's render body gets a fresh identity every render,
// which for a clock-driven component re-rendering every frame means
// remounting this whole subtree (and re-running its effects) constantly
// instead of once.

function Act1Device({ muted, flash, children }: { muted: boolean; flash: boolean; children: React.ReactNode }) {
  return (
    <div className="film-device-wrap">
      <div className={`film-device ${muted ? "film-device--muted" : ""} ${flash ? "film-device--flash" : ""}`}>
        <div className="film-notch" />
        <div className="film-device-status">
          <span>9:41</span>
          <span>●●●●●</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Balance({ label, value, zero }: { label: string; value: string; zero?: boolean }) {
  return (
    <div className="film-balance">
      <div className="film-balance-label">{label}</div>
      <div className={`film-balance-value ${zero ? "film-balance-value--zero" : ""}`}>{value}</div>
    </div>
  );
}

function Act2Split(props: {
  rightThrough?: number;
  notifications?: ReturnType<typeof buildAct1Notifications>;
  cardAttempts?: CardAttemptResult[] | null;
  cardError?: string | null;
  activeCardIndex?: number;
  stablecoinRejection?: StablecoinRejection | null;
  stablecoinError?: string | null;
  children?: React.ReactNode;
}) {
  const through = props.rightThrough ?? 0;
  return (
    <div className="film-split">
      <div className="film-split-divider" />
      <div className="film-split-col">
        <div className="film-split-title film-split-title--left">WITHOUT WAYSAFE</div>
        <div className="film-muted-icon">muted replay</div>
        <div className="film-device film-device--small film-device--muted" style={{ marginTop: 40 }}>
          <div className="film-notch" />
          <div className="film-balances">
            <Balance label="card" value={formatUsd(0)} zero />
            <Balance label="wallet" value={formatUsdcAtomic(0n)} zero />
          </div>
          <div className="film-notification-stack">
            {(props.notifications ?? []).map((n) => (
              <div className="film-notification" key={n.index}>{n.label}</div>
            ))}
          </div>
        </div>
      </div>
      <div className="film-split-col">
        <div className="film-split-title film-split-title--right">WITH WAYSAFE</div>
        <div className="film-device film-device--small" style={{ marginTop: 40 }}>
          <div className="film-notch" />
          <div className="film-notification-stack">
            {(props.notifications ?? []).slice(0, through).map((n, i) => {
              if (n.rail === "card") {
                const attemptIndex = props.notifications!.slice(0, i + 1).filter((x) => x.rail === "card").length - 1;
                const attempt = props.cardAttempts?.[attemptIndex];
                return (
                  <div className="film-notification film-notification--right" key={n.index}>
                    <span>{n.label}</span>
                    {attempt ? (
                      <span className="film-decline-badge">{attempt.decision}</span>
                    ) : props.cardError ? (
                      <span className="film-decline-badge">UNAVAILABLE</span>
                    ) : (
                      <span className="film-decline-badge">EVALUATING</span>
                    )}
                    <span className="film-replayed-tag">{CARD_REPLAY_TAG}</span>
                  </div>
                );
              }
              return (
                <div className="film-notification film-notification--right" key={n.index}>
                  <span>{n.label}</span>
                  {props.stablecoinRejection ? (
                    <span className="film-decline-badge">REJECTED ON-CHAIN</span>
                  ) : props.stablecoinError ? (
                    <span className="film-decline-badge">UNAVAILABLE</span>
                  ) : (
                    <span className="film-decline-badge">EVALUATING</span>
                  )}
                </div>
              );
            })}
          </div>
          {props.activeCardIndex !== undefined ? (
            <div style={{ padding: "0 16px 12px" }} className="film-notification-reason">
              {props.cardAttempts?.[props.activeCardIndex]?.reasonCodes.join(", ") ?? ""}
            </div>
          ) : null}
          {props.stablecoinRejection ? (
            <div style={{ padding: "0 16px 12px" }} className="film-notification-reason">
              {props.stablecoinRejection.revertReason ?? "reverted"}
            </div>
          ) : null}
        </div>
      </div>
      {props.children}
    </div>
  );
}

function FleetGlimpseCanvas({ fleet }: { fleet: ReturnType<typeof buildFleetGlimpse> }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#030405";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const compromisedAt = new Map(fleet.compromise.map((c) => [c.agentId, c.atMs]));
    // A snapshot near full spread -- the real compromise timing this
    // fleet's own attack actually produced, not a fabricated "everyone is
    // red" image.
    const snapshotElapsed = fleet.config.spreadWindowMs;
    for (const agent of fleet.agents) {
      const compAt = compromisedAt.get(agent.id);
      const isCompromised = compAt !== undefined && snapshotElapsed >= compAt;
      const x = 200 + agent.x * (CANVAS_W - 400);
      const y = 160 + agent.y * (CANVAS_H - 320);
      ctx.beginPath();
      ctx.arc(x, y, isCompromised ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isCompromised ? "#f87171" : "#3b4a5f";
      ctx.fill();
    }
    // A handful of real denied attempts, drawn as faint lines toward the
    // edge -- the same rails /story draws, RAILS.length of them.
    const denies = fleet.decisions.filter((d) => d.decision === "DENY").slice(0, 40);
    for (const d of denies) {
      const agent = fleet.agents[d.attempt.agentId];
      if (!agent) continue;
      const x = 200 + agent.x * (CANVAS_W - 400);
      const y = 160 + agent.y * (CANVAS_H - 320);
      const laneIndex = RAILS.indexOf(d.attempt.rail);
      const targetX = CANVAS_W - 220;
      const targetY = 220 + laneIndex * ((CANVAS_H - 440) / RAILS.length);
      ctx.strokeStyle = "rgba(252,165,165,0.15)";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(targetX, targetY);
      ctx.stroke();
    }
  }, [fleet]);

  return <canvas className="film-fleet-canvas" ref={canvasRef} width={CANVAS_W} height={CANVAS_H} />;
}

export function FilmClient({ seed, autoplay }: { seed: number; autoplay: boolean }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const playbackRef = useRef<PlaybackState>(initialPlaybackState(false));
  const lastTsRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);
  const uiReadyRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [status, setStatus] = useState<PlaybackState["status"]>("paused");

  const [mandate, setMandate] = useState<MandateInfo | null>(null);
  const [cardAttempts, setCardAttempts] = useState<CardAttemptResult[] | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [stablecoinRejections, setStablecoinRejections] = useState<StablecoinRejection[] | null>(null);
  const [bypassError, setBypassError] = useState<string | null>(null);
  const [stablecoinAllow, setStablecoinAllow] = useState<StablecoinPayResult | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<{ events: BrowserEvidenceEvent[]; publicKey: string } | null>(null);
  const [verifyResult, setVerifyResult] = useState<BrowserChainVerificationResult | null>(null);
  const [tamperedVerifyResult, setTamperedVerifyResult] = useState<BrowserChainVerificationResult | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const fleet = useMemo(() => buildFleetGlimpse(seed), [seed]);
  const notifications = useMemo(() => buildAct1Notifications(), []);

  // Real setup, once, as early as possible -- see file doc comment.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const m = await postJson<MandateInfo>("/api/demo/mandate", {});
        if (cancelled) return;
        setMandate(m);

        // A second, independent mandate for the card replay -- not the
        // same one the x402 instrument above already claimed.
        // `Instrument.mandateId` is `@unique` (one instrument per mandate,
        // D-32 item 3), so a card instrument for `m` would collide with
        // its x402 instrument. `provision_x402: false` (D-44's own small
        // addition to this route) skips that step for this one. Two real,
        // independently authenticated mandates -- exactly what a
        // principal delegating both a card and a wallet to their agent
        // would actually have -- rather than a schema change to fit one
        // page.
        const cardMandate = await postJson<MandateInfo>("/api/demo/mandate", { provision_x402: false });
        if (cancelled) return;

        const results = await Promise.allSettled([
          postJson<{ instrument_id: string; attempts: unknown[] }>("/api/demo/card", { mandate_id: cardMandate.mandate_id }),
          postJson<{ safe_address: string; cases: unknown[] }>("/api/demo/bypass", { instrument_id: m.instrument_id }),
          postJson<Record<string, unknown>>("/api/demo/pay", {
            scenario: "allowed",
            instrument_id: m.instrument_id,
            safe_address: m.safe_address,
          }),
        ]);
        if (cancelled) return;

        const [cardRes, bypassRes, payRes] = results;
        if (cardRes.status === "fulfilled") {
          try {
            setCardAttempts(cardRes.value.attempts.map(normalizeCardAttempt));
          } catch (err) {
            setCardError(err instanceof Error ? err.message : String(err));
          }
        } else {
          setCardError(cardRes.reason instanceof Error ? cardRes.reason.message : String(cardRes.reason));
        }

        if (bypassRes.status === "fulfilled") {
          try {
            setStablecoinRejections(bypassRes.value.cases.map(normalizeStablecoinRejection));
          } catch (err) {
            setBypassError(err instanceof Error ? err.message : String(err));
          }
        } else {
          setBypassError(bypassRes.reason instanceof Error ? bypassRes.reason.message : String(bypassRes.reason));
        }

        if (payRes.status === "fulfilled") {
          try {
            setStablecoinAllow(normalizeStablecoinPayResult(payRes.value));
          } catch (err) {
            setPayError(err instanceof Error ? err.message : String(err));
          }
        } else {
          setPayError(payRes.reason instanceof Error ? payRes.reason.message : String(payRes.reason));
        }

        // Fetched after the ALLOW attempt so its evidence event exists.
        const evRes = await fetch("/api/demo/evidence");
        const evBody = await evRes.json();
        if (cancelled) return;
        if (evRes.ok) {
          setEvidence({ events: evBody.events, publicKey: evBody.public_key });
        }
      } catch (err) {
        if (!cancelled) setSetupError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          uiReadyRef.current = true;
          playbackRef.current = initialPlaybackState(autoplay);
          setStatus(playbackRef.current.status);
          setReady(true);
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute both the real and the tampered verification once evidence is in.
  useEffect(() => {
    if (!evidence) return;
    let cancelled = false;
    void verifyEvidenceChainInBrowser(evidence.events, evidence.publicKey).then((r) => {
      if (!cancelled) setVerifyResult(r);
    });
    const tampered = evidence.events.map((e, i) =>
      i === evidence.events.length - 1 ? { ...e, payload: { ...e.payload, __tampered: true } } : e,
    );
    void verifyEvidenceChainInBrowser(tampered, evidence.publicKey).then((r) => {
      if (!cancelled) setTamperedVerifyResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [evidence]);

  // Fit-to-viewport, same technique as /story.
  useEffect(() => {
    function fit() {
      const stage = stageRef.current;
      if (!stage) return;
      const scale = Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H);
      stage.style.transform = `scale(${scale})`;
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Keyboard: space play/pause, R restart (playback position only -- the
  // real setup above runs exactly once per page load, never re-provisioned
  // just to rewind).
  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (!uiReadyRef.current) return;
      if (e.code === "Space") {
        e.preventDefault();
        playbackRef.current = togglePlay(playbackRef.current);
        setStatus(playbackRef.current.status);
        lastTsRef.current = null;
      } else if (e.key === "r" || e.key === "R") {
        playbackRef.current = restart();
        setStatus(playbackRef.current.status);
        setElapsedMs(0);
        lastTsRef.current = null;
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  // Master clock.
  useEffect(() => {
    if (!ready) return;
    function frame(ts: number) {
      const last = lastTsRef.current ?? ts;
      const delta = Math.min(2000, ts - last);
      lastTsRef.current = ts;

      playbackRef.current = tick(playbackRef.current, delta, totalDurationMs());
      setElapsedMs(playbackRef.current.elapsedMs);
      if (playbackRef.current.status !== status) setStatus(playbackRef.current.status);

      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const resolved = resolveBeat(elapsedMs);
  const beatId = resolved.beat.id;
  const beatElapsedMs = resolved.beatElapsedMs;

  return (
    <div className="film-viewport">
      <div className="film-stage" ref={stageRef}>
        {/* All mandate/Safe/instrument setup happens behind a plain black
            frame -- no text, no tags, no overlays -- so a recording that
            starts on ?autoplay=1 never shows provisioning as part of the
            film. Act 1 begins, and everything below appears, only once
            `ready` is true (setup finished, successfully or not). */}
        {ready ? (
          <>
            {resolved.beat.act < 3 ? <div className="film-dramatization-tag film-overlay">DRAMATIZATION</div> : null}
            {resolved.beat.act === 3 ? <div className="film-real-tag film-overlay">EVERYTHING FROM HERE IS REAL</div> : null}
            <div className="film-keys film-overlay">space: play/pause &nbsp;·&nbsp; r: restart &nbsp;·&nbsp; seed {seed}</div>
            <a className="film-back film-overlay" href="/demo" style={{ pointerEvents: "auto" }}>
              proof: /demo ↗
            </a>

            {setupError ? (
              <div className="film-center-hint">
                <div className="film-center-hint-title" style={{ color: "#fca5a5" }}>setup failed</div>
                <div className="film-center-hint-sub">{setupError}</div>
              </div>
            ) : null}

            {status === "paused" && !setupError ? (
              <div className="film-center-hint">
                <div className="film-center-hint-title">▶ press space to play</div>
                <div className="film-center-hint-sub">r restarts · ?autoplay=1 starts immediately</div>
              </div>
            ) : null}

            {!setupError ? renderBeat() : null}
          </>
        ) : null}
      </div>
    </div>
  );

  function renderBeat() {
    switch (beatId) {
      case "intro":
        return (
          <Act1Device muted={false} flash={false}>
            <div className="film-agent-panel">
              <div className="film-agent-title">the agent, working</div>
              {AGENT_TASKS.map((t) => (
                <div className="film-agent-task" key={t}>{t}</div>
              ))}
            </div>
            <div className="film-balances">
              <Balance label="card" value={formatUsd(balancesAtMs(0).cardCents)} />
              <Balance label="wallet" value={formatUsdcAtomic(balancesAtMs(0).walletAtomic)} />
            </div>
            <div className="film-notification-stack" />
          </Act1Device>
        );

      case "compromise":
        return (
          <Act1Device muted={false} flash={true}>
            <div className="film-agent-panel">
              <div className="film-agent-title">the agent, working</div>
              {AGENT_TASKS.map((t) => (
                <div className="film-agent-task" key={t}>{t}</div>
              ))}
            </div>
            <div className="film-balances">
              <Balance label="card" value={formatUsd(balancesAtMs(0).cardCents)} />
              <Balance label="wallet" value={formatUsdcAtomic(balancesAtMs(0).walletAtomic)} />
            </div>
            <div className="film-notification-stack" />
            <div className="film-caption-big film-caption-big--danger">{COMPROMISE_CAPTION}</div>
          </Act1Device>
        );

      case "drain": {
        const balances = balancesAtMs(beatElapsedMs);
        const visible = notifications.filter((n) => n.atMs <= beatElapsedMs);
        return (
          <Act1Device muted={false} flash={false}>
            <div className="film-balances">
              <Balance label="card" value={formatUsd(balances.cardCents)} zero={balances.cardCents === 0} />
              <Balance label="wallet" value={formatUsdcAtomic(balances.walletAtomic)} zero={balances.walletAtomic === 0n} />
            </div>
            <div className="film-notification-stack">
              {visible.map((n) => (
                <div className="film-notification" key={n.index}>{n.label}</div>
              ))}
            </div>
          </Act1Device>
        );
      }

      case "empty": {
        const balances = balancesAtMs(999_999);
        return (
          <Act1Device muted={false} flash={false}>
            <div className="film-balances">
              <Balance label="card" value={formatUsd(balances.cardCents)} zero />
              <Balance label="wallet" value={formatUsdcAtomic(balances.walletAtomic)} zero />
            </div>
            <div className="film-notification-stack">
              {notifications.map((n) => (
                <div className="film-notification" key={n.index}>{n.label}</div>
              ))}
            </div>
          </Act1Device>
        );
      }

      case "replay-intro":
        return (
          <Act2Split>
            <div className="film-caption-big film-caption-big--waysafe" style={{ top: "8%", fontSize: 40 }}>
              identical compromise. identical attempts.
            </div>
          </Act2Split>
        );

      case "decline-card-1":
        return <Act2Split rightThrough={1} cardAttempts={cardAttempts} cardError={cardError} notifications={notifications} activeCardIndex={0} />;

      case "quote":
        return (
          <div className="film-quote-wrap">
            <div className="film-quote-card">
              <div className="film-quote-text">&ldquo;{AGENT_REASONING_QUOTE}&rdquo;</div>
              <div className="film-quote-attribution">{AGENT_REASONING_ATTRIBUTION}</div>
            </div>
          </div>
        );

      case "decline-stablecoin": {
        const showThresholdCaption = beatElapsedMs >= DECLINE_STABLECOIN_CUT_MS;
        const rejection = stablecoinRejections?.[0] ?? null;
        return (
          <Act2Split
            rightThrough={2}
            notifications={notifications}
            cardAttempts={cardAttempts}
            cardError={cardError}
            stablecoinRejection={rejection}
            stablecoinError={bypassError}
          >
            <div className="film-caption-big film-caption-big--waysafe" style={{ top: "78%", fontSize: 40 }}>
              {showThresholdCaption ? STABLECOIN_THRESHOLD_CAPTION : STABLECOIN_REVERT_CAPTION}
            </div>
          </Act2Split>
        );
      }

      case "decline-card-2":
        return (
          <Act2Split
            rightThrough={3}
            cardAttempts={cardAttempts}
            cardError={cardError}
            notifications={notifications}
            activeCardIndex={1}
            stablecoinRejection={stablecoinRejections?.[0] ?? null}
            stablecoinError={bypassError}
          />
        );

      case "allow":
        return (
          <div className="film-panel-wrap">
            <div className="film-panel">
              <div className="film-panel-title">meanwhile: an in-mandate purchase still goes through</div>
              <div className="film-panel-body">
                The agent pays GoodBeans API $0.50 for one inference credit — on the mandate&rsquo;s allowlist.
              </div>
              <div style={{ marginTop: 16 }}>
                {!stablecoinAllow && !payError ? <span className="film-badge film-badge--rejected">EVALUATING</span> : null}
                {payError ? <div className="film-mono" style={{ color: "#fca5a5" }}>{payError}</div> : null}
                {stablecoinAllow ? (
                  <>
                    <span className={`film-badge film-badge--${stablecoinAllow.decision === "ALLOW" ? "allow" : "deny"}`}>
                      {stablecoinAllow.decision}
                    </span>
                    <div className="film-mono" style={{ marginTop: 10 }}>
                      {stablecoinAllow.reasonCodes.join(", ") || "(no reason codes)"}
                    </div>
                    {stablecoinAllow.settlementTxHash ? (
                      <div style={{ marginTop: 10 }}>
                        <a className="film-link" href={polygonScanTxUrl(stablecoinAllow.settlementTxHash)} target="_blank" rel="noreferrer">
                          settled on-chain ↗
                        </a>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        );

      case "fleet-glimpse":
        return (
          <>
            <FleetGlimpseCanvas fleet={fleet} />
            <div className="film-fleet-caption">{FLEET_GLIMPSE_CAPTION}</div>
          </>
        );

      case "receipt":
        return (
          <div className="film-panel-wrap">
            <div className="film-panel">
              <div className="film-panel-title">the real receipt</div>
              <div className="film-panel-body">
                <div>actor: instrument</div>
                <div className="film-mono">Safe {mandate ? maskExternalRef(mandate.safe_address) : "…"}</div>
                {stablecoinAllow ? (
                  <>
                    <div style={{ marginTop: 10 }}>
                      <span className={`film-badge film-badge--${stablecoinAllow.decision === "ALLOW" ? "allow" : "deny"}`}>
                        {stablecoinAllow.decision}
                      </span>
                    </div>
                    <div className="film-mono" style={{ marginTop: 10 }}>{stablecoinAllow.reasonCodes.join(", ")}</div>
                  </>
                ) : null}
                {mandate ? <div className="film-mono" style={{ marginTop: 10 }}>policy_hash {mandate.policy_hash}</div> : null}
              </div>
            </div>
          </div>
        );

      case "chain":
        return (
          <div className="film-panel-wrap">
            <div className="film-panel">
              <div className="film-panel-title">the signed evidence chain</div>
              <div className="film-chain-list">
                {(evidence?.events ?? []).map((e) => (
                  <div className="film-chain-event" key={e.sequence}>
                    <span className="film-mono">#{e.sequence}</span> {e.type} — {e.subject_type}:{e.subject_id}
                  </div>
                ))}
                {!evidence ? <div className="film-panel-body">loading the real chain…</div> : null}
              </div>
            </div>
          </div>
        );

      case "verify": {
        const showTampered = beatElapsedMs >= resolved.beat.durationMs / 2;
        const result = showTampered ? tamperedVerifyResult : verifyResult;
        return (
          <div className="film-panel-wrap">
            <div className="film-panel">
              <div className="film-panel-title">
                verifyEvidenceIndependently — running in this browser, via WebCrypto
              </div>
              {!result ? <div className="film-panel-body">verifying…</div> : null}
              {result ? (
                <div className={result.ok ? "film-verify-pass" : "film-verify-fail"}>
                  {result.ok ? "VERIFIED" : `NOT VERIFIED (${result.reason})`}
                </div>
              ) : null}
              <div className="film-panel-body" style={{ marginTop: 10 }}>
                {showTampered ? "one byte of the last event's payload, flipped" : "the real, untouched chain"}
              </div>
            </div>
          </div>
        );
      }

      case "aftermath": {
        const showQuestion = beatElapsedMs < resolved.beat.durationMs * 0.35;
        return (
          <div className="film-aftermath">
            {showQuestion ? (
              <div className="film-aftermath-question">{WHO_PAYS_QUESTION}</div>
            ) : (
              <div className="film-aftermath-answers">
                <div className="film-aftermath-col film-aftermath-col--left">
                  <div className="film-aftermath-answer">{WHO_PAYS_LEFT_ANSWER}</div>
                </div>
                <div className="film-aftermath-col film-aftermath-col--right">
                  <div className="film-aftermath-answer">{WHO_PAYS_RIGHT_ANSWER}</div>
                </div>
              </div>
            )}
          </div>
        );
      }

      case "endcard":
        return (
          <div className="film-end-card">
            <div className="film-end-line-1">
              {END_CARD_LINE_1A}
              <br />
              {END_CARD_LINE_1B}
            </div>
            <div className="film-end-line-2">{END_CARD_LINE_2}</div>
            <div className="film-end-line-3">
              {END_CARD_LINE_3.replace("/demo", "")}
              <a className="film-link" href="/demo">/demo</a>
            </div>
          </div>
        );

      default:
        return null;
    }
  }

}
