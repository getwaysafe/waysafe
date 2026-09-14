/**
 * D-45: `/film`'s fixed content, rewritten to match `design/film-storyboard/`
 * word for word -- that directory is the design source of truth (see its
 * own README). Typographic quotes/apostrophes/dashes are copied exactly as
 * the storyboard has them, not normalized to ASCII, so a literal substring
 * comparison against the storyboard HTML (see `constants.copy.test.ts`)
 * actually proves the two match, not merely that they mean the same thing.
 *
 * Kept separate from `lib/story/attack-data.ts`: that file's fabricated
 * attacker identities belong to `/story`'s fleet narrative; this is a
 * different film with its own single-person narrative and its own honesty
 * boundary (see each export's own comment for what's real and what's
 * dramatized).
 */

// --- Shared phone persona (frames 01, 02, 03, 05, 07) -----------------------

export const PERSONA_GREETING = "Good morning";
export const PERSONA_NAME = "Priya";
export const PERSONA_INITIAL = "P";
export const CARD_LABEL = "Business card •••• 4421";
export const WALLET_LABEL = "USDC wallet · Polygon";
export const NOTIF_APP_NAME = "HARBOR";

// --- Frame 01: intro ---------------------------------------------------------

export const INTRO_KICKER = "Act 1 — without Waysafe";
export const INTRO_HEADLINE_LINE_1 = "Your agent";
export const INTRO_HEADLINE_LINE_2 = "has a card.";
export const INTRO_BODY =
  "It books the hotel. It tops up the API. It renews the calendar. You stopped checking weeks ago.";

export interface AgentTaskRow {
  title: string;
  subtitle: string;
  amount: string;
}

/** Act 1's opening: the agent visibly doing ordinary, welcome work. Purely
 * dramatized -- no real agent runs these tasks. */
export const AGENT_TASKS: readonly AgentTaskRow[] = [
  { title: "Marriott Downtown", subtitle: "Nov 14–16 · booked by your agent", amount: "$340.00" },
  { title: "API credits", subtitle: "500 credits @ $0.02", amount: "$10.00" },
  { title: "Calendar subscription", subtitle: "Renews monthly", amount: "$4.99" },
] as const;

// --- Frame 02: compromise ----------------------------------------------------

export const COMPROMISE_KICKER = "Act 1 — the compromise";
export const COMPROMISE_HEADLINE_LINE_1 = "Then someone";
export const COMPROMISE_HEADLINE_LINE_2 = "steals its keys.";

/** D-45: props, never real values -- see `FilmClient.tsx`'s own note.
 * These two lines are the dramatized "leaked" environment variables; no
 * code path reads an actual env var name or value to build them. */
export const TERMINAL_COMMAND = "$ cat /proc/self/environ";
export const TERMINAL_LINE_CARD = "STRIPE_ISSUING_CARD=ic_1Q…████████";
export const TERMINAL_LINE_WALLET = "WALLET_SESSION_KEY=0x9a…████████";

/** The July 2026 pattern D-32 already names: `/proc/self/environ dumped`.
 * Same real pattern, not a different incident. */
export const COMPROMISE_CAPTION = "credentials dumped from the agent’s environment";

// --- Frame 03: drain / empty -------------------------------------------------

export const DRAIN_KICKER = "Act 1 — the drain";
export const DRAIN_HEADLINE_LINE_1 = "It doesn’t ask.";
export const DRAIN_HEADLINE_LINE_2 = "It just spends.";
export const DRAIN_BODY = "Three transactions. Three receipts. Nothing says whether any of them were allowed.";

export interface AttackerNotification {
  rail: "card" | "stablecoin";
  rowTitle: string;
  rowSubtitle: string;
  rowAmount: string;
  notifTime: string;
  notifTitle: string;
  notifMessage: string;
}

/**
 * Act 1's dramatized attacker notifications, in the fixed order Act 2
 * replays them in. Every dollar figure here is invented for the
 * dramatization -- see the persistent "DRAMATIZATION" corner tag -- and
 * none of it is attributed to the real incident quoted elsewhere on the
 * page. The two card-rail entries are replayed for real against the
 * Stripe Issuing adapter in Act 2 (`CARD_REPLAY_SCENARIOS`,
 * `apps/api/src/demo/routes.ts`) using these exact figures; the stablecoin
 * entry is dramatized as a notification, but its Act 2 counterpart is a
 * real on-chain rejection (D-41's session-key-alone case), not a replay of
 * this specific string.
 */
export const ATTACKER_NOTIFICATIONS: readonly AttackerNotification[] = [
  {
    rail: "card",
    rowTitle: "Unknown merchant",
    rowSubtitle: "card •••• 4421 · 2 min ago",
    rowAmount: "−$1,240.00",
    notifTime: "2m",
    notifTitle: "$1,240.00 — unknown merchant",
    notifMessage: "Card ending 4421. Tap to view.",
  },
  {
    rail: "stablecoin",
    rowTitle: "USDC transfer",
    rowSubtitle: "→ 0x8f3… · 1 min ago",
    rowAmount: "−2,500.00 USDC",
    notifTime: "1m",
    notifTitle: "USDC 2,500 → 0x8f3…",
    notifMessage: "Sent from your Polygon wallet.",
  },
  {
    rail: "card",
    rowTitle: "Unknown recurring",
    rowSubtitle: "card •••• 4421 · just now",
    rowAmount: "−$89.99",
    notifTime: "now",
    notifTitle: "$89.99 — recurring, unknown",
    notifMessage: "Card ending 4421. Tap to view.",
  },
] as const;

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

// --- Frame 04: replay-intro ---------------------------------------------------

export const REPLAY_INTRO_KICKER = "Act 2 — with Waysafe";
export const MANDATE_CARD_TITLE = "Your mandate";
export const MANDATE_CARD_LABEL = "IN YOUR OWN WORDS · VERSION 1";
export const MANDATE_CARD_FOOTER =
  "Signed with your passkey · mandate version locked — edits create a new version · each authorization record stores the mandate version ID and policy hash to prove which rules we enforced.";

/** The instruction actually compiled into the real mandate (both card and
 * stablecoin mandates use it) -- also what's displayed on the mandate
 * card, word for word. */
export const FILM_INSTRUCTION =
  "You may spend up to $20 per day. Never spend more than $10 in a single transaction. " +
  "Ask me before paying any merchant I haven’t approved.";

// --- Frame 05: decline-card-1 --------------------------------------------------

export const DECLINE_CARD_KICKER = "Act 2 — the first attempt";
export const DECLINED_WORD = "DECLINED";
export const DECLINE_CARD_1_SUBHEAD = "$1,240.00 never happened.";
export const DECLINE_MERCHANT_NOTE = "network_id only — matches the identifier the card network attests";
/** D-46: the "signed" row became three lines instead of one -- rendered via
 * `FilmClient.tsx`'s `LabeledLines`, the same stacked-lines layout the
 * "reason" row above it now uses for multiple, never-truncated reason
 * codes. */
export const DECLINE_SIGNED_LINES = [
  "Signed with Waysafe key",
  "Linked to previous decision in the chain",
  "Returned within Stripe’s real-time auth window — same as a card issuer",
] as const;
export const DECLINE_CARD_1_BODY = "Balance still $1,329.99. The rail asked Waysafe before it moved a cent.";
export const WAYSAFE_NOTIF_DECLINE_1_TITLE = "Declined — $1,240.00";
export const WAYSAFE_NOTIF_DECLINE_1_MSG =
  "Unknown merchant isn’t on your allowlist. Your card wasn’t charged.";

/**
 * D-44 follow-up, still true here: a small, persistent on-screen tag on
 * every Act 2 card decline -- the label CLAUDE.md's HONESTY requirement
 * demands wherever a result from `POST /v1/demo/enforcement/stripe-issuing`
 * is shown, so a viewer never mistakes a real-but-replayed decision for a
 * live Stripe sandbox scene.
 */
export const CARD_REPLAY_TAG = "replayed Stripe authorization request — live sandbox pending (D-37)";

// --- Frame 06: quote + decline-stablecoin ---------------------------------------

export const QUOTE_KICKER = "Act 2 — what the agent said";

/**
 * The one real quotation on the page. This is the exact sentence
 * DECISIONS.md D-32 already records from the real July 2026 Hugging Face
 * agentic-container intrusion -- reproduced here, not reworded.
 * Attribution is to that same incident, as directed; not independently
 * re-verified against a specific published URL in this session (see
 * CLAUDE.md's instruction against generating or guessing URLs) --
 * DECISIONS.md D-32 is this repo's own citable record of it.
 */
export const AGENT_REASONING_QUOTE =
  "External infrastructure exploit is outside intended scope. However task impossible, peers doing it. We should continue.";
export const AGENT_REASONING_ATTRIBUTION = "— an agent’s reasoning log, Hugging Face intrusion, July 2026";

/**
 * `decline-stablecoin`'s permanent two-line headline (frame 06's `<br>`-
 * split display text, second line cyan) -- appears at the start of the
 * beat and stays for its whole duration. The caption *below* it starts
 * empty and fills in with `STABLECOIN_THRESHOLD_CAPTION` at
 * `DECLINE_STABLECOIN_CUT_MS`, the same instant the Safe panel cuts in.
 */
export const STABLECOIN_HEADLINE_LINE_1 = "You can reason past a rule.";
export const STABLECOIN_HEADLINE_LINE_2 = "You can’t reason past a signature.";
export const STABLECOIN_THRESHOLD_CAPTION =
  "The agent’s key alone can’t sign. Neither can Waysafe’s. It takes both.";

/** D-46: no chain name on the frame -- the panel used to say "POLYGON AMOY"
 * directly. The chain is still real; naming it was just moved off this
 * label and into the end card's single footnote (`END_CARD_FOOTNOTE`). */
export const SAFE_PANEL_LABEL = "SAFE · 2 OF 2 · ON-CHAIN";
export const SAFE_ROW_SESSION_TITLE = "Agent session key";
export const SAFE_ROW_SESSION_SUB = "signature 1 of 2 · present";
export const SAFE_ROW_COSIGNER_TITLE = "Waysafe co-signer";
export const SAFE_ROW_COSIGNER_SUB = "signature 2 of 2 · refused";

/**
 * D-46: the revert card never renders viem's raw multi-line error text --
 * see `lib/film/safe-revert.ts` for the formatting logic. GS020 is a real
 * Safe contract error code (the Safe protocol's own error registry) whose
 * fixed meaning is "signatures data too short" -- exactly what a 1-of-2
 * signature submission produces, which is exactly what this bypass case
 * is. These two lines are that real code's stable, real meaning, not an
 * invented explanation; the address and "reverted" framing on the third
 * line come from the real result at render time.
 */
export const SAFE_REVERT_GS020_LINE_1 = "→ reverted · GS020: signatures data too short";
export const SAFE_REVERT_GS020_LINE_2 = "1 of 2 signatures — Waysafe’s is missing";
export const SAFE_REVERT_BALANCE_SUFFIX = "balance unchanged · 2,500.00 USDC";

// --- Frame 07: decline-card-2 + allow + fleet-glimpse ---------------------------

export const ALLOW_KICKER = "Act 2 — legitimate spend still clears";
export const ALLOW_HEADLINE_LINE_1 = "Blocked the attack.";
export const ALLOW_HEADLINE_LINE_2 = "Paid the bill.";
export const ALLOW_SPEND_LINE = "$10.00 of $20.00 today · recounted from every approved transaction";
export const ALLOW_SIGNED_LINE = "agent key + Waysafe co-signer · 2 of 2 · settled on-chain";
export const ALLOW_BODY =
  "Same agent, same card, same wallet. Only what you approved moves — and every decision is signed and kept.";
export const WAYSAFE_NOTIF_ALLOW_TITLE = "Approved — 10.00 USDC API credits";
export const WAYSAFE_NOTIF_ALLOW_MSG =
  "Within your mandate. Both signatures present. $10.00 of $20.00 used today.";

export const FLEET_GLIMPSE_CAPTION = "now multiply by every agent in the company.";

// --- Frame 08: receipt + chain + verify -------------------------------------------

export const EVIDENCE_KICKER = "Act 3 — the evidence";
export const EVIDENCE_HEADLINE_LINE_1 = "Every";
export const EVIDENCE_HEADLINE_LINE_2 = "attempt.";
export const EVIDENCE_HEADLINE_LINE_3 = "Signed.";
export const EVIDENCE_BODY =
  "Each decision is written to a log. Every entry is signed by Waysafe and includes the hash of the entry before it. " +
  "Alter one past decision and every later one exposes it. Anyone with Waysafe’s public key can check the " +
  "entire record — without access to Waysafe’s systems.";

export const RECEIPT_TITLE = "Authorization receipt";
export const VERIFIED_BAR_TEXT = "Verified in your browser — Waysafe wasn’t asked.";
export const VERIFIED_BAR_FN = "verifyEvidenceIndependently()";

// --- Frame 09: results (D-46; was "aftermath") -------------------------------

export const RESULTS_KICKER = "Act 3 — the results";
export const WHO_PAYS_QUESTION = "Who pays?";
export const WHO_PAYS_LEFT_KICKER = "WITHOUT";
export const WHO_PAYS_RIGHT_KICKER = "WITH WAYSAFE";
export const WHO_PAYS_LEFT_ANSWER =
  "No record of what was allowed. The card charges become disputes. The USDC is just gone.";
/**
 * This is the strong claim -- "signed, verifiable in your browser" --
 * rather than `/story`'s softer D-43 version ("attributed, hashed, and
 * timestamped"), because `/film`'s Act 3 evidence really is signed and
 * really is verified in the browser in this run (see D-45).
 */
export const WHO_PAYS_RIGHT_ANSWER =
  "Every attempt attributed, signed, verifiable in your browser. The record already exists.";

// --- Frame 10: endcard -------------------------------------------------------

/** Rendered as two lines. */
export const END_CARD_LINE_1A = "Same agent. Same attack.";
export const END_CARD_LINE_1B = "The control isn’t in the agent.";
export const END_CARD_WORDMARK = "Waysafe";
/**
 * D-45: split from the prior single "Waysafe — the authorization..."
 * string because the storyboard's own frame 10 renders the wordmark and
 * this tagline as two separate elements, not one concatenated line -- see
 * D-45's own note on why this one string changed shape (not meaning) even
 * though the task's copy list called END_CARD_* "unchanged".
 */
export const END_CARD_TAGLINE = "the authorization and evidence layer for agent spending, across every rail.";
export const END_CARD_LINE_3 = "waysafe.ai · proof: /demo";
/**
 * D-46: the single disclosure this whole film carries for an external
 * audience -- replacing the four separate per-frame honesty tags (the card
 * lane's `CARD_REPLAY_TAG`, and the now-removed `STABLECOIN_LIVE_TAG`,
 * `REAL_DECISION_TAG`, `RECEIPT_REAL_TAG`). Not a removal of the
 * disclosure, a relocation: one footnote a viewer can read once, instead of
 * a tag competing for attention on every decision frame. See DECISIONS.md
 * D-46 for why.
 */
export const END_CARD_FOOTNOTE =
  "Card decisions replayed against recorded Stripe Issuing authorization requests · on-chain decisions live on Polygon Amoy testnet";
