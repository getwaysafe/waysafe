/**
 * D-42: the /demo page's scene state machine. Pure and dependency-free on
 * purpose -- no fetch, no timers, no React -- so it can be unit-tested
 * directly and so the page component only has to wire it to a keypress and
 * a timer, never re-derive its own notion of "what comes next."
 */

export type SceneId = "mandate" | "allowed" | "denied" | "bypass" | "card_rail" | "verify";

export interface Scene {
  id: SceneId;
  title: string;
  caption: string;
}

/**
 * Scene order. `card_rail` is the placeholder D-42's own task named
 * explicitly: the card rail is real (D-32/D-33) but this demo never fakes
 * a Stripe scene against an unfunded sandbox account (see DECISIONS.md's
 * own note on `fa_test_...` still being `status: "pending"`) -- it says so
 * instead of pretending.
 */
export const SCENES: readonly Scene[] = [
  {
    id: "mandate",
    title: "The mandate",
    caption: "A plain-English instruction, compiled into an enforceable policy and bound to a Safe.",
  },
  {
    id: "allowed",
    title: "Allowed purchase",
    caption: "The agent pays the allowed merchant. Waysafe fetches the 402 itself, allows it, and co-signs.",
  },
  {
    id: "denied",
    title: "Denied at policy",
    caption: "The agent tries a merchant that isn't on the mandate. Denied -- nothing reaches the chain.",
  },
  {
    id: "bypass",
    title: "The bypass",
    caption: "The agent's key is stolen. The attacker has no Waysafe SDK.",
  },
  {
    id: "card_rail",
    title: "Card rail",
    caption: "Card rail: pending Stripe sandbox activation (D-37).",
  },
  {
    id: "verify",
    title: "Verify it yourself",
    caption: "Independently checked in your own browser, against Waysafe's published public key.",
  },
] as const;

export interface SceneState {
  index: number;
}

export function initialSceneState(): SceneState {
  return { index: 0 };
}

export function currentScene(state: SceneState): Scene {
  return SCENES[state.index]!;
}

export function isFirstScene(state: SceneState): boolean {
  return state.index === 0;
}

export function isLastScene(state: SceneState): boolean {
  return state.index === SCENES.length - 1;
}

export function nextScene(state: SceneState): SceneState {
  return { index: Math.min(state.index + 1, SCENES.length - 1) };
}

export function prevScene(state: SceneState): SceneState {
  return { index: Math.max(state.index - 1, 0) };
}

export function goToScene(state: SceneState, id: SceneId): SceneState {
  const index = SCENES.findIndex((s) => s.id === id);
  return index === -1 ? state : { index };
}

/** How long autoplay (`?autoplay=1`) pauses on each scene before advancing --
 * the task's own "~4s pauses for hands-free recording." */
export const AUTOPLAY_PAUSE_MS = 4000;
