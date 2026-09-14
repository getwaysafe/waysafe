import { describe, expect, it } from "vitest";
import { BEATS, DECLINE_STABLECOIN_CUT_MS, beatStartMs, resolveBeat, totalDurationMs } from "./phases";

describe("/film beat state machine (D-44, retimed by D-46)", () => {
  it("sums to exactly 70 seconds, D-46's retimed target", () => {
    expect(totalDurationMs()).toBe(70_000);
  });

  it("each act lands on its own D-46 total (19s / 29s / 22s)", () => {
    const byAct = (act: 1 | 2 | 3) => BEATS.filter((b) => b.act === act);
    const expected = { 1: 19_000, 2: 29_000, 3: 22_000 } as const;
    for (const act of [1, 2, 3] as const) {
      const sum = byAct(act).reduce((s, b) => s + b.durationMs, 0);
      expect(sum).toBe(expected[act]);
    }
  });

  it("the decline-stablecoin beat is long enough to hold the addendum's two captions in sequence", () => {
    const beat = BEATS.find((b) => b.id === "decline-stablecoin")!;
    // Cut to the revert, then a 3-second hold -- the addendum's own figure.
    expect(beat.durationMs - DECLINE_STABLECOIN_CUT_MS).toBeGreaterThanOrEqual(3_000);
    expect(DECLINE_STABLECOIN_CUT_MS).toBeGreaterThan(0);
    expect(DECLINE_STABLECOIN_CUT_MS).toBeLessThan(beat.durationMs);
  });

  it("the quote beat plays immediately before decline-stablecoin", () => {
    const quoteStart = beatStartMs("quote");
    const quoteBeat = BEATS.find((b) => b.id === "quote")!;
    expect(beatStartMs("decline-stablecoin")).toBe(quoteStart + quoteBeat.durationMs);
  });

  it("beatStartMs is the running sum of every prior beat's duration", () => {
    let expected = 0;
    for (const beat of BEATS) {
      expect(beatStartMs(beat.id)).toBe(expected);
      expected += beat.durationMs;
    }
  });

  it("resolveBeat starts on 'intro' at T+0", () => {
    const r = resolveBeat(0);
    expect(r.beat.id).toBe("intro");
    expect(r.beatElapsedMs).toBe(0);
    expect(r.isFilmOver).toBe(false);
  });

  it("resolveBeat walks every beat in order across the whole timeline, at each boundary", () => {
    let start = 0;
    for (const beat of BEATS) {
      const justInside = resolveBeat(start);
      expect(justInside.beat.id).toBe(beat.id);
      expect(justInside.beatElapsedMs).toBe(0);

      const justBeforeEnd = resolveBeat(start + beat.durationMs - 1);
      expect(justBeforeEnd.beat.id).toBe(beat.id);
      expect(justBeforeEnd.beatElapsedMs).toBe(beat.durationMs - 1);

      start += beat.durationMs;
    }
  });

  it("is film-over only once the final beat's own duration has fully elapsed", () => {
    const total = totalDurationMs();
    const lastBeat = BEATS[BEATS.length - 1]!;
    expect(lastBeat.id).toBe("endcard");

    const justBefore = resolveBeat(total - 1);
    expect(justBefore.beat.id).toBe("endcard");
    expect(justBefore.isFilmOver).toBe(false);

    const atTotal = resolveBeat(total);
    expect(atTotal.beat.id).toBe("endcard");
    expect(atTotal.isFilmOver).toBe(true);
  });

  it("stays on the end card (sticky) for any elapsed time past the total", () => {
    const r = resolveBeat(totalDurationMs() + 999_999);
    expect(r.beat.id).toBe("endcard");
    expect(r.isFilmOver).toBe(true);
    expect(r.beatElapsedMs).toBe(BEATS[BEATS.length - 1]!.durationMs);
  });

  it("never returns a negative beatElapsedMs even for elapsed times before T+0", () => {
    const r = resolveBeat(-500);
    expect(r.beat.id).toBe("intro");
    expect(r.beatElapsedMs).toBeLessThanOrEqual(0);
  });
});
