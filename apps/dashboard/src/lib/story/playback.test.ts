import { describe, expect, it } from "vitest";
import { initialPlaybackState, isEnded, isPlaying, restart, tick, togglePlay } from "./playback";

const TOTAL = 10_000;

describe("/story playback state machine (D-43)", () => {
  it("starts paused by default, or playing with ?autoplay=1", () => {
    expect(initialPlaybackState(false)).toEqual({ status: "paused", elapsedMs: 0 });
    expect(initialPlaybackState(true)).toEqual({ status: "playing", elapsedMs: 0 });
  });

  it("tick advances elapsed time only while playing", () => {
    const playing = tick(initialPlaybackState(true), 500, TOTAL);
    expect(playing).toEqual({ status: "playing", elapsedMs: 500 });

    const paused = tick(initialPlaybackState(false), 500, TOTAL);
    expect(paused).toEqual({ status: "paused", elapsedMs: 0 });
  });

  it("tick is a no-op for a non-positive delta", () => {
    const state = { status: "playing" as const, elapsedMs: 100 };
    expect(tick(state, 0, TOTAL)).toEqual(state);
    expect(tick(state, -50, TOTAL)).toEqual(state);
  });

  it("clamps to totalDurationMs and transitions to ended exactly at the boundary", () => {
    let state = initialPlaybackState(true);
    state = tick(state, TOTAL - 1, TOTAL);
    expect(state).toEqual({ status: "playing", elapsedMs: TOTAL - 1 });
    state = tick(state, 1, TOTAL);
    expect(state).toEqual({ status: "ended", elapsedMs: TOTAL });
  });

  it("never overshoots totalDurationMs even with a huge delta", () => {
    const state = tick(initialPlaybackState(true), TOTAL * 10, TOTAL);
    expect(state).toEqual({ status: "ended", elapsedMs: TOTAL });
  });

  it("ticking an ended state is a no-op", () => {
    const ended = { status: "ended" as const, elapsedMs: TOTAL };
    expect(tick(ended, 500, TOTAL)).toEqual(ended);
  });

  it("togglePlay flips paused<->playing without touching elapsed time", () => {
    const paused = { status: "paused" as const, elapsedMs: 3_000 };
    const playing = togglePlay(paused);
    expect(playing).toEqual({ status: "playing", elapsedMs: 3_000 });
    expect(togglePlay(playing)).toEqual({ status: "paused", elapsedMs: 3_000 });
  });

  it("togglePlay on an ended run starts a fresh one at T+0", () => {
    const ended = { status: "ended" as const, elapsedMs: TOTAL };
    expect(togglePlay(ended)).toEqual({ status: "playing", elapsedMs: 0 });
  });

  it("restart always resets to T+0 and resumes playing, regardless of prior state", () => {
    expect(restart()).toEqual({ status: "playing", elapsedMs: 0 });
  });

  it("isPlaying / isEnded reflect status", () => {
    expect(isPlaying({ status: "playing", elapsedMs: 0 })).toBe(true);
    expect(isPlaying({ status: "paused", elapsedMs: 0 })).toBe(false);
    expect(isEnded({ status: "ended", elapsedMs: TOTAL })).toBe(true);
    expect(isEnded({ status: "playing", elapsedMs: 0 })).toBe(false);
  });
});
