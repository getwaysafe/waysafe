import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaticDirectory,
  toMinorUnits,
  Decision,
  FixtureIntentCompiler,
  loadCompilerFixtures,
} from "@agentpay/core";
import { buildServer, type ServerRepos } from "./server.js";
import { InMemoryAgentKeyRepository } from "./agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "./authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "./evidence/in-memory-repository.js";
import { InMemoryWebauthnRepository } from "./webauthn/in-memory-repository.js";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "./webauthn/test-support/virtual-authenticator.js";

let app: ReturnType<typeof buildServer>;
let repos: ServerRepos;
let orgKey: string;

const ORG = "org_test";
const WEBAUTHN_CONFIG = { rpId: "localhost", origin: "http://localhost:3000" };

beforeAll(async () => {
  repos = {
    authorization: new InMemoryAuthorizationRepository(
      createStaticDirectory([
        { domain: "staples.com", display_name: "Staples" },
        { domain: "amazon.com", display_name: "Amazon" },
        { domain: "bestbuy.com", display_name: "Best Buy" },
      ]),
    ),
    agentKeys: new InMemoryAgentKeyRepository(),
    evidence: new InMemoryEvidenceRepository(),
    webauthn: new InMemoryWebauthnRepository(),
  };

  app = buildServer({
    compiler: new FixtureIntentCompiler(loadCompilerFixtures()),
    logger: false,
    repos,
    webauthnConfig: WEBAUTHN_CONFIG,
  });
  await app.ready();

  const created = await repos.agentKeys.createKey({ organizationId: ORG, name: "org admin" }, new Date());
  orgKey = created.fullKey;
});

afterAll(async () => {
  await app.close();
});

function authed(headers: Record<string, string> = {}) {
  return { authorization: `Bearer ${orgKey}`, ...headers };
}

const PROCUREMENT_STRICT =
  "You may spend $500 per month on office supplies. Amazon and Staples are approved. Never spend more than $150 in a single transaction. Ask me before buying from another merchant.";

describe("GET /health", () => {
  it("reports the policy schema version, no credential required", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().policy_schema_version).toBe("agentpay.policy/v1");
  });
});

describe("auth gate (Phase 4)", () => {
  it("401s a credentialed route with no Authorization header", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "bot" } });
    expect(response.statusCode).toBe(401);
  });

  it("401s an unknown/forged credential", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: "Bearer ap_live_00000000forgedvalue" },
      payload: { name: "bot" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("401s a revoked credential", async () => {
    const created = await repos.agentKeys.createKey({ organizationId: ORG, name: "throwaway" }, new Date());
    await repos.agentKeys.revokeKey(created.id, ORG, new Date());

    const response = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${created.fullKey}` },
      payload: { name: "bot" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("does not require a credential for /v1/reason-codes", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/reason-codes" });
    expect(response.statusCode).toBe(200);
  });
});

describe("POST /v1/mandates/compile", () => {
  it("returns a validated policy, a hash, and a human confirmation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      headers: authed(),
      payload: { intent_text: PROCUREMENT_STRICT },
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
      headers: authed(),
      payload: { intent_text: "Let my shopping agent buy things from Amazon for me." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("needs_clarification");
  });

  it("rejects an empty instruction", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      headers: authed(),
      payload: { intent_text: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 422 when compilation cannot produce a valid policy", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      headers: authed(),
      payload: { intent_text: "nothing recorded for this one" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("does not create a mandate -- compiling is only a proposal", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      headers: authed(),
      payload: { intent_text: PROCUREMENT_STRICT },
    });
    expect(response.json().mandate_id).toBeUndefined();
  });
});

describe("POST /v1/policies/validate", () => {
  it("rejects a policy with a decimal amount", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/policies/validate",
      headers: authed(),
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
  it("publishes the reason-code dictionary", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/reason-codes" });
    const codes = response.json().reason_codes.map((r: { code: string }) => r.code);
    expect(codes).toContain("ALLOW_WITHIN_MANDATE");
    expect(codes).toContain("DENY_MERCHANT_UNRESOLVED");
    expect(codes).toContain("STEP_UP_AMOUNT_THRESHOLD");
  });
});

describe("agent and key lifecycle", () => {
  it("creates an agent, mints a key, and the key authenticates", async () => {
    const agentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: authed(),
      payload: { name: "test bot" },
    });
    expect(agentResponse.statusCode).toBe(201);
    const agentId = agentResponse.json().agent_id;

    const keyResponse = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/keys`,
      headers: authed(),
      payload: { name: "prod key" },
    });
    expect(keyResponse.statusCode).toBe(201);
    const apiKey = keyResponse.json().api_key;
    expect(apiKey).toMatch(/^ap_live_/);

    // The freshly minted key works as a credential for any route.
    const useResponse = await app.inject({
      method: "GET",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(useResponse.statusCode).toBe(200);
  });

  it("THE ATTACK: a revoked key stops authenticating", async () => {
    const agentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: authed(),
      payload: { name: "revoke-me bot" },
    });
    const agentId = agentResponse.json().agent_id;

    const keyResponse = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/keys`,
      headers: authed(),
      payload: { name: "key" },
    });
    const { key_id: keyId, api_key: apiKey } = keyResponse.json();

    const revokeResponse = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agentId}/keys/${keyId}`,
      headers: authed(),
    });
    expect(revokeResponse.statusCode).toBe(204);

    const useResponse = await app.inject({
      method: "GET",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(useResponse.statusCode).toBe(401);
  });
});

describe("the full PRD demo, over HTTP, no internal function calls", () => {
  it("compile -> create mandate -> authenticate -> four authorizations -> receipts -> evidence chain verifies", async () => {
    // 1. Compile.
    const compileResponse = await app.inject({
      method: "POST",
      url: "/v1/mandates/compile",
      headers: authed(),
      payload: { intent_text: PROCUREMENT_STRICT },
    });
    expect(compileResponse.statusCode).toBe(200);
    const { policy } = compileResponse.json();

    // 2. Register an agent so there's someone to bind the mandate to.
    const agentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: authed(),
      payload: { name: "procurement bot" },
    });
    expect(agentResponse.statusCode).toBe(201);
    const agentId = agentResponse.json().agent_id;

    // 3. Create the mandate from the compiled policy.
    const principalId = "prin_demo";
    const mandateResponse = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: authed(),
      payload: {
        principal_id: principalId,
        agent_ids: [agentId],
        policy,
        intent_text: PROCUREMENT_STRICT,
        compiler_name: "fixture",
      },
    });
    expect(mandateResponse.statusCode).toBe(201);
    const { mandate_id: mandateId } = mandateResponse.json();

    // 4. Authenticate: first call is a registration ceremony (no passkey on
    // file yet for this principal).
    const authenticator = createVirtualAuthenticator();
    const registerOptions = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/options`,
      headers: authed(),
    });
    expect(registerOptions.statusCode).toBe(200);
    expect(registerOptions.json().mode).toBe("register");
    const { challenge: registerChallenge, rp_id: rpId, origin } = registerOptions.json();

    const registrationResponse = buildRegistrationResponse({
      authenticator,
      rpId,
      origin,
      challenge: registerChallenge,
    });
    const registerVerify = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/verify`,
      headers: authed(),
      payload: { mode: "register", challenge: registerChallenge, response: registrationResponse },
    });
    expect(registerVerify.statusCode).toBe(200);
    expect(registerVerify.json().kind).toBe("registered");

    // 5. Second call to /options now returns an authentication ceremony --
    // challenge is base64url(policy_hash), D-20.
    const authOptions = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/options`,
      headers: authed(),
    });
    expect(authOptions.statusCode).toBe(200);
    expect(authOptions.json().mode).toBe("authenticate");
    const { challenge: authChallenge } = authOptions.json();

    const authenticationResponse = buildAuthenticationResponse({
      authenticator,
      rpId,
      origin,
      challenge: authChallenge,
    });
    const authVerify = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/verify`,
      headers: authed(),
      payload: { mode: "authenticate", challenge: authChallenge, response: authenticationResponse },
    });
    expect(authVerify.statusCode).toBe(200);
    expect(authVerify.json().kind).toBe("activated");

    // 6. Mint the agent's API key.
    const keyResponse = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/keys`,
      headers: authed(),
      payload: { name: "demo key" },
    });
    const agentApiKey = keyResponse.json().api_key;
    const agentHeaders = { authorization: `Bearer ${agentApiKey}` };

    function requestFor(amount: number, merchant: Record<string, string>, category?: string) {
      return {
        agent_id: agentId,
        principal_id: principalId,
        mandate_id: mandateId,
        action: {
          amount: toMinorUnits(amount, "USD"),
          currency: "USD",
          merchant,
          ...(category ? { category } : {}),
          attestations: {},
        },
        context: {},
      };
    }

    // 7a. Staples $83 -- ALLOW.
    const allow = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: agentHeaders,
      payload: requestFor(83, { domain: "staples.com" }, "office_supplies"),
    });
    expect(allow.statusCode).toBe(201);
    expect(allow.json().decision).toBe(Decision.ALLOW);

    // 7b. Staples $203 -- DENY (over the $150 hard ceiling).
    const deny1 = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: agentHeaders,
      payload: requestFor(203, { domain: "staples.com" }, "office_supplies"),
    });
    expect(deny1.statusCode).toBe(201);
    expect(deny1.json().decision).toBe(Decision.DENY);
    expect(deny1.json().reasons.map((r: { code: string }) => r.code)).toContain(
      "DENY_TRANSACTION_LIMIT_EXCEEDED",
    );

    // 7c. Best Buy $87 -- STEP_UP (verified merchant, not on the allowlist).
    const stepUp = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: agentHeaders,
      payload: requestFor(87, { domain: "bestbuy.com" }, "office_supplies"),
    });
    expect(stepUp.statusCode).toBe(201);
    expect(stepUp.json().decision).toBe(Decision.STEP_UP);

    // 7d. An unapproved gambling merchant, $50 -- DENY (category blocked).
    const deny2 = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: agentHeaders,
      payload: requestFor(
        50,
        { name: "Lucky Spin Casino", domain: "luckyspincasino.example" },
        "gambling",
      ),
    });
    expect(deny2.statusCode).toBe(201);
    expect(deny2.json().decision).toBe(Decision.DENY);
    expect(deny2.json().reasons.map((r: { code: string }) => r.code)).toContain("DENY_CATEGORY_BLOCKED");

    // 8. Fetch each receipt back by id and confirm it matches.
    for (const created of [allow, deny1, stepUp, deny2]) {
      const id = created.json().id;
      const receipt = await app.inject({
        method: "GET",
        url: `/v1/authorizations/${id}`,
        headers: authed(),
      });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json().decision).toBe(created.json().decision);
    }

    // 9. The evidence chain accumulated by everything above verifies clean.
    const verifyResponse = await app.inject({
      method: "GET",
      url: "/v1/evidence/verify",
      headers: authed(),
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json()).toEqual({ ok: true });

    const evidenceResponse = await app.inject({
      method: "GET",
      url: "/v1/evidence",
      headers: authed(),
    });
    const types = evidenceResponse.json().events.map((e: { type: string }) => e.type);
    expect(types).toContain("passkey.registered");
    expect(types).toContain("mandate.authenticated");
    expect(types).toContain("agent_key.verified");
  });
});
