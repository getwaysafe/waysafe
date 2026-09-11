/**
 * D-43 (amendment): the `/story` timeline's coarse phase boundaries --
 * attack, the aftermath beat, the end card. Pure and dependency-free, same
 * pattern as `playback.ts` and `lib/demo/scenes.ts`, so the transition logic
 * is unit-testable and `StoryClient.tsx` never has to re-derive "what phase
 * is this elapsed time in" itself.
 */

export interface PhaseTiming {
  /** The attack: compromise spread + payment attempts. */
  activeDurationMs: number;
  /** The aftermath beat: "Who pays?" then the two answers. */
  aftermathMs: number;
  /** How much of `aftermathMs` is the question, before the answers show. */
  aftermathQuestionMs: number;
  /** The final "same agents, same attack" card. */
  endCardMs: number;
}

export type Phase = "attack" | "aftermath" | "endcard";
export type AftermathStage = "question" | "answer";

export function totalDurationMs(timing: PhaseTiming): number {
  return timing.activeDurationMs + timing.aftermathMs + timing.endCardMs;
}

export function resolvePhase(elapsedMs: number, timing: PhaseTiming): Phase {
  if (elapsedMs < timing.activeDurationMs) return "attack";
  if (elapsedMs < timing.activeDurationMs + timing.aftermathMs) return "aftermath";
  return "endcard";
}

/** Only meaningful when `resolvePhase` returns `"aftermath"` -- callers
 * should not rely on this outside that phase. */
export function resolveAftermathStage(elapsedMs: number, timing: PhaseTiming): AftermathStage {
  const aftermathElapsed = elapsedMs - timing.activeDurationMs;
  return aftermathElapsed < timing.aftermathQuestionMs ? "question" : "answer";
}
