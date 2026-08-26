import { describe, expect, it } from "vitest";
import {
  canonicalizePolicy,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  validatePolicyCoherence,
  type Policy,
} from "./policy.js";
import { toMinorUnits } from "./money.js";

function basePolicy(overrides: Partial<Policy> = {}): unknown {
  return {
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "Test policy",
    currency: "USD",
    per_transaction_max: 15000,
    cumulative_limits: [{ window: "month", max_amount: 50000 }],
    merchants: {
      allow: [{ scheme: "domain", value: "staples.com", label: "Staples" }],
      deny: [],
      unlisted: "STEP_UP",
    },
    categories: {
      allow: ["office_supplies"],
      deny: ["gambling"],
      unlisted: "STEP_UP",
    },
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-09-23T12:00:00.000Z",
    ...overrides,
  };
}

describe("policy schema", () => {
  it("accepts a well-formed policy and applies documented defaults", () => {
    const result = parsePolicy(basePolicy());
    expect(result.ok).toBe(true);
    const policy = result.policy!;
    expect(policy.accounting.timezone).toBe("America/New_York");
    expect(policy.accounting.basis).toBe("authorization");
    expect(policy.accounting.reserve_on_step_up).toBe(true);
    expect(policy.accounting.refunds_credit_budget).toBe(true);
    expect(policy.step_up.ttl_seconds).toBe(900);
    expect(policy.constraints).toEqual([]);
  });

  it("rejects decimal amounts, because money is integer minor units", () => {
    const result = parsePolicy(basePolicy({ per_transaction_max: 150.5 } as never));
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/integer minor units/);
  });

  it("rejects a negative limit", () => {
    const result = parsePolicy(basePolicy({ per_transaction_max: -1 } as never));
    expect(result.ok).toBe(false);
  });

  it("requires an explicit disposition for unlisted merchants", () => {
    const input = basePolicy() as Record<string, Record<string, unknown>>;
    delete input.merchants!.unlisted;
    const result = parsePolicy(input);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path.includes("unlisted"))).toBe(true);
  });

  it("requires an expiry", () => {
    const input = basePolicy() as Record<string, unknown>;
    delete input.expires_at;
    expect(parsePolicy(input).ok).toBe(false);
  });

  it("rejects an unknown schema version", () => {
    expect(
      parsePolicy(basePolicy({ schema_version: "bles.policy/v2" } as never)).ok,
    ).toBe(false);
  });
});

describe("coherence checks", () => {
  it("flags a step-up threshold that can never fire", () => {
    const policy = parsePolicy(
      basePolicy({ step_up: { above_amount: 20000, ttl_seconds: 900 } } as never),
    ).policy!;
    const issues = validatePolicyCoherence(policy);
    expect(
      issues.some(
        (i) => i.path === "/step_up/above_amount" && i.severity === "warning",
      ),
    ).toBe(true);
  });

  it("errors when a merchant is both allowed and denied", () => {
    const result = parsePolicy(
      basePolicy({
        merchants: {
          allow: [{ scheme: "domain", value: "staples.com" }],
          deny: [{ scheme: "domain", value: "staples.com" }],
          unlisted: "DENY",
        },
      } as never),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("errors when an MCC is used as a merchant allowlist entry", () => {
    const result = parsePolicy(
      basePolicy({
        merchants: {
          allow: [{ scheme: "mcc", value: "5943" }],
          deny: [],
          unlisted: "DENY",
        },
      } as never),
    );
    expect(result.ok).toBe(false);
  });

  it("warns that a name-only allowlist entry can never be verified", () => {
    const result = parsePolicy(
      basePolicy({
        merchants: {
          allow: [{ scheme: "name", value: "Staples" }],
          deny: [],
          unlisted: "DENY",
        },
      } as never),
    );
    expect(
      result.issues.some((i) => i.message.includes("can never be verified")),
    ).toBe(true);
  });

  it("errors on duplicate cumulative windows", () => {
    const result = parsePolicy(
      basePolicy({
        cumulative_limits: [
          { window: "month", max_amount: 50000 },
          { window: "month", max_amount: 60000 },
        ],
      } as never),
    );
    expect(result.ok).toBe(false);
  });

  it("errors when a category is both allowed and denied", () => {
    const result = parsePolicy(
      basePolicy({
        categories: {
          allow: ["office_supplies"],
          deny: ["office_supplies"],
          unlisted: "DENY",
        },
      } as never),
    );
    expect(result.ok).toBe(false);
  });
});

describe("canonicalization", () => {
  it("produces identical bytes regardless of key order", () => {
    const a = parsePolicy(basePolicy()).policy!;
    const reordered = JSON.parse(
      JSON.stringify({
        expires_at: a.expires_at,
        summary: a.summary,
        currency: a.currency,
        schema_version: a.schema_version,
        per_transaction_max: a.per_transaction_max,
        cumulative_limits: a.cumulative_limits,
        merchants: a.merchants,
        categories: a.categories,
        step_up: a.step_up,
        accounting: a.accounting,
        constraints: a.constraints,
        compiler_notes: a.compiler_notes,
      }),
    );
    const b = parsePolicy(reordered).policy!;
    expect(canonicalizePolicy(a)).toBe(canonicalizePolicy(b));
  });

  it("changes when a limit changes", () => {
    const a = parsePolicy(basePolicy()).policy!;
    const b = parsePolicy(basePolicy({ per_transaction_max: 15001 })).policy!;
    expect(canonicalizePolicy(a)).not.toBe(canonicalizePolicy(b));
  });
});

describe("money", () => {
  it("converts dollars to minor units without float drift", () => {
    expect(toMinorUnits(500, "USD")).toBe(50000);
    expect(toMinorUnits(150, "USD")).toBe(15000);
    expect(toMinorUnits(6.87, "USD")).toBe(687);
    expect(toMinorUnits(1800, "USD")).toBe(180000);
    expect(toMinorUnits(0.1 + 0.2, "USD")).toBe(30);
  });
});
