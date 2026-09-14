/**
 * D-44: `/film`'s beat state machine. Pure and dependency-free -- same
 * pattern as `lib/story/phases.ts` and `lib/demo/scenes.ts` -- so
 * `FilmClient.tsx` only ever calls `resolveBeat(elapsedMs)` and renders the
 * result, never re-derives "what beat is this elapsed time in" itself.
 *
 * Sixteen beats across three acts, summing to exactly 70,000ms (D-46
 * retimed every beat from D-44's original 60s cut; see DECISIONS.md D-46
 * for why each beat's own new duration was chosen):
 *
 *   Act 1 "Without" (19s):       intro 5s, compromise 4s, drain 8s, empty 2s
 *   Act 2 "With Waysafe" (29s):  replay-intro 4s, decline-card-1 5s, quote 4s,
 *                                decline-stablecoin 6s, decline-card-2 2s,
 *                                allow 5s, fleet-glimpse 3s
 *   Act 3 "The results" (22s):   receipt 4s, chain 3s, verify 4s, results 5s,
 *                                endcard 6s
 *
 * D-44's acts landed on an even 20s each; D-46 no longer holds to that --
 * each beat's duration was set individually to what it needs to read on
 * screen, and the three acts land on 19s/29s/22s as a result, not a target
 * in themselves.
 *
 * `decline-stablecoin` (D-44 addendum) is itself two captioned sub-moments,
 * not two beats -- `FilmClient.tsx` splits its own duration internally (the
 * cut to the Safe's revert, then a hold), since both moments are one
 * continuous shot, not a scene change. `quote` (the real Hugging Face
 * agent message, D-32) plays immediately before it.
 *
 * The beat D-44 called `aftermath` is `results` as of D-46 -- renamed to
 * match the copy change on frame 09's own kicker ("Act 3 — the results"),
 * so the beat id and the on-screen label agree instead of one being a
 * historical leftover of the other.
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
  | "results"
  | "endcard";

export interface Beat {
  id: BeatId;
  act: 1 | 2 | 3;
  durationMs: number;
}

/** Within `decline-stablecoin` (D-44 addendum): the ms at which the cut to
 * the Safe's on-chain revert happens, and the caption changes from "You can
 * reason past a rule..." to holding on "The agent's key alone can't
 * sign...". Unchanged by D-46's retiming. */
export const DECLINE_STABLECOIN_CUT_MS = 1_000;

export const BEATS: readonly Beat[] = [
  { id: "intro", act: 1, durationMs: 5_000 },
  { id: "compromise", act: 1, durationMs: 4_000 },
  { id: "drain", act: 1, durationMs: 8_000 },
  { id: "empty", act: 1, durationMs: 2_000 },
  { id: "replay-intro", act: 2, durationMs: 4_000 },
  { id: "decline-card-1", act: 2, durationMs: 5_000 },
  { id: "quote", act: 2, durationMs: 4_000 },
  { id: "decline-stablecoin", act: 2, durationMs: 6_000 },
  { id: "decline-card-2", act: 2, durationMs: 2_000 },
  { id: "allow", act: 2, durationMs: 5_000 },
  { id: "fleet-glimpse", act: 2, durationMs: 3_000 },
  { id: "receipt", act: 3, durationMs: 4_000 },
  { id: "chain", act: 3, durationMs: 3_000 },
  { id: "verify", act: 3, durationMs: 4_000 },
  { id: "results", act: 3, durationMs: 5_000 },
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
