/**
 * D-43: the `/story` page's playback state machine. Pure and dependency-free
 * (no `requestAnimationFrame`, no React, no `Date.now()`) -- same pattern as
 * `lib/demo/scenes.ts` for the same reason: the page component should only
 * ever call `tick`/`togglePlay`/`restart` and render the result, never
 * re-derive "what state comes next" itself.
 */

export type PlaybackStatus = "paused" | "playing" | "ended";

export interface PlaybackState {
  status: PlaybackStatus;
  elapsedMs: number;
}

export function initialPlaybackState(autoplay: boolean): PlaybackState {
  return { status: autoplay ? "playing" : "paused", elapsedMs: 0 };
}

/** Advances the clock by `deltaMs` if playing; a no-op otherwise. Clamps to
 * `totalDurationMs` and transitions to `"ended"` exactly at the boundary,
 * never past it. */
export function tick(state: PlaybackState, deltaMs: number, totalDurationMs: number): PlaybackState {
  if (state.status !== "playing") return state;
  if (deltaMs <= 0) return state;
  const elapsedMs = state.elapsedMs + deltaMs;
  if (elapsedMs >= totalDurationMs) return { status: "ended", elapsedMs: totalDurationMs };
  return { status: "playing", elapsedMs };
}

/** Space bar: pause<->play. From `"ended"`, resumes as a fresh run (matches
 * "space = play/pause" reading naturally as "play" once a run is over). */
export function togglePlay(state: PlaybackState): PlaybackState {
  if (state.status === "playing") return { status: "paused", elapsedMs: state.elapsedMs };
  if (state.status === "ended") return { status: "playing", elapsedMs: 0 };
  return { status: "playing", elapsedMs: state.elapsedMs };
}

/** "R": always resets to T+0 and resumes playing, regardless of prior state --
 * the task's own "?seed= makes the run deterministic so takes are
 * repeatable" implies restarting is meant to immediately replay, not just
 * rewind-and-pause. */
export function restart(): PlaybackState {
  return { status: "playing", elapsedMs: 0 };
}

export function isPlaying(state: PlaybackState): boolean {
  return state.status === "playing";
}

export function isEnded(state: PlaybackState): boolean {
  return state.status === "ended";
}
