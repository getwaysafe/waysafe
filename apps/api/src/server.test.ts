import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureIntentCompiler, loadCompilerFixtures } from "@agentpay/core";
import { buildServer } from "./server.js";

let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  app = buildServer({
    compiler: new FixtureIntentCompiler(loadCompilerFixtures()),
    logger: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const PROCUREMENT =
  "You may spend $500 per month on office supplies. Amazon and Staples are approved. Ask me before spending more than $150 in a single transaction. Ask me before buying from another merchant.";

describe("GET /health", () => {
  it("reports the policy schema version", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().policy_schema_version).toBe("agentpay.policy/v1");
  });
});

describe("POST /v1/mandates/compile", () => {
  it("returns a validated policy, a hash, and a human confirmation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      payload: { intent_text: PROCUREMENT },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("compiled");
    expect(body.policy.schema_version).toBe("agentpay.policy/v1");
    expect(body.policy_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.confirmation.terms.length).toBeGreaterThan(3);
    expect(body.confirmation.assumptions.length).toBeGreaterThan(0);
  });

  it("returns 200 with questions when the instruction is underspecified", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      payload: { intent_text: "Let my shopping agent buy things from Amazon for me." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("needs_clarification");
  });

  it("rejects an empty instruction", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      payload: { intent_text: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 422 when compilation cannot produce a valid policy", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      payload: { intent_text: "nothing recorded for this one" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("does not create a mandate — compiling is only a proposal", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      payload: { intent_text: PROCUREMENT },
    });
    expect(response.json().mandate_id).toBeUndefined();
  });
});

describe("POST /v1/policies/validate", () => {
  it("rejects a policy with a decimal amount", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/policies/validate",
      payload: {
        schema_version: "agentpay.policy/v1",
        summary: "bad",
        currency: "USD",
        per_transaction_max: 150.5,
        merchants: { allow: [], deny: [], unlisted: "DENY" },
        categories: { allow: [], deny: [], unlisted: "DENY" },
        step_up: {},
        accounting: {},
        expires_at: "2026-09-23T12:00:00.000Z",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().ok).toBe(false);
  });
});

describe("GET /v1/reason-codes", () => {
  it("publishes the dictionary Week 2 will emit", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/reason-codes" });
    const codes = response.json().reason_codes.map((r: { code: string }) => r.code);
    expect(codes).toContain("ALLOW_WITHIN_MANDATE");
    expect(codes).toContain("DENY_MERCHANT_UNRESOLVED");
    expect(codes).toContain("STEP_UP_AMOUNT_THRESHOLD");
  });
});
