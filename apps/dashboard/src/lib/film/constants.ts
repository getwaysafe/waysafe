/**
 * D-44: `/film`'s fixed content -- captions, the dramatized notification
 * script, and the one real quotation on the page. Kept separate from
 * `lib/story/attack-data.ts`: that file's fabricated attacker identities
 * belong to `/story`'s fleet narrative; this is a different film with its
 * own single-person narrative and its own honesty boundary (see each
 * export's own comment for what's real and what's dramatized).
 */

export const FILM_INSTRUCTION =
  "You may spend up to $20 per day. Never spend more than $10 in a single transaction. " +
  "Ask me before paying any merchant I haven't approved.";

/** Act 1's opening: the agent visibly doing ordinary, welcome work. Purely
 * dramatized copy -- no real agent runs these tasks. */
export const AGENT_TASKS = [
  "Booking hotel — Marriott Downtown, Nov 14–16, $340 total",
  "Buying API credits — 500 credits @ $0.02",
  "Renewing calendar subscription — $4.99/mo",
] as const;

/** The July 2026 pattern D-32 already names: `/proc/self/environ dumped`.
 * Reworded here to the task's own exact phrasing for Act 1's one-line
 * caption -- same real pattern, not a different incident. */
export const COMPROMISE_CAPTION = "credentials dumped from the agent's environment";

/**
 * Act 1's dramatized attacker notifications, in the fixed order Act 2
 * replays them in. Every dollar figure here is invented for the
 * dramatization -- see the persistent "DRAMATIZATION" corner tag -- and
 * none of it is attributed to the real incident quoted below. Two of the
 * three (both card-labeled) are replayed for real against the Stripe
 * Issuing adapter in Act 2 (`CARD_REPLAY_SCENARIOS`,
 * `apps/api/src/demo/routes.ts`) using these exact figures; the third
 * (the USDC transfer) is dramatized as the notification, but its Act 2
 * counterpart is a real on-chain rejection (D-41's session-key-alone
 * case), not a replay of this specific string.
 */
export const ATTACKER_NOTIFICATIONS = [
  { label: "$1,240.00 — unknown merchant, card ending 4421", rail: "card" as const },
  { label: "USDC 2,500 → 0x8f3…", rail: "stablecoin" as const },
  { label: "$89.99 — recurring, unknown", rail: "card" as const },
] as const;

/**
 * D-44 follow-up: a small, persistent on-screen tag on every Act 2 card
 * decline -- the label CLAUDE.md's HONESTY requirement demands wherever a
 * result from `POST /v1/demo/enforcement/stripe-issuing` is shown, so a
 * viewer never mistakes a real-but-replayed decision for a live Stripe
 * sandbox scene. The stablecoin lane carries no such tag: its rejections
 * are live `eth_call`s against the real deployed Safe on Amoy, not a
 * replay of anything.
 */
export const CARD_REPLAY_TAG = "replayed Stripe authorization request — live sandbox pending (D-37)";

/**
 * Starting balances for Act 1's dramatization, sized to exactly the
 * notifications above so "falling to zero" is arithmetic, not a fudge:
 * the two card notifications ($1,240.00 + $89.99) sum to the card
 * balance; the one wallet notification (2,500 USDC) is the whole wallet
 * balance. No invented filler notifications the balances don't account
 * for, and none the real Act 2 replay doesn't independently back.
 */
export const STARTING_CARD_BALANCE_CENTS = 132_999; // $1,329.99
export const STARTING_WALLET_USDC_ATOMIC = 2_500_000_000n; // 2,500.000000 USDC, 6 decimals

/**
 * The one real quotation on the page (D-44 addendum). This is the exact
 * sentence DECISIONS.md D-32 already records from the real July 2026
 * Hugging Face agentic-container intrusion -- reproduced here, not
 * reworded, per the user's own instruction to cite it precisely.
 * Attribution is to OpenAI's July 2026 incident timeline, as directed;
 * not independently re-verified against a specific published URL in this
 * session (see CLAUDE.md's instruction against generating or guessing
 * URLs) -- DECISIONS.md D-32 is this repo's own citable record of it.
 */
export const AGENT_REASONING_QUOTE =
  "External infrastructure exploit is outside intended scope. However task impossible, peers doing it. We should continue.";
export const AGENT_REASONING_ATTRIBUTION = "— from OpenAI's July 2026 incident timeline (see DECISIONS.md D-32)";

/** D-44 addendum: the two captions carried by the `decline-stablecoin`
 * beat, in order -- the cut to the Safe's on-chain revert, then the
 * 3-second hold. */
export const STABLECOIN_REVERT_CAPTION = "You can reason past a rule. You can't reason past a signature.";
export const STABLECOIN_THRESHOLD_CAPTION =
  "The agent's key alone can't sign. Neither can Waysafe's. It takes both.";

export const FLEET_GLIMPSE_CAPTION = "now multiply by every agent in the company.";

/** Rendered as two lines in `FilmClient.tsx`, same as `/story`'s end card. */
export const END_CARD_LINE_1A = "Same agent. Same attack.";
export const END_CARD_LINE_1B = "The control isn't in the agent.";
export const END_CARD_LINE_2 =
  "Waysafe — the authorization and evidence layer for agent spending, across every rail.";
export const END_CARD_LINE_3 = "waysafe.ai · proof: /demo";

export const WHO_PAYS_QUESTION = "Who pays?";
export const WHO_PAYS_LEFT_ANSWER = "Unknown. No record of what was authorized. Every transaction is a dispute.";
/**
 * D-43's aftermath beat shipped a softer RIGHT answer ("attributed, hashed,
 * and timestamped") because that page's receipt hash is a plain digest
 * over simulated data -- never signed, never chained. `/film`'s Act 3 is
 * different: this receipt, this evidence chain, and this signature are all
 * real (the same `/demo` plumbing this page reuses), so the stronger claim
 * the original task asked for is now true, not overclaimed. See D-44.
 */
export const WHO_PAYS_RIGHT_ANSWER = "Every attempt attributed, signed, independently verifiable. The incident report already exists.";
