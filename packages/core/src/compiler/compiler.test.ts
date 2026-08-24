import { describe, expect, it } from "vitest";
import { FixtureIntentCompiler } from "./fixture.js";
import { buildConfirmation, createCompileContext, hashPolicy } from "./index.js";
import { extractJsonObject } from "./anthropic.js";
import { FIXTURE_NOW, loadCompilerFixtures } from "../fixtures.js";
import { parsePolicy } from "../policy.js";

const fixtures = loadCompilerFixtures();
const compiler = new FixtureIntentCompiler(fixtures);
const context = createCompileContext({ now: FIXTURE_NOW });

function compile(name: string) {
  const fixture = fixtures.find((f) => f.name === name)!;
  expect(fixture, `fixture ${name}`).toBeDefined();
  return compiler.compile({ intent_text: fixture.intent_text, context });
}

describe("every recorded fixture", () => {
  it("is loaded", () => {
    expect(fixtures.map((f) => f.name).sort()).toEqual([
      "procurement-demo",
      "procurement-strict",
      "shopping",
      "travel",
      "underspecified",
    ]);
  });

  for (const fixture of fixtures) {
    it(`"${fixture.name}" produces a schema-valid result`, async () => {
      const result = await compiler.compile({
        intent_text: fixture.intent_text,
        context,
      });
      expect(result.status).not.toBe("failed");
      if (result.status === "compiled") {
        expect(parsePolicy(result.policy).ok).toBe(true);
      }
    });
  }
});

describe("Week 1 exit criteria: natural language in, validated policy out", () => {
  it("compiles the procurement demo instruction", async () => {
    const result = await compile("procurement-demo");
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;

    const { policy } = result;
    expect(policy.cumulative_limits).toEqual([
      { window: "month", max_amount: 50000 },
    ]);
    expect(policy.step_up.above_amount).toBe(15000);
    expect(policy.merchants.allow.map((m) => m.value).sort()).toEqual([
      "amazon.com",
      "staples.com",
    ]);
    expect(policy.merchants.unlisted).toBe("STEP_UP");
    expect(policy.categories.deny).toContain("gambling");
  });

  it("reads 'never more than $150' as a hard ceiling, not a step-up", async () => {
    const result = await compile("procurement-strict");
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.policy.per_transaction_max).toBe(15000);
    expect(result.policy.step_up.above_amount).toBeUndefined();
  });

  it("turns obligations into agent-attested constraints", async () => {
    const result = await compile("travel");
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;

    const keys = result.policy.constraints.map((c) => c.key).sort();
    expect(keys).toEqual(["destination_city", "refundable", "stops"]);
    expect(
      result.policy.constraints.every(
        (c) => c.verification === "agent_attested",
      ),
    ).toBe(true);
  });

  it("turns a qualitative instruction into numbers and admits it", async () => {
    const result = await compile("shopping");
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;

    expect(result.policy.per_transaction_max).toBe(90000);
    expect(result.policy.step_up.above_amount).toBe(125000);
    expect(
      result.assumptions.some((a) => a.toLowerCase().includes("ridiculous")),
    ).toBe(true);
  });

  it("asks rather than inventing a limit that was never stated", async () => {
    const result = await compile("underspecified");
    expect(result.status).toBe("needs_clarification");
    if (result.status !== "needs_clarification") return;
    expect(
      result.clarifications.some((c) => c.path === "/per_transaction_max"),
    ).toBe(true);
  });

  it("fails loudly on an instruction with no recorded fixture", async () => {
    const result = await compiler.compile({
      intent_text: "something nobody recorded",
      context,
    });
    expect(result.status).toBe("failed");
  });
});

describe("assumption surfacing", () => {
  it("every compiled fixture states its guesses", async () => {
    for (const fixture of fixtures) {
      const result = await compiler.compile({
        intent_text: fixture.intent_text,
        context,
      });
      if (result.status !== "compiled") continue;
      expect(
        result.assumptions.length,
        `${fixture.name} must surface assumptions`,
      ).toBeGreaterThan(0);
    }
  });

  it("builds a confirmation a human can actually read", async () => {
    const result = await compile("procurement-demo");
    if (result.status !== "compiled") throw new Error("expected compiled");
    const confirmation = buildConfirmation(result);

    expect(confirmation.policy_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(confirmation.terms.join(" ")).toContain("$500.00");
    expect(confirmation.terms.join(" ")).toContain("$150.00");
    expect(confirmation.terms.join(" ")).toContain("Amazon, Staples");
    expect(confirmation.assumptions.length).toBeGreaterThan(0);
  });
});

describe("policy hashing", () => {
  it("is stable across recompilation of the same fixture", async () => {
    const a = await compile("travel");
    const b = await compile("travel");
    if (a.status !== "compiled" || b.status !== "compiled") {
      throw new Error("expected compiled");
    }
    expect(hashPolicy(a.policy)).toBe(hashPolicy(b.policy));
  });

  it("differs between two different policies", async () => {
    const a = await compile("procurement-demo");
    const b = await compile("procurement-strict");
    if (a.status !== "compiled" || b.status !== "compiled") {
      throw new Error("expected compiled");
    }
    expect(hashPolicy(a.policy)).not.toBe(hashPolicy(b.policy));
  });
});

describe("model output extraction", () => {
  it("pulls JSON out of a fenced block", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("pulls JSON out of surrounding prose", () => {
    expect(extractJsonObject('Sure! {"a":1} Hope that helps.')).toBe('{"a":1}');
  });

  it("handles braces inside strings", () => {
    expect(extractJsonObject('{"a":"}{"}')).toBe('{"a":"}{"}');
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });
});
