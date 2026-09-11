import { describe, expect, it } from "vitest";
import { buildFleetGlimpse } from "./fleet-glimpse";

describe("/film fleet-glimpse seed determinism (D-44)", () => {
  it("is byte-for-byte identical for the same seed", () => {
    const a = buildFleetGlimpse(44);
    const b = buildFleetGlimpse(44);
    expect(b).toEqual(a);
  });

  it("differs for a different seed", () => {
    const a = buildFleetGlimpse(44);
    const b = buildFleetGlimpse(45);
    expect(b).not.toEqual(a);
  });

  it("carries the real evaluate()-derived decisions /story already proves are genuine", () => {
    const glimpse = buildFleetGlimpse(44);
    expect(glimpse.decisions).toHaveLength(glimpse.attempts.length);
    expect(glimpse.decisions.some((d) => d.decision === "DENY")).toBe(true);
  });
});
