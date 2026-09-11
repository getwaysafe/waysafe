import { describe, expect, it } from "vitest";
import { resolveAftermathStage, resolvePhase, totalDurationMs, type PhaseTiming } from "./phases";

const TIMING: PhaseTiming = {
  activeDurationMs: 46_000,
  aftermathMs: 6_000,
  aftermathQuestionMs: 1_800,
  endCardMs: 4_000,
};

describe("/story phase timeline (D-43 amendment)", () => {
  it("totals the three beats", () => {
    expect(totalDurationMs(TIMING)).toBe(56_000);
  });

  it("is 'attack' for the whole active duration, exclusive of the boundary", () => {
    expect(resolvePhase(0, TIMING)).toBe("attack");
    expect(resolvePhase(45_999, TIMING)).toBe("attack");
    expect(resolvePhase(46_000, TIMING)).toBe("aftermath");
  });

  it("is 'aftermath' for exactly aftermathMs, then 'endcard'", () => {
    expect(resolvePhase(46_000, TIMING)).toBe("aftermath");
    expect(resolvePhase(51_999, TIMING)).toBe("aftermath");
    expect(resolvePhase(52_000, TIMING)).toBe("endcard");
  });

  it("stays 'endcard' through the rest of the timeline, including past the total", () => {
    expect(resolvePhase(55_999, TIMING)).toBe("endcard");
    expect(resolvePhase(56_000, TIMING)).toBe("endcard");
    expect(resolvePhase(999_999, TIMING)).toBe("endcard");
  });

  it("the aftermath beat shows the question first, then the answers", () => {
    expect(resolveAftermathStage(46_000, TIMING)).toBe("question");
    expect(resolveAftermathStage(46_000 + 1_799, TIMING)).toBe("question");
    expect(resolveAftermathStage(46_000 + 1_800, TIMING)).toBe("answer");
    expect(resolveAftermathStage(46_000 + 5_999, TIMING)).toBe("answer");
  });
});
