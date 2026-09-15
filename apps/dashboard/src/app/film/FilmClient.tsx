"use client";

/**
 * D-45: `/film`, rebuilt to match `design/film-storyboard/` exactly. The
 * data/decision plumbing is unchanged from D-44: every decision shown is
 * still the real one (the replayed Stripe Issuing adapter, the real
 * on-chain Safe rejection and ALLOW, the real evidence chain) -- see
 * `lib/film/api-decisions.ts`'s own doc comment for why that module, not a
 * client-side stub of `evaluate()`, is this page's honesty boundary. What
 * changed is purely presentational: ten storyboard frames, reproduced
 * frame-for-frame, with the same real data slotted into each one's real
 * fields (an authorization id, a mandate version id, a policy hash, an
 * evidence event's own hash/signature/sequence -- D-45's own addition to
 * `stripe-issuing.ts` and the demo route, so Act 3's receipt can cite a
 * genuine record instead of a placeholder).
 *
 * All real setup (two mandates, the x402 Safe instrument, the card replay,
 * the on-chain rejection, the genuine ALLOW, the evidence chain) is kicked
 * off once, as early as possible, behind a plain black frame -- no text --
 * so a `?autoplay=1` recording never shows provisioning as part of the
 * film (commit 3d605b0). If the real API is unreachable, the film fails
 * loudly with a visible error; it never substitutes a scripted decision.
 *
 * D-46 second pass from the first recording: retimed every beat
 * (`lib/film/phases.ts`, now 70s total; `aftermath` renamed `results`),
 * rebranded the accent from cyan to the real brand teal/mark
 * (`IconWaysafeMark`, `icons.tsx`), rewrote several frames' copy, replaced
 * the per-frame honesty tags with one end-card footnote
 * (`END_CARD_FOOTNOTE`), and rebuilt frame 06's revert card and frame 10's
 * end card. See DECISIONS.md D-46 for the reasoning behind each.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { verifyEvidenceChainInBrowser, type BrowserChainVerificationResult, type BrowserEvidenceEvent } from "@/lib/demo/browser-verify";
import {
  normalizeCardReplayResult,
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
  ALLOW_BODY,
  ALLOW_HEADLINE_LINE_1,
  ALLOW_HEADLINE_LINE_2,
  ALLOW_KICKER,
  ALLOW_SIGNED_LINE,
  ALLOW_SPEND_LINE,
  ATTACKER_NOTIFICATIONS,
  COMPROMISE_CAPTION,
  COMPROMISE_HEADLINE_LINE_1,
  COMPROMISE_HEADLINE_LINE_2,
  COMPROMISE_KICKER,
  DECLINED_WORD,
  DECLINE_CARD_1_BODY,
  DECLINE_CARD_1_SUBHEAD,
  DECLINE_CARD_KICKER,
  DECLINE_MERCHANT_NOTE,
  DECLINE_SIGNED_LINES,
  DRAIN_BODY,
  DRAIN_HEADLINE_LINE_1,
  DRAIN_HEADLINE_LINE_2,
  DRAIN_KICKER,
  END_CARD_FOOTNOTE,
  END_CARD_LINE_1A,
  END_CARD_LINE_1B,
  END_CARD_LINE_3,
  END_CARD_TAGLINE,
  END_CARD_WORDMARK,
  EVIDENCE_BODY,
  EVIDENCE_HEADLINE_LINE_1,
  EVIDENCE_HEADLINE_LINE_2,
  EVIDENCE_HEADLINE_LINE_3,
  EVIDENCE_KICKER,
  FILM_INSTRUCTION,
  FLEET_GLIMPSE_CAPTION,
  INTRO_BODY,
  INTRO_HEADLINE_LINE_1,
  INTRO_HEADLINE_LINE_2,
  INTRO_KICKER,
  MANDATE_CARD_FOOTER,
  MANDATE_CARD_LABEL,
  MANDATE_CARD_TITLE,
  QUOTE_KICKER,
  RECEIPT_TITLE,
  REPLAY_INTRO_KICKER,
  RESULTS_KICKER,
  SAFE_PANEL_LABEL,
  SAFE_ROW_COSIGNER_SUB,
  SAFE_ROW_COSIGNER_TITLE,
  SAFE_ROW_SESSION_SUB,
  SAFE_ROW_SESSION_TITLE,
  STABLECOIN_HEADLINE_LINE_1,
  STABLECOIN_HEADLINE_LINE_2,
  STABLECOIN_THRESHOLD_CAPTION,
  TERMINAL_COMMAND,
  TERMINAL_LINE_CARD,
  TERMINAL_LINE_WALLET,
  VERIFIED_BAR_FN,
  VERIFIED_BAR_TEXT,
  WAYSAFE_NOTIF_ALLOW_MSG,
  WAYSAFE_NOTIF_ALLOW_TITLE,
  WAYSAFE_NOTIF_DECLINE_1_MSG,
  WAYSAFE_NOTIF_DECLINE_1_TITLE,
  WHO_PAYS_LEFT_ANSWER,
  WHO_PAYS_LEFT_KICKER,
  WHO_PAYS_QUESTION,
  WHO_PAYS_RIGHT_ANSWER,
  WHO_PAYS_RIGHT_KICKER,
} from "@/lib/film/constants";
import { findEvidenceEventForAuthorization, formatPolicyHash, truncateHash } from "@/lib/film/evidence-lookup";
import { frameForBeat, type FrameId } from "@/lib/film/frame-map";
import { BEATS, DECLINE_STABLECOIN_CUT_MS, beatStartMs, resolveBeat, totalDurationMs } from "@/lib/film/phases";
import { formatSafeRevertLines } from "@/lib/film/safe-revert";
import { initialPlaybackState, restart, tick, togglePlay, type PlaybackState } from "@/lib/story/playback";
import { IconAlert, IconBed, IconBolt, IconCalendar, IconCheck, IconHarborMark, IconRobot, IconSecure, IconShieldCheck, IconWaysafeMark, IconX } from "./icons";
import { Phone, type PhoneNotification, type PhoneRow } from "./Phone";

/** D-46: each stacked notification's vertical increment -- a real card's
 * rendered height (~84px for a 1-2 line message) plus the task's own
 * 12px flush gap, no rotation, same left edge (fixed by `.film-notif`). */
const NOTIF_STACK_STEP = 96;

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

const FRAME_START_MS = new Map<FrameId, number>();
for (const beat of BEATS) {
  const frame = frameForBeat(beat.id);
  if (!FRAME_START_MS.has(frame)) FRAME_START_MS.set(frame, beatStartMs(beat.id));
}

function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatUsdcAtomic(atomic: bigint): string {
  const usdc = Number(atomic) / 1_000_000;
  return `${usdc.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

/** D-47: frame 03's countdown target -- a bare whole number ("2,500", "0"),
 * matching the line's own fixed "2,500 USDC →" lead-in rather than
 * repeating the "USDC" suffix or adding decimals a whole-dollar step never
 * needs (there's exactly one wallet notification, so this only ever reads
 * the starting figure or zero). */
function formatUsdcWhole(atomic: bigint): string {
  const usdc = Number(atomic) / 1_000_000;
  return usdc.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `${url} failed (HTTP ${res.status})`);
  return json as T;
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

  const [cardAttempts, setCardAttempts] = useState<CardAttemptResult[] | null>(null);
  const [cardMandateInfo, setCardMandateInfo] = useState<{ mandateVersionId: string; policyHash: string } | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [stablecoinRejections, setStablecoinRejections] = useState<StablecoinRejection[] | null>(null);
  const [stablecoinSafeAddress, setStablecoinSafeAddress] = useState<string | null>(null);
  const [bypassError, setBypassError] = useState<string | null>(null);
  const [stablecoinAllow, setStablecoinAllow] = useState<StablecoinPayResult | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<{ events: BrowserEvidenceEvent[]; publicKey: string } | null>(null);
  const [verifyResult, setVerifyResult] = useState<BrowserChainVerificationResult | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const notifications = useMemo(() => buildAct1Notifications(), []);

  // Real setup, once, as early as possible -- see file doc comment.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const m = await postJson<MandateInfo>("/api/demo/mandate", {});
        if (cancelled) return;

        // A second, independent mandate for the card replay -- not the
        // same one the x402 instrument above already claimed.
        // `Instrument.mandateId` is `@unique` (one instrument per mandate,
        // D-32 item 3), so a card instrument for `m` would collide with
        // its x402 instrument. `provision_x402: false` skips that step.
        const cardMandate = await postJson<MandateInfo>("/api/demo/mandate", { provision_x402: false });
        if (cancelled) return;

        const results = await Promise.allSettled([
          postJson<Record<string, unknown>>("/api/demo/card", { mandate_id: cardMandate.mandate_id }),
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
            const parsed = normalizeCardReplayResult(cardRes.value);
            setCardAttempts(parsed.attempts);
            setCardMandateInfo({ mandateVersionId: parsed.mandateVersionId, policyHash: parsed.policyHash });
          } catch (err) {
            setCardError(err instanceof Error ? err.message : String(err));
          }
        } else {
          setCardError(cardRes.reason instanceof Error ? cardRes.reason.message : String(cardRes.reason));
        }

        if (bypassRes.status === "fulfilled") {
          try {
            setStablecoinRejections(bypassRes.value.cases.map(normalizeStablecoinRejection));
            setStablecoinSafeAddress(bypassRes.value.safe_address);
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

  // Real verification, once evidence is in -- see the `verify` beat below
  // for the tamper toggle, which recomputes on demand rather than eagerly.
  useEffect(() => {
    if (!evidence) return;
    let cancelled = false;
    void verifyEvidenceChainInBrowser(evidence.events, evidence.publicKey).then((r) => {
      if (!cancelled) setVerifyResult(r);
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
  const frameId = frameForBeat(beatId);
  const frameElapsedMs = elapsedMs - (FRAME_START_MS.get(frameId) ?? 0);

  const cardAttempt1 = cardAttempts?.[0] ?? null;
  const cardAttempt2 = cardAttempts?.[1] ?? null;
  const stablecoinRejection = stablecoinRejections?.[0] ?? null;

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
            {renderCornerChrome()}

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

            {!setupError ? (
              <div key={frameId} className="film-frame film-frame-enter" style={{ background: frameBackground(frameId) }}>
                {renderFrame()}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );

  function renderCornerChrome() {
    const act = resolved.beat.act;
    // D-46: this link is a persistent overlay shown across every frame,
    // light and dark alike -- `.film-link`'s CSS default (#008389) only
    // covers the light case, so the dark frames need the lightened
    // midnight variant applied inline instead of a second static class.
    const linkColor = frameBackground(frameId) === "#07111F" ? "#22B8BE" : undefined;
    return (
      <>
        {act < 3 ? <div className="film-dramatization-tag film-overlay">dramatization</div> : null}
        {act === 3 ? <div className="film-real-tag film-overlay">everything from here is real</div> : null}
        <div className="film-keys film-overlay">space: play/pause · r: restart · seed {seed}</div>
        <a className="film-back film-overlay film-link" href="/demo" style={{ pointerEvents: "auto", color: linkColor }}>
          proof: /demo ↗
        </a>
      </>
    );
  }

  function renderFrame() {
    switch (frameId) {
      case "01-intro":
        return renderIntro();
      case "02-compromise":
        return renderCompromise();
      case "03-drain-empty":
        return renderDrainEmpty();
      case "04-replay-intro":
        return renderReplayIntro();
      case "05-decline-card-1":
        return renderDeclineCard1();
      case "06-quote-decline-stablecoin":
        return renderQuoteDeclineStablecoin();
      case "07-allow-fleet-glimpse":
        return renderAllowFleetGlimpse();
      case "08-receipt-chain-verify":
        return renderReceiptChainVerify();
      case "09-aftermath":
        return renderResults();
      case "10-endcard":
        return renderEndcard();
      default:
        return null;
    }
  }

  // --- Frame 01: intro ------------------------------------------------------

  function renderIntro() {
    const rows: PhoneRow[] = AGENT_TASKS.map((task, i) => ({
      key: task.title,
      icon: i === 0 ? <IconBed color="#475569" /> : i === 1 ? <IconBolt color="#475569" /> : <IconCalendar color="#475569" />,
      iconBg: "#E2E8F0",
      iconColor: "#475569",
      title: task.title,
      subtitle: task.subtitle,
      amount: task.amount,
      status: { text: "Approved", color: "#22C55E" },
    })).filter((_, i) => frameElapsedMs >= 300 + i * 1200);

    return (
      <>
        <Reveal active={revealedAt(0)}>
          <div className="film-kicker" style={{ position: "absolute", left: 140, top: 150, color: "#64748B" }}>{INTRO_KICKER}</div>
          <div className="film-display" style={{ position: "absolute", left: 136, top: 300, width: 900, fontSize: 148, fontWeight: 600, color: "#07111F" }}>
            {INTRO_HEADLINE_LINE_1}<br />{INTRO_HEADLINE_LINE_2}
          </div>
          <div style={{ position: "absolute", left: 140, top: 664, width: 760, fontSize: 36, lineHeight: 1.3, color: "#334155" }}>{INTRO_BODY}</div>
        </Reveal>
        <Phone
          variant="light"
          cardBalance={formatUsd(balancesAtMs(0).cardCents)}
          walletBalance={formatUsdcAtomic(balancesAtMs(0).walletAtomic)}
          activityBadge={{ label: "Agent working", icon: <IconRobot size={14} color="#22C55E" />, bg: "#DCFCE7", color: "#22C55E" }}
          rows={rows}
        />
      </>
    );
  }

  // --- Frame 02: compromise --------------------------------------------------

  function renderCompromise() {
    const terminalLines = [TERMINAL_COMMAND, TERMINAL_LINE_CARD, TERMINAL_LINE_WALLET, COMPROMISE_CAPTION];
    return (
      <>
        <div className="film-kicker" style={{ position: "absolute", left: 140, top: 150, color: "#94A3B8" }}>{COMPROMISE_KICKER}</div>
        <div className="film-display" style={{ position: "absolute", left: 136, top: 250, width: 1060, fontSize: 110, fontWeight: 600, color: "#F7F9FC" }}>
          {COMPROMISE_HEADLINE_LINE_1}<br />{COMPROMISE_HEADLINE_LINE_2}
        </div>
        <div className="film-mono" style={{ position: "absolute", left: 140, top: 560, width: 840, padding: "28px 32px", borderRadius: 18, background: "#020817", border: "1px solid #1E293B", fontSize: 22, lineHeight: 1.65, color: "#CBD5E1" }}>
          {terminalLines.map((line, i) => (
            <div key={line} style={{ color: i === 0 ? "#94A3B8" : i === 3 ? "#22B8BE" : undefined, marginTop: i === 3 ? 6 : 0, opacity: beatElapsedMs >= i * 375 ? 1 : 0, transition: "opacity 180ms" }}>
              {line}
            </div>
          ))}
        </div>
        <Phone
          variant="dark"
          cardBalance={formatUsd(balancesAtMs(0).cardCents)}
          walletBalance={formatUsdcAtomic(balancesAtMs(0).walletAtomic)}
          rows={AGENT_TASKS.map((task, i) => ({
            key: task.title,
            icon: i === 0 ? <IconBed color="#94A3B8" /> : i === 1 ? <IconBolt color="#94A3B8" /> : <IconCalendar color="#94A3B8" />,
            iconBg: "#1E293B",
            iconColor: "#94A3B8",
            title: task.title,
            subtitle: task.subtitle,
            amount: task.amount,
            status: { text: "Approved", color: "#4ADE80" },
          }))}
        />
      </>
    );
  }

  // --- Frame 03: drain + empty -----------------------------------------------

  function renderDrainEmpty() {
    const isEmpty = beatId === "empty";
    const drainElapsed = isEmpty ? 999_999 : beatElapsedMs;
    const balances = balancesAtMs(drainElapsed);
    const visible = notifications.filter((n) => n.atMs <= drainElapsed);

    const rows: PhoneRow[] = visible
      .map((n) => ATTACKER_NOTIFICATIONS[n.index]!)
      .reverse()
      .map((n) => ({
        key: n.rowTitle,
        icon: <IconAlert color="#EF4444" />,
        iconBg: "#FEE2E2",
        iconColor: "#EF4444",
        title: n.rowTitle,
        subtitle: n.rowSubtitle,
        amount: n.rowAmount,
      }));

    return (
      <>
        <div className="film-kicker" style={{ position: "absolute", left: 140, top: 150, color: "#94A3B8" }}>{DRAIN_KICKER}</div>
        <div className="film-display" style={{ position: "absolute", left: 136, top: 280, width: 1000, fontSize: 140, fontWeight: 600, color: "#F7F9FC" }}>
          {DRAIN_HEADLINE_LINE_1}<br />{DRAIN_HEADLINE_LINE_2}
        </div>
        {/* D-47: the right-hand figure counts down in sync with the phone's
            own balance card -- both read the same `balances` value, so both
            step at the exact instant each notification lands (no separate
            easing/tween of their own: the phone's balance card has none
            either, it just re-renders the new value). */}
        <div style={{ position: "absolute", left: 140, top: 600, display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="film-display" style={{ fontSize: 96, fontWeight: 500, color: "#FCA5A5", letterSpacing: "-0.02em" }}>
            $1,329.99 <span style={{ color: "#94A3B8", fontWeight: 300 }}>→</span> {formatUsd(balances.cardCents)}
          </div>
          <div className="film-display" style={{ fontSize: 96, fontWeight: 500, color: "#FCA5A5", letterSpacing: "-0.02em" }}>
            2,500 USDC <span style={{ color: "#94A3B8", fontWeight: 300 }}>→</span> {formatUsdcWhole(balances.walletAtomic)}
          </div>
        </div>
        <div style={{ position: "absolute", left: 140, top: 880, width: 900, fontSize: 32, lineHeight: 1.3, color: "#94A3B8" }}>{DRAIN_BODY}</div>
        <Phone
          variant="light"
          cardBalance={formatUsd(balances.cardCents)}
          cardBalanceColor={balances.cardCents === 0 ? "#FCA5A5" : undefined}
          walletBalance={formatUsdcAtomic(balances.walletAtomic)}
          rows={rows}
          notifications={visible.map((n, i): PhoneNotification => {
            const content = ATTACKER_NOTIFICATIONS[n.index]!;
            return {
              key: content.rowTitle,
              top: 62 + i * NOTIF_STACK_STEP,
              appIcon: <IconHarborMark />,
              appBg: "#07111F",
              time: content.notifTime,
              title: content.notifTitle,
              message: content.notifMessage,
            };
          })}
        />
      </>
    );
  }

  // --- Frame 04: replay-intro -------------------------------------------------

  function renderReplayIntro() {
    return (
      <>
        <div className="film-kicker" style={{ position: "absolute", left: 0, right: 0, top: 150, textAlign: "center", color: "#64748B" }}>{REPLAY_INTRO_KICKER}</div>
        <div className="film-display" style={{ position: "absolute", left: 0, right: 0, top: 250, textAlign: "center", fontSize: 168, fontWeight: 600, color: "#07111F" }}>
          {END_CARD_LINE_1A.split(" ").slice(0, 2).join(" ")}<br />{END_CARD_LINE_1A.split(" ").slice(2).join(" ")}
        </div>
        <Reveal active={revealedAt(300)} translateY={16}>
          <div style={{ position: "absolute", boxSizing: "border-box", left: 560, top: 600, width: 800, padding: "40px 44px", borderRadius: 28, background: "#FFFFFF", boxShadow: "0 40px 90px -30px rgba(2,6,23,0.35)", display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 44, height: 44, borderRadius: 11, background: "#008389", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <IconShieldCheck />
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: "#07111F" }}>{MANDATE_CARD_TITLE}</div>
                <div className="film-mono" style={{ fontSize: 13, color: "#64748B", letterSpacing: "0.06em" }}>{MANDATE_CARD_LABEL}</div>
              </div>
            </div>
            <div style={{ fontSize: 30, lineHeight: 1.35, color: "#07111F", fontWeight: 500 }}>&ldquo;{FILM_INSTRUCTION}&rdquo;</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 6, borderTop: "1px solid #CBD5E1", fontSize: 17, color: "#334155" }}>
              <IconSecure color="#008389" />
              {MANDATE_CARD_FOOTER}
            </div>
          </div>
        </Reveal>
      </>
    );
  }

  // --- Frame 05: decline-card-1 ------------------------------------------------

  function renderDeclineCard1() {
    const scale = beatElapsedMs >= 300 ? 1 : 1.1 - (beatElapsedMs / 300) * 0.1;
    return (
      <>
        <div className="film-kicker" style={{ position: "absolute", left: 140, top: 150, color: "#94A3B8" }}>{DECLINE_CARD_KICKER}</div>
        <div className="film-display" style={{ position: "absolute", left: 132, top: 250, fontSize: 230, fontWeight: 700, color: "#EF4444", letterSpacing: "-0.05em", transform: `scale(${scale})`, transformOrigin: "left center" }}>
          {DECLINED_WORD}
        </div>
        <Reveal active={revealedAt(400)}>
          <div className="film-display" style={{ position: "absolute", left: 140, top: 520, fontSize: 64, fontWeight: 500, color: "#F7F9FC" }}>{DECLINE_CARD_1_SUBHEAD}</div>
          <div className="film-mono" style={{ position: "absolute", left: 140, top: 640, display: "flex", flexDirection: "column", gap: 14, fontSize: 24, color: "#CBD5E1" }}>
            <div><span className="film-lb" style={{ color: "#94A3B8" }}>decision</span>{cardAttempt1 ? cardAttempt1.decision : cardError ? "UNAVAILABLE" : "EVALUATING"}</div>
            <LabeledLines label="reason" lines={cardAttempt1 ? cardAttempt1.reasonCodes : cardError ? ["UNAVAILABLE"] : ["…"]} valueColor="#FCA5A5" />
            <div><span className="film-lb" style={{ color: "#94A3B8" }}>merchant</span>{DECLINE_MERCHANT_NOTE}</div>
            <LabeledLines label="signed" lines={[...DECLINE_SIGNED_LINES]} />
          </div>
          <div style={{ position: "absolute", left: 140, top: 870, width: 1000, fontSize: 28, lineHeight: 1.35, color: "#94A3B8" }}>{DECLINE_CARD_1_BODY}</div>
        </Reveal>
        <Phone
          variant="light"
          cardBalance={formatUsd(balancesAtMs(0).cardCents)}
          walletBalance={formatUsdcAtomic(balancesAtMs(0).walletAtomic)}
          activityBadge={{ label: "Waysafe on", icon: <IconWaysafeMark size={14} />, bg: "#DDF3F3", color: "#008389" }}
          rows={[
            { key: "unknown-1", icon: <IconX color="#EF4444" />, iconBg: "#FEE2E2", iconColor: "#EF4444", title: "Unknown merchant", subtitle: "not on your allowlist · just now", amount: "$1,240.00", status: { text: "Declined", color: "#EF4444" }, rowBg: "#FEF2F2" },
            { key: "calendar", icon: <IconCalendar color="#475569" />, iconBg: "#E2E8F0", iconColor: "#475569", title: "Calendar subscription", subtitle: "Renews monthly · yesterday", amount: "$4.99", status: { text: "Approved", color: "#22C55E" } },
          ]}
          notifications={beatElapsedMs >= 700 ? [{ key: "wf-decline-1", top: 62, appIcon: <IconWaysafeMark size={23} />, appBg: "#FFFFFF", ringColor: "#EF4444", time: "now", title: WAYSAFE_NOTIF_DECLINE_1_TITLE, message: WAYSAFE_NOTIF_DECLINE_1_MSG }] : []}
        />
      </>
    );
  }

  // --- Frame 06: quote + decline-stablecoin -----------------------------------

  function renderQuoteDeclineStablecoin() {
    if (beatId === "quote") {
      return (
        <div style={{ position: "absolute", left: 140, top: 150, width: 900, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="film-kicker" style={{ color: "#94A3B8" }}>{QUOTE_KICKER}</div>
          <div style={{ fontFamily: "var(--font-bricolage), Georgia, serif", fontSize: 34, lineHeight: 1.3, fontWeight: 400, fontStyle: "italic", color: "#CBD5E1" }}>
            &ldquo;{AGENT_REASONING_QUOTE}&rdquo;
          </div>
          <div className="film-mono" style={{ fontSize: 15, color: "#94A3B8", letterSpacing: "0.04em" }}>{AGENT_REASONING_ATTRIBUTION}</div>
        </div>
      );
    }

    const showThreshold = beatElapsedMs >= DECLINE_STABLECOIN_CUT_MS;
    const revertLines = bypassError
      ? ["→ reverted · unavailable"]
      : formatSafeRevertLines(stablecoinRejection?.revertReason ?? null, stablecoinSafeAddress);
    return (
      <>
        {/* D-47: each sentence stays on its own line -- a wider container
            (1100px, up from 1020px) at the task's specified 100px, plus
            `whiteSpace: nowrap` (the explicit `<br>` between the two
            sentences still forces the line break; nowrap only stops either
            sentence's own text from wrapping a second time). */}
        <div className="film-display" style={{ position: "absolute", left: 136, top: 430, width: 1100, fontSize: 100, fontWeight: 600, color: "#F7F9FC", whiteSpace: "nowrap" }}>
          {STABLECOIN_HEADLINE_LINE_1}<br /><span style={{ color: "#22B8BE" }}>{STABLECOIN_HEADLINE_LINE_2}</span>
        </div>
        {showThreshold ? (
          <div style={{ position: "absolute", left: 140, top: 890, width: 1020, fontSize: 30, lineHeight: 1.35, color: "#94A3B8" }}>{STABLECOIN_THRESHOLD_CAPTION}</div>
        ) : null}
        {showThreshold ? (
          <Reveal active={revealedAt(0)}>
            <div style={{ position: "absolute", left: 1180, top: 270, width: 600, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 6px 10px 6px" }}>
                <div style={{ fontSize: 20, fontWeight: 600, color: "#F7F9FC" }}>{ATTACKER_NOTIFICATIONS[1]!.notifTitle}</div>
                <div className="film-mono" style={{ fontSize: 15, letterSpacing: "0.08em", color: "#94A3B8" }}>{SAFE_PANEL_LABEL}</div>
              </div>
              <SafeRow title={SAFE_ROW_SESSION_TITLE} sub={SAFE_ROW_SESSION_SUB} bg="#475569" icon={<IconCheck size={22} color="#FFFFFF" />} />
              <SafeRow title={SAFE_ROW_COSIGNER_TITLE} sub={SAFE_ROW_COSIGNER_SUB} bg="#EF4444" icon={<IconX size={22} color="#FFFFFF" />} />
              <div className="film-mono" style={{ marginTop: 10, padding: "22px 26px", borderRadius: 20, background: "#020817", border: "1px solid #1E293B", fontSize: 19, lineHeight: 1.6, color: "#CBD5E1" }}>
                {revertLines.map((line, i) => (
                  <div key={i} style={{ color: i === 0 ? "#FCA5A5" : "#94A3B8" }}>{line}</div>
                ))}
              </div>
            </div>
          </Reveal>
        ) : null}
      </>
    );
  }


  // --- Frame 07: decline-card-2 + allow + fleet-glimpse ------------------------

  function renderAllowFleetGlimpse() {
    const pastCard2 = beatId === "decline-card-2" || beatId === "allow" || beatId === "fleet-glimpse";
    const pastAllow = beatId === "allow" || beatId === "fleet-glimpse";
    const settled = Boolean(stablecoinAllow?.settlementTxHash);

    const rows: PhoneRow[] = [];
    if (pastAllow) {
      rows.push({
        key: "api-credits",
        icon: <IconBolt color="#22C55E" />,
        iconBg: "#DCFCE7",
        iconColor: "#22C55E",
        title: "API credits",
        subtitle: "500 credits · just now",
        amount: "10.00 USDC",
        status: { text: stablecoinAllow ? stablecoinAllow.decision : payError ? "UNAVAILABLE" : "EVALUATING", color: "#22C55E" },
        rowBg: "#F0FDF4",
      });
    }
    if (pastCard2) {
      rows.push({
        key: "unknown-recurring",
        icon: <IconX color="#EF4444" />,
        iconBg: "#FEE2E2",
        iconColor: "#EF4444",
        title: "Unknown recurring",
        subtitle: "not on your allowlist",
        amount: "$89.99",
        status: { text: cardAttempt2 ? cardAttempt2.decision === "DENY" ? "Declined" : cardAttempt2.decision : "…", color: "#EF4444" },
      });
    }
    rows.push({
      key: "unknown-merchant",
      icon: <IconX color="#EF4444" />,
      iconBg: "#FEE2E2",
      iconColor: "#EF4444",
      title: "Unknown merchant",
      subtitle: "not on your allowlist",
      amount: "$1,240.00",
      status: { text: "Declined", color: "#EF4444" },
    });

    return (
      <>
        <div className="film-kicker" style={{ position: "absolute", left: 140, top: 150, color: "#64748B" }}>{ALLOW_KICKER}</div>
        <div className="film-display" style={{ position: "absolute", left: 136, top: 280, width: 1000, fontSize: 150, fontWeight: 600, color: "#07111F" }}>
          {ALLOW_HEADLINE_LINE_1}<br />{ALLOW_HEADLINE_LINE_2}
        </div>
        {pastAllow ? (
          <Reveal active={revealedAt(0)}>
            <div className="film-mono" style={{ position: "absolute", left: 140, top: 640, display: "flex", flexDirection: "column", gap: 14, fontSize: 24, color: "#334155" }}>
              <div><span className="film-lb" style={{ color: "#64748B" }}>decision</span><span style={{ color: "#22C55E", fontWeight: 500 }}>{stablecoinAllow ? stablecoinAllow.decision : payError ? "UNAVAILABLE" : "EVALUATING"}</span></div>
              <div><span className="film-lb" style={{ color: "#64748B" }}>reason</span>{stablecoinAllow ? stablecoinAllow.reasonCodes.join(", ") : "…"}</div>
              <div><span className="film-lb" style={{ color: "#64748B" }}>spend</span>{ALLOW_SPEND_LINE}</div>
              <div><span className="film-lb" style={{ color: "#64748B" }}>signed</span>{ALLOW_SIGNED_LINE}</div>
            </div>
            <div style={{ position: "absolute", left: 140, top: 850, width: 980, fontSize: 32, lineHeight: 1.35, color: "#334155" }}>
              {beatId === "fleet-glimpse" ? FLEET_GLIMPSE_CAPTION : ALLOW_BODY}
            </div>
          </Reveal>
        ) : null}
        <Phone
          variant="light"
          cardBalance={formatUsd(balancesAtMs(0).cardCents)}
          walletBalance={formatUsdcAtomic(settled ? 2_490_000_000n : balancesAtMs(0).walletAtomic)}
          activityBadge={{ label: "Waysafe on", icon: <IconWaysafeMark size={14} />, bg: "#DDF3F3", color: "#008389" }}
          rows={rows}
          notifications={pastAllow ? [{ key: "wf-allow", top: 62, appIcon: <IconWaysafeMark size={23} />, appBg: "#FFFFFF", ringColor: "#22C55E", time: "now", title: WAYSAFE_NOTIF_ALLOW_TITLE, message: WAYSAFE_NOTIF_ALLOW_MSG }] : []}
        />
      </>
    );
  }

  // --- Frame 08: receipt + chain + verify --------------------------------------

  function renderReceiptChainVerify() {
    const showChain = beatId === "chain" || beatId === "verify";
    const showVerify = beatId === "verify";
    const authorizationId = cardAttempt1?.authorizationId ?? null;
    const evidenceEvent = evidence && authorizationId ? findEvidenceEventForAuthorization(evidence.events, authorizationId) : null;

    return (
      <>
        <div className="film-kicker" style={{ position: "absolute", left: 140, top: 150, color: "#64748B" }}>{EVIDENCE_KICKER}</div>
        <div className="film-display" style={{ position: "absolute", left: 136, top: 280, width: 900, fontSize: 118, fontWeight: 600, color: "#07111F" }}>
          {EVIDENCE_HEADLINE_LINE_1}<br />{EVIDENCE_HEADLINE_LINE_2}<br />{EVIDENCE_HEADLINE_LINE_3}
        </div>
        <div style={{ position: "absolute", left: 140, top: 700, width: 820, fontSize: 32, lineHeight: 1.35, color: "#334155" }}>{EVIDENCE_BODY}</div>

        <div style={{ position: "absolute", left: 1040, top: 130, width: 760, padding: "40px 44px 36px 44px", borderRadius: 28, background: "#FFFFFF", boxShadow: "0 50px 100px -30px rgba(2,6,23,0.35)", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 44, height: 44, borderRadius: 11, background: "#008389", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <IconShieldCheck />
              </div>
              <div style={{ fontSize: 22, fontWeight: 600, color: "#07111F" }}>{RECEIPT_TITLE}</div>
            </div>
            <div className="film-mono" style={{ padding: "8px 14px", borderRadius: 999, background: "#FEE2E2", color: "#EF4444", fontSize: 15, fontWeight: 500, letterSpacing: "0.08em" }}>
              {cardAttempt1?.decision ?? "…"}
            </div>
          </div>

          <ReceiptRow
            wrap
            label="attempt"
            value={cardAttempt1 ? `$1,240.00 · unknown_merchant_9911 · card •••• 4421` : cardError ? "unavailable" : "evaluating…"}
          />
          <ReceiptRow
            wrap
            label="reason"
            value={
              cardAttempt1 ? (
                <StackedLines lines={cardAttempt1.reasonCodes} color="#EF4444" />
              ) : (
                <span style={{ color: "#EF4444" }}>{cardError ? "unavailable" : "…"}</span>
              )
            }
          />
          <ReceiptRow label="mandate" value={cardMandateInfo ? `${truncateHash(cardMandateInfo.mandateVersionId, 6, 4)} · version 1 · passkey` : "…"} />
          <ReceiptRow label="policy hash" value={cardMandateInfo ? formatPolicyHash(cardMandateInfo.policyHash) : "…"} />

          {showChain ? (
            <Reveal active={revealedAt(0)}>
              <ReceiptRow label="chain" value={evidenceEvent ? `#${evidenceEvent.sequence} · prev ${evidenceEvent.previous_hash ? formatPolicyHash(evidenceEvent.previous_hash) : "(genesis)"}` : "loading the real chain…"} />
              <ReceiptRow label="signature" value={evidenceEvent ? `ed25519 · ${truncateHash(evidenceEvent.signature)}` : "…"} />
            </Reveal>
          ) : null}

          {showVerify && verifyResult ? (
            <Reveal active={revealedAt(0)} translateY={12}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 22, padding: "16px 20px", borderRadius: 16, background: verifyResult.ok ? "#F0FDF4" : "#FEF2F2", color: verifyResult.ok ? "#22C55E" : "#EF4444", fontSize: 18, fontWeight: 600 }}>
                <IconCheck color={verifyResult.ok ? "#22C55E" : "#EF4444"} />
                {verifyResult.ok ? VERIFIED_BAR_TEXT : `Not verified (${verifyResult.reason})`}
                <span className="film-mono" style={{ marginLeft: "auto", fontWeight: 400, fontSize: 14, color: "#64748B" }}>{VERIFIED_BAR_FN}</span>
              </div>
            </Reveal>
          ) : null}
        </div>
      </>
    );
  }


  // --- Frame 09: results (D-46; was "aftermath") -------------------------------

  function renderResults() {
    const showAnswers = beatElapsedMs >= resolved.beat.durationMs * 0.35;
    return (
      <>
        <div className="film-kicker" style={{ position: "absolute", left: 140, top: 150, color: "#64748B" }}>{RESULTS_KICKER}</div>
        <div className="film-display" style={{ position: "absolute", left: 136, top: 250, fontSize: 220, fontWeight: 600, color: "#07111F" }}>{WHO_PAYS_QUESTION}</div>
        {showAnswers ? (
          <Reveal active={revealedAt(0)}>
            <div style={{ position: "absolute", left: 140, top: 560, width: 780, display: "flex", flexDirection: "column", gap: 22 }}>
              <div className="film-kicker" style={{ color: "#EF4444" }}>{WHO_PAYS_LEFT_KICKER}</div>
              <div style={{ fontSize: 40, lineHeight: 1.28, color: "#07111F", fontWeight: 500 }}>{WHO_PAYS_LEFT_ANSWER}</div>
            </div>
            <div style={{ position: "absolute", left: 960, top: 560, width: 1, height: 230, background: "#CBD5E1" }} />
            <div style={{ position: "absolute", left: 1000, top: 560, width: 780, display: "flex", flexDirection: "column", gap: 22 }}>
              <div className="film-kicker" style={{ color: "#22C55E" }}>{WHO_PAYS_RIGHT_KICKER}</div>
              <div style={{ fontSize: 40, lineHeight: 1.28, color: "#07111F", fontWeight: 500 }}>{WHO_PAYS_RIGHT_ANSWER}</div>
            </div>
          </Reveal>
        ) : null}
      </>
    );
  }

  // --- Frame 10: endcard --------------------------------------------------------
  // D-46: switched to the light background so the real brand lockup reads
  // correctly (it's a dark-ink mark, designed for a light ground) --
  // diverging from the storyboard's own dark mockup of this frame on
  // purpose; see DECISIONS.md D-46.

  function renderEndcard() {
    // `design/brand/waysafe-logo.png` (the provided full lockup) isn't
    // present in this repo -- see D-46's own note on why this renders the
    // mark plus the wordmark text as a stand-in composition instead of the
    // real asset, sized to approximate the same ~880px width.
    return (
      <>
        <div className="film-display" style={{ position: "absolute", left: 0, right: 0, top: 120, textAlign: "center", fontSize: 84, fontWeight: 600, color: "#07111F", lineHeight: 1.08 }}>
          {END_CARD_LINE_1A}<br />{END_CARD_LINE_1B}
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 400, display: "flex", justifyContent: "center", alignItems: "center", gap: 30, width: 880, marginLeft: "auto", marginRight: "auto" }}>
          <IconWaysafeMark size={110} />
          <div className="film-display" style={{ fontSize: 96, fontWeight: 700, color: "#07111F", letterSpacing: "-0.04em" }}>{END_CARD_WORDMARK}</div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 620, textAlign: "center", fontSize: 32, lineHeight: 1.35, color: "#334155" }}>{END_CARD_TAGLINE}</div>
        <div className="film-mono" style={{ position: "absolute", left: 0, right: 0, top: 700, textAlign: "center", fontSize: 24, letterSpacing: "0.1em", color: "#008389" }}>
          {END_CARD_LINE_3.replace("/demo", "")}
          <a className="film-link" href="/demo" style={{ pointerEvents: "auto" }}>/demo</a>
        </div>
        <div className="film-mono" style={{ position: "absolute", left: 0, right: 0, bottom: 60, textAlign: "center", fontSize: 16, letterSpacing: "0.04em", color: "#64748B" }}>
          {END_CARD_FOOTNOTE}
        </div>
      </>
    );
  }

  // --- Reveal timing: quote's own beatElapsedMs while it's the active beat
  // (frameElapsedMs would otherwise include the whole frame's prior time),
  // frameElapsedMs everywhere else so multi-beat frames reveal continuously.

  function revealedAt(ms: number): boolean {
    return (beatId === "quote" ? beatElapsedMs : frameElapsedMs) >= ms;
  }
}

function Reveal({ active, translateY = 0, children }: { active: boolean; translateY?: number; children: React.ReactNode }) {
  return (
    <div style={{ opacity: active ? 1 : 0, transform: active ? "translateY(0)" : `translateY(${translateY}px)`, transition: "opacity 300ms ease-out, transform 300ms ease-out" }}>
      {children}
    </div>
  );
}

/** D-46: the mono decision block's "reason" and "signed" rows can each
 * carry more than one line now (real reason codes, one per line, never
 * truncated; the three real "signed" lines) -- this is the shared stacked-
 * lines layout both use, module-scope like every other component here that
 * doesn't close over `FilmClient`'s own clock state. */
/** D-47: the bare "one value per line" stack, factored out of
 * `LabeledLines` so frame 08's receipt reason row can reuse the exact same
 * rendering frame 05 already uses for reason codes, rather than a second,
 * independently-written stacking layout. */
function StackedLines({ lines, color }: { lines: readonly string[]; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {lines.map((line, i) => (
        <div key={i} style={{ color }}>{line}</div>
      ))}
    </div>
  );
}

function LabeledLines({ label, lines, valueColor }: { label: string; lines: readonly string[]; valueColor?: string }) {
  return (
    <div style={{ display: "flex" }}>
      <span className="film-lb" style={{ color: "#94A3B8", flexShrink: 0 }}>{label}</span>
      <StackedLines lines={lines} color={valueColor} />
    </div>
  );
}

function SafeRow({ title, sub, bg, icon }: { title: string; sub: string; bg: string; icon: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "22px 26px", borderRadius: 20, background: "#0E1A2E", border: "1px solid #1E293B" }}>
      <div style={{ width: 52, height: 52, borderRadius: 16, background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 26, fontWeight: 600, color: "#F7F9FC" }}>{title}</div>
        <div className="film-mono" style={{ fontSize: 17, color: "#94A3B8" }}>{sub}</div>
      </div>
    </div>
  );
}

/** D-47: `wrap` turns off the ellipsis-and-truncate default for a row whose
 * real value can be longer than the card is wide (the attempt line; the
 * reason row, whose value is `StackedLines` rather than a single string) --
 * `mandate`/`policy hash`/`chain`/`signature` stay truncated-by-`truncateHash`
 * as before, so they don't need it. */
function ReceiptRow({ label, value, wrap }: { label: string; value: React.ReactNode; wrap?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 24, alignItems: wrap ? "flex-start" : "baseline", padding: "14px 0", borderBottom: "1px solid #CBD5E1" }}>
      <div className="film-mono" style={{ width: 220, flexShrink: 0, fontSize: 15, letterSpacing: "0.08em", color: "#64748B", textTransform: "uppercase" }}>{label}</div>
      <div
        className="film-mono"
        style={
          wrap
            ? { flex: 1, minWidth: 0, fontSize: 20, color: "#07111F", whiteSpace: "normal", wordBreak: "break-word" }
            : { fontSize: 20, color: "#07111F", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
        }
      >
        {value}
      </div>
    </div>
  );
}

function frameBackground(frameId: FrameId): string {
  // D-46: the end card moved to the light background -- see its own render
  // function for why.
  const dark: FrameId[] = ["02-compromise", "03-drain-empty", "06-quote-decline-stablecoin"];
  return dark.includes(frameId) ? "#07111F" : "#F7F9FC";
}
