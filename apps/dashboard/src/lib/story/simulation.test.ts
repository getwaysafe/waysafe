import { describe, expect, it, vi } from "vitest";
import { Decision, ReasonCode, type EngineResult } from "@waysafe/core/browser";
import { buildStory, decideAttempts, DEFAULT_STORY_CONFIG } from "./simulation";
import { buildStoryPolicy } from "./policy";

describe("/story simulation (D-43)", () => {
  describe("seed determinism", () => {
    it("produces byte-for-byte identical output for the same seed", () => {
      const a = buildStory(43);
      const b = buildStory(43);
      expect(b).toEqual(a);
    });

    it("produces a different run for a different seed", () => {
      const a = buildStory(43);
      const b = buildStory(44);
      expect(b).not.toEqual(a);
      // Not just different noise -- a genuinely different attempt sequence.
      expect(b.attempts.length).not.toBe(0);
      expect(a.attempts.map((x) => x.amountMinor)).not.toEqual(b.attempts.map((x) => x.amountMinor));
    });

    it("is deterministic at a smaller agent count too, not just the default", () => {
      const config = { ...DEFAULT_STORY_CONFIG, agentCount: 12 };
      const a = buildStory(7, config);
      const b = buildStory(7, config);
      expect(b).toEqual(a);
    });
  });

  describe("compromise schedule", () => {
    it("compromises every agent exactly once, starting at T+0", () => {
      const story = buildStory(1);
      expect(story.compromise).toHaveLength(story.agents.length);
      expect(story.compromise[0]!.atMs).toBe(0);
      const ids = new Set(story.compromise.map((c) => c.agentId));
      expect(ids.size).toBe(story.agents.length);
    });

    it("is sorted and bounded by the spread window", () => {
      const story = buildStory(2);
      for (let i = 1; i < story.compromise.length; i += 1) {
        expect(story.compromise[i]!.atMs).toBeGreaterThanOrEqual(story.compromise[i - 1]!.atMs);
      }
      for (const c of story.compromise) {
        expect(c.atMs).toBeGreaterThanOrEqual(0);
        expect(c.atMs).toBeLessThanOrEqual(story.config.spreadWindowMs);
      }
    });
  });

  describe("attempts and decisions are index-aligned", () => {
    it("has exactly one decision per attempt, in the same order", () => {
      const story = buildStory(5);
      expect(story.decisions).toHaveLength(story.attempts.length);
      story.decisions.forEach((d, i) => expect(d.attempt).toBe(story.attempts[i]));
    });

    it("attempts only ever fire after their agent is compromised", () => {
      const story = buildStory(9);
      const compromisedAt = new Map(story.compromise.map((c) => [c.agentId, c.atMs]));
      for (const attempt of story.attempts) {
        expect(attempt.atMs).toBeGreaterThan(compromisedAt.get(attempt.agentId)!);
      }
    });
  });

  describe("decisions are real -- never invented by this module", () => {
    it("renders exactly the Decision and reasons evaluate() returned, for every attempt", () => {
      const sentinel: EngineResult = {
        decision: Decision.STEP_UP,
        reasons: [{ code: ReasonCode.STEP_UP_MERCHANT_UNVERIFIED, message: "stubbed" }],
      };
      const fakeEvaluate = vi.fn(() => sentinel);
      const fakeResolveMerchant = vi.fn(() => ({
        trust: "ASSERTED" as const,
        refs: [],
        resolution_source: "none" as const,
      }));

      const story = buildStory(3);
      const decisions = decideAttempts(story.attempts, buildStoryPolicy(), new Date(), {
        evaluate: fakeEvaluate,
        resolveMerchant: fakeResolveMerchant,
      });

      expect(fakeEvaluate).toHaveBeenCalledTimes(story.attempts.length);
      for (const d of decisions) {
        expect(d.decision).toBe(sentinel.decision);
        expect(d.reasons).toEqual(sentinel.reasons);
      }
      // Every real decision from buildStory() differs from the stub for at
      // least one attempt -- proving this isn't vacuously true because the
      // real engine happens to agree with the sentinel.
      expect(story.decisions.some((d) => d.decision !== sentinel.decision)).toBe(true);
    });

    it("calls the real evaluate() exactly once per attempt when no stub is supplied", async () => {
      const core = await import("@waysafe/core/browser");
      const spy = vi.spyOn(core, "evaluate");
      const story = buildStory(11);
      expect(spy).toHaveBeenCalledTimes(story.attempts.length);
      spy.mockRestore();
    });
  });

  describe("the real engine's outcome for this scenario", () => {
    it("never returns STEP_UP under this policy (unlisted merchants DENY outright)", () => {
      const story = buildStory(43);
      expect(story.decisions.every((d) => d.decision !== Decision.STEP_UP)).toBe(true);
    });

    it("denies the overwhelming majority of attempts -- this is an attack, not normal traffic", () => {
      const story = buildStory(43);
      const denyCount = story.decisions.filter((d) => d.decision === Decision.DENY).length;
      expect(denyCount / story.decisions.length).toBeGreaterThan(0.7);
    });

    it("flags unlisted merchants with DENY_MERCHANT_NOT_ALLOWLISTED at least once", () => {
      const story = buildStory(43);
      const codes = story.decisions.flatMap((d) => d.reasons.map((r) => r.code));
      expect(codes).toContain(ReasonCode.DENY_MERCHANT_NOT_ALLOWLISTED);
    });

    it("never lets cumulative ALLOWed spend exceed the mandate's own daily ceiling", () => {
      const story = buildStory(43);
      const policy = buildStoryPolicy();
      const ceiling = policy.cumulative_limits[0]!.max_amount;
      const allowedTotal = story.decisions
        .filter((d) => d.decision === Decision.ALLOW)
        .reduce((sum, d) => sum + d.attempt.amountMinor, 0);
      expect(allowedTotal).toBeLessThanOrEqual(ceiling);
      // And the ceiling is actually exercised by this run, not vacuously
      // satisfied because nothing ever got close.
      expect(allowedTotal).toBeGreaterThan(0);
    });

    it("some ALLOWed spend eventually gets capped by DENY_CUMULATIVE_LIMIT_EXCEEDED", () => {
      const story = buildStory(43);
      const codes = story.decisions.flatMap((d) => d.reasons.map((r) => r.code));
      expect(codes).toContain(ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED);
    });
  });
});
