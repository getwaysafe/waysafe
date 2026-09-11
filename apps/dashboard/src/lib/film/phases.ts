/**
 * D-44: `/film`'s beat state machine. Pure and dependency-free -- same
 * pattern as `lib/story/phases.ts` and `lib/demo/scenes.ts` -- so
 * `FilmClient.tsx` only ever calls `resolveBeat(elapsedMs)` and renders the
 * result, never re-derives "what beat is this elapsed time in" itself.
 *
 * Sixteen beats across three acts, summing to exactly 60,000ms:
 *
 *   Act 1 "Without" (20s):        intro, compromise, drain, empty
 *   Act 2 "With Waysafe" (20s):   replay-intro, decline-card-1, quote,
 *                                 decline-stablecoin, decline-card-2, allow,
 *                                 fleet-glimpse
 *   Act 3 "The evidence" (20s):   receipt, chain, verify, aftermath, endcard
 *
 * The task's own text estimates Act 3 at "~15s"; it runs closer to 20s here
 * once every listed beat (a real receipt, the real chain, verify-then-flip,
 * the aftermath beat, the end card) gets enough time to actually read on
 * screen -- recorded as a judgment call in DECISIONS.md D-44, not a
 * deviation to hide. The three acts land on an even 20s each and the whole
 * film on the task's target of 60s.
 *
 * `decline-stablecoin` (D-44 addendum) is itself two captioned sub-moments,
 * not two beats -- `FilmClient.tsx` splits its own 4000ms internally (the
 * cut to the Safe's revert, then the 3-second hold), since both moments are
 * one continuous shot, not a scene change. `quote` (the real Hugging Face
 * agent message, D-32) plays immediately before it.
 */

export type BeatId =
  | "intro"
  | "compromise"
  | "drain"
  | "empty"
  | "replay-intro"
  | "decline-card-1"
  | "quote"
  | "decline-stablecoin"
  | "decline-card-2"
  | "allow"
  | "fleet-glimpse"
  | "receipt"
  | "chain"
  | "verify"
  | "aftermath"
  | "endcard";

export interface Beat {
  id: BeatId;
  act: 1 | 2 | 3;
  durationMs: number;
}

/** Within `decline-stablecoin` (D-44 addendum): the ms at which the cut to
 * the Safe's on-chain revert happens, and the caption changes from "You can
 * reason past a rule..." to holding on "The agent's key alone can't
 * sign...". */
export const DECLINE_STABLECOIN_CUT_MS = 1_000;

export const BEATS: readonly Beat[] = [
  { id: "intro", act: 1, durationMs: 4_000 },
  { id: "compromise", act: 1, durationMs: 2_000 },
  { id: "drain", act: 1, durationMs: 13_000 },
  { id: "empty", act: 1, durationMs: 1_000 },
  { id: "replay-intro", act: 2, durationMs: 1_500 },
  { id: "decline-card-1", act: 2, durationMs: 1_500 },
  { id: "quote", act: 2, durationMs: 3_000 },
  { id: "decline-stablecoin", act: 2, durationMs: 4_000 },
  { id: "decline-card-2", act: 2, durationMs: 1_500 },
  { id: "allow", act: 2, durationMs: 4_000 },
  { id: "fleet-glimpse", act: 2, durationMs: 4_500 },
  { id: "receipt", act: 3, durationMs: 3_000 },
  { id: "chain", act: 3, durationMs: 3_000 },
  { id: "verify", act: 3, durationMs: 4_000 },
  { id: "aftermath", act: 3, durationMs: 4_000 },
  { id: "endcard", act: 3, durationMs: 6_000 },
] as const;

export function totalDurationMs(): number {
  return BEATS.reduce((sum, b) => sum + b.durationMs, 0);
}

/** The elapsed-ms instant each beat starts at, in order. */
export function beatStartMs(id: BeatId): number {
  let start = 0;
  for (const beat of BEATS) {
    if (beat.id === id) return start;
    start += beat.durationMs;
  }
  throw new Error(`unknown beat id: ${id}`);
}

export interface ResolvedBeat {
  beat: Beat;
  /** ms elapsed since this beat itself started, always in [0, beat.durationMs). */
  beatElapsedMs: number;
  /** True only on the final beat, once its own duration has fully elapsed. */
  isFilmOver: boolean;
}

/** Clamps to the last beat, held indefinitely, once elapsed reaches the
 * total -- the same "sticky end" `lib/story/phases.ts` uses. */
export function resolveBeat(elapsedMs: number): ResolvedBeat {
  let start = 0;
  for (let i = 0; i < BEATS.length; i += 1) {
    const beat = BEATS[i]!;
    const end = start + beat.durationMs;
    if (elapsedMs < end || i === BEATS.length - 1) {
      return {
        beat,
        beatElapsedMs: Math.min(elapsedMs - start, beat.durationMs),
        isFilmOver: i === BEATS.length - 1 && elapsedMs >= end,
      };
    }
    start = end;
  }
  // Unreachable: BEATS is non-empty and the loop's last iteration always
  // returns via the `i === BEATS.length - 1` branch above.
  throw new Error("resolveBeat: no beats configured");
}
