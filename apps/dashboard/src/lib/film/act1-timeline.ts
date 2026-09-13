/**
 * D-44: Act 1's dramatization timeline. Fixed, not seeded -- unlike
 * `/story`'s procedural fleet, Act 1 tells one specific, fixed story (see
 * `constants.ts`'s `ATTACKER_NOTIFICATIONS`), so there is nothing here for
 * `?seed=` to vary; `/film`'s only seed-sensitive content is the Act 2
 * fleet-glimpse (`fleet-glimpse.ts`). Still pure and dependency-free, same
 * reasoning as every other `lib/film`/`lib/story` module: `FilmClient.tsx`
 * should render this, never compute it inline.
 */

import { ATTACKER_NOTIFICATIONS, STARTING_CARD_BALANCE_CENTS, STARTING_WALLET_USDC_ATOMIC } from "./constants";

export interface TimedNotification {
  index: number;
  rail: "card" | "stablecoin";
  /** ms since the "drain" beat itself started. */
  atMs: number;
}

/** Accelerating gaps (3400ms, then 2400ms) -- three notifications is few
 * enough that "faster and faster" has to come from shrinking gaps between
 * named events, not from a dense procedural flurry the way `/story`'s
 * 200-agent fleet can afford. */
export const NOTIFICATION_TIMES_MS = [1_800, 5_200, 7_600] as const;

/** Timing only -- the display copy for each notification lives in
 * `constants.ts`'s `ATTACKER_NOTIFICATIONS`, indexed by `.index`. */
export function buildAct1Notifications(): TimedNotification[] {
  return ATTACKER_NOTIFICATIONS.map((n, i) => ({
    index: i,
    rail: n.rail,
    atMs: NOTIFICATION_TIMES_MS[i]!,
  }));
}

/** The two card notifications' amounts, in the order they fire -- kept
 * alongside the wallet's own single amount, both exactly sized to their
 * starting balance (see `constants.ts`), so the balance genuinely reaches
 * zero from real arithmetic on these events, not a separate hardcoded
 * "0.00" the rest of the timeline ignores. */
const CARD_DEDUCTIONS_CENTS = [124_000, 8_999] as const;
const WALLET_DEDUCTIONS_ATOMIC = [2_500_000_000n] as const;

export interface BalancesAtMs {
  cardCents: number;
  walletAtomic: bigint;
}

/** The running balance at `elapsedMs` into the "drain" beat -- deducts
 * each notification's own amount from its own instrument, in order, the
 * instant that notification's `atMs` is reached; never goes below zero. */
export function balancesAtMs(elapsedMs: number): BalancesAtMs {
  const notifications = buildAct1Notifications();
  let cardCents = STARTING_CARD_BALANCE_CENTS;
  let walletAtomic = STARTING_WALLET_USDC_ATOMIC;
  let cardIdx = 0;
  let walletIdx = 0;

  for (const n of notifications) {
    if (elapsedMs < n.atMs) continue;
    if (n.rail === "card") {
      cardCents = Math.max(0, cardCents - (CARD_DEDUCTIONS_CENTS[cardIdx] ?? 0));
      cardIdx += 1;
    } else {
      const deduction = WALLET_DEDUCTIONS_ATOMIC[walletIdx] ?? 0n;
      walletAtomic = walletAtomic > deduction ? walletAtomic - deduction : 0n;
      walletIdx += 1;
    }
  }

  return { cardCents, walletAtomic };
}
