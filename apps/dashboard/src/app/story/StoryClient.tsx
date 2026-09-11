"use client";

/**
 * D-43: the `/story` canvas. Everything that changes every frame (agent
 * colors, in-flight particles, counters, the T+ clock) is drawn imperatively
 * on the canvas inside one `requestAnimationFrame` loop -- there is no React
 * re-render in that loop, only refs, which is what keeps 200 agents and a
 * few thousand precomputed attempts smooth. React state is used only for
 * the rare, discrete transitions an HTML overlay needs (loading done,
 * paused/playing, the end card) -- see `uiPhase` below.
 *
 * The simulation itself (`buildStory`) already ran `evaluate()` for real,
 * once, synchronously, in this browser, before the first frame is drawn --
 * see lib/story/simulation.ts's own doc comment. This file only replays
 * what it returned; it never computes a Decision.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Decision } from "@waysafe/core/browser";
import { RAILS, INCIDENT_FOOTNOTE, type Rail } from "@/lib/story/attack-data";
import { initialPlaybackState, restart, tick, togglePlay, type PlaybackState } from "@/lib/story/playback";
import { computeReceiptHashes } from "@/lib/story/receipt-hash";
import { buildStory, type DecisionEvent, type StoryData } from "@/lib/story/simulation";

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const END_CARD_MS = 4000;

const LEFT_X0 = 40;
const LEFT_X1 = 940;
const RIGHT_X0 = 980;
const RIGHT_X1 = 1880;
const FIELD_Y0 = 230;
const FIELD_Y1 = 760;
const LANE_COL_W = 240;
const LANE_GAP = 20;
const RECEIPT_Y0 = 800;
const RECEIPT_Y1 = 1010;

const RAIL_LABELS: Record<Rail, string> = { card: "CARD", x402: "X402", wallet: "WALLET", bank: "BANK" };

const COLOR_BG = "#030405";
const COLOR_AGENT_SAFE = "#3b4a5f";
const COLOR_AGENT_COMPROMISED = "#f87171";
const COLOR_LEFT_ACCENT = "#f87171";
const COLOR_RIGHT_ACCENT = "#5eead4";
const COLOR_DENY = "#fca5a5";
const COLOR_ALLOW = "#6ee7b7";
const COLOR_DIM = "#5c6675";
const COLOR_TEXT = "#e6edf3";

interface Flight {
  agentId: number;
  x: number;
  y: number;
  laneIndex: number;
  startMs: number;
  decision?: Decision;
  label: string;
}

interface HalfGeometry {
  x0: number;
  x1: number;
  fieldX1: number;
  laneX0: number;
}

function halfGeometry(side: "left" | "right"): HalfGeometry {
  if (side === "left") {
    return { x0: LEFT_X0, x1: LEFT_X1, fieldX1: LEFT_X1 - LANE_COL_W - LANE_GAP, laneX0: LEFT_X1 - LANE_COL_W };
  }
  return { x0: RIGHT_X0, x1: RIGHT_X1, fieldX1: RIGHT_X1 - LANE_COL_W - LANE_GAP, laneX0: RIGHT_X1 - LANE_COL_W };
}

function laneY(index: number): number {
  const laneH = (FIELD_Y1 - FIELD_Y0) / RAILS.length;
  return FIELD_Y0 + laneH * (index + 0.5);
}

function agentPos(geom: HalfGeometry, nx: number, ny: number): { x: number; y: number } {
  return { x: geom.x0 + 10 + nx * (geom.fieldX1 - geom.x0 - 20), y: FIELD_Y0 + ny * (FIELD_Y1 - FIELD_Y0) };
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return `T+${mm}:${ss}`;
}

function formatUsd(minor: number): string {
  const dollars = minor / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

type UiPhase = "loading" | "paused" | "playing" | "endcard" | "ended";

export function StoryClient({ seed, autoplay }: { seed: number; autoplay: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const storyRef = useRef<StoryData | null>(null);
  const hashesRef = useRef<Map<number, string> | null>(null);
  const playbackRef = useRef<PlaybackState>(initialPlaybackState(false));
  const lastTsRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);
  const cursorRef = useRef(0);
  const leftTotalsRef = useRef({ amount: 0, count: 0, merchants: new Set<string>(), rails: new Set<string>() });
  const rightTotalsRef = useRef({ amount: 0, count: 0, merchants: new Set<string>(), rails: new Set<string>() });
  const leftFlightsRef = useRef<Flight[]>([]);
  const rightFlightsRef = useRef<Flight[]>([]);
  const receiptLinesRef = useRef<{ text: string; decision: Decision }[]>([]);
  const compromisedAtRef = useRef<Map<number, number>>(new Map());
  const uiPhaseRef = useRef<UiPhase>("loading");

  const [uiPhase, setUiPhase] = useState<UiPhase>("loading");

  const seedLabel = useMemo(() => seed, [seed]);

  useEffect(() => {
    let cancelled = false;
    const story = buildStory(seed);
    storyRef.current = story;
    compromisedAtRef.current = new Map(story.compromise.map((c) => [c.agentId, c.atMs]));
    computeReceiptHashes(story.decisions).then((hashes) => {
      if (cancelled) return;
      hashesRef.current = hashes;
      playbackRef.current = initialPlaybackState(autoplay);
      const next = autoplay ? "playing" : "paused";
      uiPhaseRef.current = next;
      setUiPhase(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

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

  useEffect(() => {
    function resetRuntimeState() {
      cursorRef.current = 0;
      leftTotalsRef.current = { amount: 0, count: 0, merchants: new Set(), rails: new Set() };
      rightTotalsRef.current = { amount: 0, count: 0, merchants: new Set(), rails: new Set() };
      leftFlightsRef.current = [];
      rightFlightsRef.current = [];
      receiptLinesRef.current = [];
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.code === "Space") {
        e.preventDefault();
        if (uiPhaseRef.current === "loading") return;
        playbackRef.current = togglePlay(playbackRef.current);
        lastTsRef.current = null;
      } else if (e.key === "r" || e.key === "R") {
        if (uiPhaseRef.current === "loading") return;
        resetRuntimeState();
        playbackRef.current = restart();
        lastTsRef.current = null;
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  useEffect(() => {
    if (uiPhase === "loading") return;

    function frame(ts: number) {
      const story = storyRef.current;
      const canvas = canvasRef.current;
      if (!story || !canvas) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const last = lastTsRef.current ?? ts;
      // Only guards against a genuinely degenerate gap (a suspended tab
      // coming back after minutes) -- NOT a per-frame throttle. Capping
      // this low would silently slow playback to a crawl in any tab the
      // browser deprioritizes rAF for (backgrounded, unfocused), which is
      // exactly the situation a recording tool might put this page in.
      const delta = Math.min(2000, ts - last);
      lastTsRef.current = ts;

      const totalMs = story.config.activeDurationMs + END_CARD_MS;
      playbackRef.current = tick(playbackRef.current, delta, totalMs);
      const elapsed = playbackRef.current.elapsedMs;

      advanceCursor(story, elapsed);
      draw(ctx, story, elapsed);

      const nextPhase: UiPhase =
        playbackRef.current.status === "ended"
          ? "ended"
          : elapsed >= story.config.activeDurationMs
            ? "endcard"
            : playbackRef.current.status === "playing"
              ? "playing"
              : "paused";
      if (nextPhase !== uiPhaseRef.current) {
        uiPhaseRef.current = nextPhase;
        setUiPhase(nextPhase);
      }

      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [uiPhase === "loading"]);

  function advanceCursor(story: StoryData, elapsed: number) {
    const cappedElapsed = Math.min(elapsed, story.config.activeDurationMs);
    while (cursorRef.current < story.decisions.length && story.attempts[cursorRef.current]!.atMs <= cappedElapsed) {
      const event = story.decisions[cursorRef.current]!;
      onAttemptRevealed(story, event);
      cursorRef.current += 1;
    }
  }

  function onAttemptRevealed(story: StoryData, event: DecisionEvent) {
    const { attempt, decision } = event;
    const agent = story.agents[attempt.agentId]!;
    const laneIndex = RAILS.indexOf(attempt.rail);
    const merchantKey = `${attempt.merchant.domain ?? attempt.merchant.onchain_address ?? attempt.merchant.psp_account ?? attempt.merchant.network_mid ?? attempt.merchant.name ?? "unknown"}`;

    // LEFT: every attempt "succeeds" -- no evaluate() involved, by design;
    // this is the counterfactual, not a second decision path.
    leftTotalsRef.current.amount += attempt.amountMinor;
    leftTotalsRef.current.count += 1;
    leftTotalsRef.current.merchants.add(merchantKey);
    leftTotalsRef.current.rails.add(attempt.rail);
    leftFlightsRef.current.push({
      agentId: attempt.agentId,
      x: agent.x,
      y: agent.y,
      laneIndex,
      startMs: attempt.atMs,
      label: formatUsd(attempt.amountMinor),
    });

    // RIGHT: the real decision.
    rightFlightsRef.current.push({
      agentId: attempt.agentId,
      x: agent.x,
      y: agent.y,
      laneIndex,
      startMs: attempt.atMs,
      decision: decision,
      label: event.reasons[0]?.code ?? decision,
    });
    if (decision === "ALLOW") {
      rightTotalsRef.current.amount += attempt.amountMinor;
      rightTotalsRef.current.count += 1;
      rightTotalsRef.current.merchants.add(merchantKey);
      rightTotalsRef.current.rails.add(attempt.rail);
    }
    const hash = hashesRef.current?.get(attempt.id) ?? "";
    const codes = event.reasons.map((r) => r.code).join("+");
    receiptLinesRef.current.unshift({
      text: `agent#${attempt.agentId.toString().padStart(3, "0")} · ${RAIL_LABELS[attempt.rail]} · ${decision} · ${codes || "-"} · ${hash.slice(0, 12)}`,
      decision,
    });
    if (receiptLinesRef.current.length > 16) receiptLinesRef.current.length = 16;
  }

  function draw(ctx: CanvasRenderingContext2D, story: StoryData, elapsed: number) {
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const inEndCard = elapsed >= story.config.activeDurationMs;

    drawTopBar(ctx, elapsed, story.config.activeDurationMs);

    drawHalf(ctx, "left", story, elapsed);
    drawHalf(ctx, "right", story, elapsed);

    ctx.strokeStyle = "#1a2230";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(960, 60);
    ctx.lineTo(960, RECEIPT_Y1);
    ctx.stroke();

    if (inEndCard) {
      const endElapsed = elapsed - story.config.activeDurationMs;
      const alpha = Math.min(1, endElapsed / 500);
      ctx.fillStyle = `rgba(3,4,5,${alpha})`;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }
  }

  function drawTopBar(ctx: CanvasRenderingContext2D, elapsed: number, activeDurationMs: number) {
    const cappedElapsed = Math.min(elapsed, activeDurationMs);
    ctx.textAlign = "center";
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = "700 34px ui-monospace, monospace";
    ctx.fillText(formatClock(cappedElapsed), 960, 46);

    ctx.font = "600 15px ui-monospace, monospace";
    ctx.fillStyle = COLOR_DIM;
    ctx.fillText(currentCaption(cappedElapsed), 960, 70);

    ctx.textAlign = "left";
    ctx.font = "700 22px ui-monospace, monospace";
    ctx.fillStyle = COLOR_LEFT_ACCENT;
    ctx.fillText("WITHOUT AN AUTHORIZATION LAYER", LEFT_X0, 108);

    ctx.fillStyle = COLOR_RIGHT_ACCENT;
    ctx.fillText("WITH WAYSAFE", RIGHT_X0, 108);
  }

  function drawHalf(ctx: CanvasRenderingContext2D, side: "left" | "right", story: StoryData, elapsed: number) {
    const geom = halfGeometry(side);
    const cappedElapsed = Math.min(elapsed, story.config.activeDurationMs);
    const totals = side === "left" ? leftTotalsRef.current : rightTotalsRef.current;
    const accent = side === "left" ? COLOR_LEFT_ACCENT : COLOR_RIGHT_ACCENT;

    // Counters
    ctx.textAlign = "left";
    ctx.fillStyle = accent;
    ctx.font = "800 56px ui-monospace, monospace";
    ctx.fillText(formatUsd(totals.amount), geom.x0, 175);
    if (side === "left") {
      ctx.font = "600 13px ui-monospace, monospace";
      ctx.fillStyle = COLOR_DIM;
      ctx.fillText("(simulated -- no bound on this side)", geom.x0, 195);
    }

    ctx.font = "600 14px ui-monospace, monospace";
    ctx.fillStyle = COLOR_DIM;
    const stat = `${totals.count.toLocaleString("en-US")} attempts · ${totals.merchants.size} merchants · ${totals.rails.size}/4 rails`;
    ctx.fillText(stat, geom.x0 + 320, 165);

    // Agent field border
    ctx.strokeStyle = "#141b26";
    ctx.lineWidth = 1;
    ctx.strokeRect(geom.x0, FIELD_Y0, geom.fieldX1 - geom.x0, FIELD_Y1 - FIELD_Y0);

    // Agents
    const compromisedAt = compromisedAtRef.current;
    for (const agent of story.agents) {
      const pos = agentPos(geom, agent.x, agent.y);
      const compAt = compromisedAt.get(agent.id);
      const isCompromised = compAt !== undefined && cappedElapsed >= compAt;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, isCompromised ? 3.4 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = isCompromised ? COLOR_AGENT_COMPROMISED : COLOR_AGENT_SAFE;
      ctx.fill();
    }

    // Patient zero halo + caption
    const patientZero = story.compromise[0];
    if (patientZero && cappedElapsed < 3200) {
      const pos = agentPos(geom, story.agents[patientZero.agentId]!.x, story.agents[patientZero.agentId]!.y);
      const t = Math.min(1, cappedElapsed / 3200);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 6 + t * 34, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(248,113,113,${1 - t})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (side === "right") {
        ctx.font = "600 13px ui-monospace, monospace";
        ctx.fillStyle = `rgba(252,165,165,${1 - t})`;
        ctx.textAlign = "left";
        ctx.fillText("/proc/self/environ dumped", pos.x + 14, pos.y - 14);
      }
    }

    // Barrier for the right side
    if (side === "right") {
      ctx.strokeStyle = "rgba(94,234,212,0.35)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(geom.fieldX1 + 6, FIELD_Y0 - 10);
      ctx.lineTo(geom.fieldX1 + 6, FIELD_Y1 + 10);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.translate(geom.fieldX1 + 22, (FIELD_Y0 + FIELD_Y1) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.font = "700 12px ui-monospace, monospace";
      ctx.fillStyle = "rgba(94,234,212,0.7)";
      ctx.fillText("AUTHORIZATION LAYER", 0, 0);
      ctx.restore();
    }

    // Lanes
    RAILS.forEach((rail, i) => {
      const y = laneY(i);
      ctx.strokeStyle = "#141b26";
      ctx.beginPath();
      ctx.moveTo(geom.laneX0, y);
      ctx.lineTo(geom.x1, y);
      ctx.stroke();
      ctx.font = "600 12px ui-monospace, monospace";
      ctx.fillStyle = COLOR_DIM;
      ctx.textAlign = "left";
      ctx.fillText(RAIL_LABELS[rail], geom.laneX0 + 6, y - 6);
    });

    // Flights
    const flights = side === "left" ? leftFlightsRef.current : rightFlightsRef.current;
    drawFlights(ctx, flights, geom, cappedElapsed, side);

    // Receipt stream (right only)
    if (side === "right") {
      drawReceiptStream(ctx, geom);
    } else {
      ctx.font = "italic 13px ui-monospace, monospace";
      ctx.fillStyle = COLOR_DIM;
      ctx.textAlign = "left";
      ctx.fillText("no authorization layer -- nothing here to log against.", geom.x0, RECEIPT_Y0 + 20);
    }
  }

  function drawFlights(
    ctx: CanvasRenderingContext2D,
    flights: Flight[],
    geom: HalfGeometry,
    elapsed: number,
    side: "left" | "right",
  ) {
    const travelMs = 650;
    const tailMs = side === "right" ? 900 : 260;
    const lifespan = travelMs + tailMs;

    for (let i = flights.length - 1; i >= 0; i -= 1) {
      const f = flights[i]!;
      const age = elapsed - f.startMs;
      if (age > lifespan || age < 0) {
        if (age > lifespan) flights.splice(i, 1);
        continue;
      }
      const target = laneY(f.laneIndex);
      const startPos = agentPos(geom, f.x, f.y);
      const denyBarrierFrac = 0.82;
      const arriveFrac = side === "right" && f.decision !== "ALLOW" ? denyBarrierFrac : 1;
      const travelT = Math.min(1, age / travelMs) * arriveFrac;
      const px = startPos.x + (geom.laneX0 - startPos.x) * travelT;
      const py = startPos.y + (target - startPos.y) * travelT;

      ctx.strokeStyle = side === "left" ? "rgba(248,113,113,0.25)" : "rgba(94,234,212,0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(startPos.x, startPos.y);
      ctx.lineTo(px, py);
      ctx.stroke();

      const arrived = age >= travelMs * arriveFrac;
      const flashT = arrived ? Math.min(1, (age - travelMs * arriveFrac) / tailMs) : 0;

      if (side === "left") {
        ctx.beginPath();
        ctx.arc(px, py, arrived ? 5 + flashT * 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = arrived ? `rgba(248,113,113,${1 - flashT})` : COLOR_LEFT_ACCENT;
        ctx.fill();
      } else {
        const color = f.decision === "ALLOW" ? COLOR_ALLOW : COLOR_DENY;
        ctx.beginPath();
        ctx.arc(px, py, arrived ? 6 + flashT * 8 : 3, 0, Math.PI * 2);
        ctx.fillStyle = arrived ? `rgba(${f.decision === "ALLOW" ? "110,231,183" : "252,165,165"},${1 - flashT})` : color;
        ctx.fill();
        if (arrived && flashT < 0.8) {
          ctx.font = "600 11px ui-monospace, monospace";
          ctx.fillStyle = `rgba(${f.decision === "ALLOW" ? "110,231,183" : "252,165,165"},${1 - flashT})`;
          ctx.textAlign = "left";
          ctx.fillText(f.label, px + 10, py - 10 - flashT * 18);
        }
      }
    }
  }

  function drawReceiptStream(ctx: CanvasRenderingContext2D, geom: HalfGeometry) {
    ctx.strokeStyle = "#141b26";
    ctx.strokeRect(geom.x0, RECEIPT_Y0, geom.x1 - geom.x0, RECEIPT_Y1 - RECEIPT_Y0);
    ctx.font = "700 11px ui-monospace, monospace";
    ctx.fillStyle = COLOR_DIM;
    ctx.textAlign = "left";
    ctx.fillText("RECEIPT STREAM", geom.x0 + 10, RECEIPT_Y0 + 18);

    const lines = receiptLinesRef.current;
    ctx.font = "12px ui-monospace, monospace";
    lines.forEach((line, i) => {
      const y = RECEIPT_Y0 + 38 + i * 12.5;
      if (y > RECEIPT_Y1 - 6) return;
      ctx.fillStyle = line.decision === "DENY" ? "rgba(252,165,165,0.85)" : "rgba(110,231,183,0.85)";
      ctx.fillText(line.text, geom.x0 + 10, y);
    });
  }

  return (
    <div className="story-viewport">
      <div className="story-stage" ref={stageRef}>
        <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} />

        <div className="story-simlabel story-overlay">SIMULATION -- DECISIONS ARE REAL</div>
        <div className="story-footnote story-overlay">{INCIDENT_FOOTNOTE}</div>
        <div className="story-keys story-overlay">
          space: play/pause &nbsp;·&nbsp; r: restart &nbsp;·&nbsp; seed {seedLabel}
        </div>
        <a className="story-back story-overlay" href="/demo">
          proof: /demo ↗
        </a>

        {uiPhase === "loading" ? (
          <div className="story-center-hint">
            <div className="story-center-hint-title">loading the simulation…</div>
          </div>
        ) : null}

        {uiPhase === "paused" ? (
          <div className="story-center-hint">
            <div className="story-center-hint-title">▶ press space to play</div>
            <div className="story-center-hint-sub">r restarts · ?autoplay=1 starts immediately</div>
          </div>
        ) : null}

        {uiPhase === "endcard" || uiPhase === "ended" ? (
          <div className="story-end-card">
            <div className="story-end-line-1">Same agents. Same attack.<br />The control isn&apos;t in the agent.</div>
            <div className="story-end-line-2">
              Waysafe · waysafe.ai · proof: <a className="story-link" href="/demo">/demo</a>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function currentCaption(elapsedMs: number): string {
  const timeline: { atMs: number; text: string }[] = [
    { atMs: 0, text: "/proc/self/environ dumped -- one agent, compromised" },
    { atMs: 2500, text: "lateral spread: credential reuse across the fleet" },
    { atMs: 9000, text: "compromise spreading agent by agent" },
    { atMs: 18000, text: "fleet-wide compromise -- every agent now firing" },
    { atMs: 30000, text: "four rails, one authorization layer" },
    { atMs: 40000, text: "the mandate's ceiling holds" },
  ];
  let current = timeline[0]!.text;
  for (const entry of timeline) {
    if (elapsedMs >= entry.atMs) current = entry.text;
  }
  return current;
}
