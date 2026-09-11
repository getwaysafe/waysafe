/**
 * D-44: the optional 5-second "now multiply by every agent in the company"
 * widen at the end of Act 2. This is the one place `/film` is seed-
 * sensitive -- Act 1's script is fixed (three real, hand-authored
 * notifications; nothing procedural to seed), so `?seed=` flows entirely
 * through this single integration point into `/story`'s own simulation.
 *
 * Deliberately a thin, undecorated wrapper around `buildStory` rather than
 * a copy of its logic: the fleet-glimpse beat doesn't replay the full 46s
 * attack, it renders one snapshot of the same real data `/story` already
 * computed with the real `evaluate()` (see `lib/story/simulation.ts`'s own
 * doc comment) -- reusing the function outright is what keeps that
 * genuineness intact here instead of re-deriving it.
 */

import { buildStory, type StoryData } from "../story/simulation";

export function buildFleetGlimpse(seed: number): StoryData {
  return buildStory(seed);
}
