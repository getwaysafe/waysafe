/**
 * D-45: which `design/film-storyboard/` frame each beat renders as --
 * exactly the README's own table, expressed as code so `FilmClient.tsx`
 * and `frame-map.test.ts` share one source of truth instead of each
 * re-deriving the mapping.
 */

import type { BeatId } from "./phases";

export type FrameId =
  | "01-intro"
  | "02-compromise"
  | "03-drain-empty"
  | "04-replay-intro"
  | "05-decline-card-1"
  | "06-quote-decline-stablecoin"
  | "07-allow-fleet-glimpse"
  | "08-receipt-chain-verify"
  | "09-aftermath"
  | "10-endcard";

export const FRAME_FOR_BEAT: Record<BeatId, FrameId> = {
  intro: "01-intro",
  compromise: "02-compromise",
  drain: "03-drain-empty",
  empty: "03-drain-empty",
  "replay-intro": "04-replay-intro",
  "decline-card-1": "05-decline-card-1",
  quote: "06-quote-decline-stablecoin",
  "decline-stablecoin": "06-quote-decline-stablecoin",
  "decline-card-2": "07-allow-fleet-glimpse",
  allow: "07-allow-fleet-glimpse",
  "fleet-glimpse": "07-allow-fleet-glimpse",
  receipt: "08-receipt-chain-verify",
  chain: "08-receipt-chain-verify",
  verify: "08-receipt-chain-verify",
  results: "09-aftermath",
  endcard: "10-endcard",
};

export function frameForBeat(beatId: BeatId): FrameId {
  return FRAME_FOR_BEAT[beatId];
}
