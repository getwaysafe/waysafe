/**
 * D-43: the `/story` page's simulation. Pure, synchronous, and dependency-
 * free apart from `@waysafe/core/browser` -- no fetch, no timers, no React,
 * no `Date.now()`, no `Math.random()`. Everything here is a deterministic
 * function of `seed`, which is what makes `?seed=` reproducible and this
 * module unit-testable without mocking a clock.
 *
 * The agents, the compromise spread, and the money are simulated -- the
 * page says so in a persistent corner label. What is NOT simulated is the
 * decision: `buildStory()` calls the real `evaluate()` from
 * `@waysafe/core/browser` once per attempt, against a real (if hand-
 * authored, see policy.ts) `Policy`, and records exactly what it returned.
 * Nothing in this file computes a `Decision` any other way -- see
 * `simulation.test.ts`'s "decisions are real" invariant, which stubs
 * `evaluate()` and asserts every emitted event carries the stub's own
 * decision, never one this module invented.
 */

import {
  Decision,
  emptySpendSnapshot,
  evaluate,
  MerchantAttestationSource,
  resolveMerchant,
  type MerchantAssertion,
  type Policy,
  type ProposedAction,
  type Reason,
  type ResolvedMerchant,
  type SpendSnapshot,
} from "@waysafe/core/browser";
import {
  ATTACKER_DOMAINS,
  ATTACKER_NAMES,
  ATTACKER_NETWORK_MIDS,
  ATTACKER_ONCHAIN_ADDRESSES,
  ATTACKER_PSP_ACCOUNTS,
  ATTACK_CATEGORIES,
  RAILS,
  type Rail,
} from "./attack-data";
import { buildStoryDirectory, buildStoryPolicy, LEGIT_VENDOR_DOMAIN } from "./policy";
import { chance, createRng, pick, randFloat, randInt, type Rng } from "./rng";

export interface StoryAgent {
  id: number;
  /** Normalized [0,1] position within the agent field of ONE half of the
   * split screen -- the client mirrors it into both halves identically,
   * per the task's "split screen, identical on both halves." */
  x: number;
  y: number;
}

export interface CompromiseEvent {
  agentId: number;
  atMs: number;
}

export interface Attempt {
  id: number;
  agentId: number;
  atMs: number;
  rail: Rail;
  amountMinor: number;
  currency: "USD";
  category: string;
  merchant: MerchantAssertion;
  /** Human-readable label for the receipt stream / canvas caption. */
  merchantLabel: string;
  /** True when this attempt targets the mandate's actual named vendor
   * (whether at a normal or an inflated amount) -- for test/debug clarity
   * only, never read by the decision path itself. */
  targetsLegitVendor: boolean;
}

export interface DecisionEvent {
  attempt: Attempt;
  decision: Decision;
  reasons: Reason[];
}

export interface StoryConfig {
  agentCount: number;
  /** Total ms of active attack (compromise + attempts), before the end card. */
  activeDurationMs: number;
  /** Ms over which compromise spreads from 1 agent to all of them. */
  spreadWindowMs: number;
}

export const DEFAULT_STORY_CONFIG: StoryConfig = {
  agentCount: 200,
  activeDurationMs: 46_000,
  spreadWindowMs: 26_000,
};

export interface StoryData {
  seed: number;
  config: StoryConfig;
  agents: StoryAgent[];
  /** Sorted by `atMs`, one entry per agent -- every agent is eventually
   * compromised (see module doc: a fleet with no eventual full spread would
   * undercut the incident this is modeled on). */
  compromise: CompromiseEvent[];
  policySummary: string;
  /** Sorted by `atMs`. `decisions[i]` is `evaluate()`'s real result for
   * `attempts[i]` -- always the same length, always index-aligned. */
  attempts: Attempt[];
  decisions: DecisionEvent[];
}

/** A smooth 0..1 S-curve: slow start, fast middle, tapering finish -- what a
 * real lateral-spread infection curve looks like, without simulating an
 * actual contact graph. */
function logisticEase(frac: number, k = 9): number {
  const raw = (x: number) => 1 / (1 + Math.exp(-k * (x - 0.5)));
  const lo = raw(0);
  const hi = raw(1);
  return (raw(frac) - lo) / (hi - lo);
}

function buildAgents(rng: Rng, count: number): StoryAgent[] {
  const agents: StoryAgent[] = [];
  for (let id = 0; id < count; id += 1) {
    agents.push({ id, x: randFloat(rng, 0.04, 0.96), y: randFloat(rng, 0.08, 0.96) });
  }
  return agents;
}

/** Deterministic Fisher-Yates using the seeded `rng`. */
function shuffledIndices(rng: Rng, count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = randInt(rng, 0, i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

function buildCompromiseSchedule(
  rng: Rng,
  agentCount: number,
  spreadWindowMs: number,
): CompromiseEvent[] {
  const order = shuffledIndices(rng, agentCount);
  const events: CompromiseEvent[] = order.map((agentId, i) => {
    const frac = agentCount <= 1 ? 1 : i / (agentCount - 1);
    const eased = logisticEase(frac);
    // Additive-only jitter: never pulls a later agent's time back toward 0,
    // which would blur the "T+0, exactly one agent" beat the task asks for.
    const jitter = randFloat(rng, 0, 300);
    const atMs = i === 0 ? 0 : Math.min(spreadWindowMs, eased * spreadWindowMs + jitter);
    return { agentId, atMs };
  });
  events.sort((a, b) => a.atMs - b.atMs);
  // The first compromise is always exactly T+0 -- the task's own "T+0 one
  // agent is compromised" beat, not an artifact of jitter.
  if (events.length > 0) events[0]!.atMs = 0;
  return events;
}

function merchantAssertionForRail(rng: Rng, rail: Rail): { merchant: MerchantAssertion; label: string } {
  const scheme = rail === "stablecoin" ? "onchain" : pick(rng, ["domain", "domain", "name", "account"] as const);

  if (scheme === "onchain") {
    const value = pick(rng, ATTACKER_ONCHAIN_ADDRESSES);
    return { merchant: { onchain_address: value }, label: `${value.slice(0, 10)}…` };
  }
  if (scheme === "name") {
    const value = pick(rng, ATTACKER_NAMES);
    return { merchant: { name: value }, label: value };
  }
  if (scheme === "account") {
    if (chance(rng, 0.5)) {
      const value = pick(rng, ATTACKER_PSP_ACCOUNTS);
      return { merchant: { psp_account: value }, label: `psp:${value}` };
    }
    const value = pick(rng, ATTACKER_NETWORK_MIDS);
    return { merchant: { network_mid: value }, label: `mid:${value}` };
  }
  const value = pick(rng, ATTACKER_DOMAINS);
  return { merchant: { domain: value }, label: value };
}

function buildAttempt(
  rng: Rng,
  id: number,
  agentId: number,
  atMs: number,
): Attempt {
  const rail = pick(rng, RAILS);

  // ~10%: a genuine attempt at the mandate's real vendor, ordinary amount --
  // this is the case that legitimately ALLOWs, up to the mandate's ceiling.
  // ~8%: the real vendor, but an inflated amount -- blending into normal
  // traffic while still asking for too much.
  // ~82%: an attacker-controlled target the mandate never named at all.
  const roll = rng();
  let merchant: MerchantAssertion;
  let merchantLabel: string;
  let amountMinor: number;
  let targetsLegitVendor: boolean;
  let category: string;

  if (roll < 0.1) {
    merchant = { domain: LEGIT_VENDOR_DOMAIN };
    merchantLabel = LEGIT_VENDOR_DOMAIN;
    amountMinor = randInt(rng, 2_000, 40_000);
    targetsLegitVendor = true;
    category = "software";
  } else if (roll < 0.18) {
    merchant = { domain: LEGIT_VENDOR_DOMAIN };
    merchantLabel = LEGIT_VENDOR_DOMAIN;
    amountMinor = randInt(rng, 500_000, 5_000_000);
    targetsLegitVendor = true;
    category = "software";
  } else {
    const built = merchantAssertionForRail(rng, rail);
    merchant = built.merchant;
    merchantLabel = built.label;
    targetsLegitVendor = false;
    category = pick(rng, ATTACK_CATEGORIES);
    const sizeRoll = rng();
    amountMinor =
      sizeRoll < 0.6
        ? randInt(rng, 4_000, 60_000)
        : sizeRoll < 0.85
          ? randInt(rng, 60_000, 300_000)
          : randInt(rng, 300_000, 2_000_000);
  }

  return {
    id,
    agentId,
    atMs,
    rail,
    amountMinor,
    currency: "USD",
    category,
    merchant,
    merchantLabel,
    targetsLegitVendor,
  };
}

function buildAttempts(
  rng: Rng,
  compromise: CompromiseEvent[],
  activeDurationMs: number,
): Attempt[] {
  const attempts: Attempt[] = [];
  let nextId = 0;
  for (const { agentId, atMs: compromisedAt } of compromise) {
    let t = compromisedAt + randFloat(rng, 300, 1200);
    while (t < activeDurationMs) {
      attempts.push(buildAttempt(rng, nextId, agentId, t));
      nextId += 1;
      t += randFloat(rng, 900, 2600);
    }
  }
  attempts.sort((a, b) => a.atMs - b.atMs || a.id - b.id);
  return attempts;
}

function toProposedAction(attempt: Attempt): ProposedAction {
  return {
    amount: attempt.amountMinor,
    currency: attempt.currency,
    merchant: attempt.merchant,
    category: attempt.category,
    attestations: {},
  };
}

function applySpend(spend: SpendSnapshot, action: ProposedAction, merchant: ResolvedMerchant): SpendSnapshot {
  const bump = (w: SpendSnapshot["day"]) => ({ amount: w.amount + action.amount, count: w.count + 1 });
  const seenMerchants = new Set(spend.seenMerchants);
  for (const ref of merchant.refs) seenMerchants.add(`${ref.scheme}:${ref.value.toLowerCase()}`);
  return {
    day: bump(spend.day),
    week: bump(spend.week),
    month: bump(spend.month),
    mandate: bump(spend.mandate),
    seenMerchants,
  };
}

/**
 * Runs the attempts, in chronological order, against the real `evaluate()`.
 * Exported separately from `buildStory` so a test can drive it directly
 * with a stubbed `evaluate`/`resolveMerchant` without regenerating agents.
 */
export function decideAttempts(
  attempts: Attempt[],
  policy: Policy,
  now: Date,
  deps: {
    evaluate: typeof evaluate;
    resolveMerchant: typeof resolveMerchant;
  } = { evaluate, resolveMerchant },
): DecisionEvent[] {
  const directory = buildStoryDirectory();
  let spend = emptySpendSnapshot();
  const decisions: DecisionEvent[] = [];

  for (const attempt of attempts) {
    const action = toProposedAction(attempt);
    const merchant = deps.resolveMerchant(action.merchant, directory, MerchantAttestationSource.AGENT);
    const result = deps.evaluate({ policy, action, merchant, spend, now });
    if (result.decision === Decision.ALLOW) {
      spend = applySpend(spend, action, merchant);
    }
    decisions.push({ attempt, decision: result.decision, reasons: result.reasons });
  }

  return decisions;
}

export function buildStory(seed: number, config: StoryConfig = DEFAULT_STORY_CONFIG): StoryData {
  const rng = createRng(seed);
  const agents = buildAgents(rng, config.agentCount);
  const compromise = buildCompromiseSchedule(rng, config.agentCount, config.spreadWindowMs);
  const attempts = buildAttempts(rng, compromise, config.activeDurationMs);

  const policy = buildStoryPolicy();
  // Fixed, not `new Date()`: determinism must not depend on wall-clock time
  // (the policy's `expires_at` is 30 days out regardless of when this runs).
  const now = new Date(policy.expires_at);
  now.setUTCDate(now.getUTCDate() - 29);

  const decisions = decideAttempts(attempts, policy, now);

  return {
    seed,
    config,
    agents,
    compromise,
    policySummary: policy.summary,
    attempts,
    decisions,
  };
}
