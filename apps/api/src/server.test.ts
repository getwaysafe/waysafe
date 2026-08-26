import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaticDirectory,
  toMinorUnits,
  Decision,
  FixtureIntentCompiler,
  loadCompilerFixtures,
} from "@bles/core";
import { buildServer, type ServerRepos } from "./server.js";
import { InMemoryAgentKeyRepository } from "./agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "./authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "./evidence/in-memory-repository.js";
import { InMemoryWebauthnRepository } from "./webauthn/in-memory-repository.js";
import { InMemoryProviderEventRepository } from "./webhooks/in-memory-repository.js";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "./webauthn/test-support/virtual-authenticator.js";
import { FakeAdapter } from "./execution/test-support/fake-adapter.js";
import { X402Adapter } from "./payments/x402-adapter.js";
import Stripe from "stripe";

let app: ReturnType<typeof buildServer>;
let repos: ServerRepos;
let orgKey: string;

const ORG = "org_test";
const WEBAUTHN_CONFIG = { rpId: "localhost", origin: "http://localhost:3000" };
const WEBHOOK_SECRET = "whsec_test_secret_for_server_tests";
const fakeAdapter = new FakeAdapter({ providerFee: 199 });

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
    providerEvents: new InMemoryProviderEventRepository(),
  };

  app = buildServer({
    compiler: new FixtureIntentCompiler(loadCompilerFixtures()),
    logger: false,
    repos,
    webauthnConfig: WEBAUTHN_CONFIG,
    adapters: { x402: new X402Adapter(), fake: fakeAdapter },
    stripeWebhookSecret: WEBHOOK_SECRET,
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
    expect(response.json().policy_schema_version).toBe("bles.policy/v1");
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
      headers: { authorization: "Bearer bls_live_00000000forgedvalue" },
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
    expect(body.policy.schema_version).toBe("bles.policy/v1");
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
        schema_version: "bles.policy/v1",
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
    expect(apiKey).toMatch(/^bls_live_/);

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

describe("payment execution and step-up completion (Week 4)", () => {
  async function createActiveMandate(overrides: Record<string, unknown> = {}) {
    const agentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: authed(),
      payload: { name: "execution test bot" },
    });
    const agentId = agentResponse.json().agent_id;
    const principalId = `prin_exec_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const mandateResponse = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: authed(),
      payload: {
        principal_id: principalId,
        agent_ids: [agentId],
        policy: {
          schema_version: "bles.policy/v1",
          summary: "test",
          currency: "USD",
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2026-09-23T12:00:00.000Z",
          ...overrides,
        },
        intent_text: "test policy for execution",
        compiler_name: "manual",
      },
    });
    const mandateId = mandateResponse.json().mandate_id;

    const authenticator = createVirtualAuthenticator();
    const registerOptions = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: registerChallenge, rp_id: rpId, origin } = registerOptions.json();
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge: registerChallenge,
        response: buildRegistrationResponse({ authenticator, rpId, origin, challenge: registerChallenge }),
      },
    });

    const authOptions = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: authChallenge } = authOptions.json();
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "authenticate",
        challenge: authChallenge,
        response: buildAuthenticationResponse({ authenticator, rpId, origin, challenge: authChallenge }),
      },
    });

    const keyResponse = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/keys`,
      headers: authed(),
      payload: { name: "exec key" },
    });
    const agentApiKey = keyResponse.json().api_key;

    return { agentId, principalId, mandateId, agentApiKey };
  }

  function authorizeRequest(mandateId: string, agentId: string, principalId: string, amount: number) {
    return {
      agent_id: agentId,
      principal_id: principalId,
      mandate_id: mandateId,
      action: {
        amount: toMinorUnits(amount, "USD"),
        currency: "USD",
        // A directory-verified domain (D-3): unlisted + VERIFIED under
        // unlisted:"ALLOW" is a genuine ALLOW. A name-only assertion would
        // cap at STEP_UP regardless -- the ceiling these tests aren't
        // trying to exercise.
        merchant: { domain: "staples.com" },
        attestations: {},
      },
      context: {},
    };
  }

  it("executes an ALLOWed authorization against the fake rail: status EXECUTED, receipt shows the rail and fee", async () => {
    const { agentId, principalId, mandateId, agentApiKey } = await createActiveMandate();
    const decided = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: authorizeRequest(mandateId, agentId, principalId, 42),
    });
    expect(decided.json().decision).toBe(Decision.ALLOW);
    const id = decided.json().id;

    const executed = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${id}/execute`,
      headers: authed(),
      payload: { rail: "fake", payment_method_ref: "pm_test" },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe("EXECUTED");

    const receipt = await app.inject({ method: "GET", url: `/v1/authorizations/${id}`, headers: authed() });
    expect(receipt.json().status).toBe("EXECUTED");
  });

  it("THE ATTACK: a DENIED authorization cannot be executed -- 409, adapter never called", async () => {
    const { agentId, principalId, mandateId, agentApiKey } = await createActiveMandate({
      categories: { allow: [], deny: ["gambling"], deny_mcc: [], unlisted: "ALLOW" },
    });
    const decided = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: {
        agent_id: agentId,
        principal_id: principalId,
        mandate_id: mandateId,
        action: {
          amount: toMinorUnits(50, "USD"),
          currency: "USD",
          merchant: { name: "Casino" },
          category: "gambling",
          attestations: {},
        },
        context: {},
      },
    });
    expect(decided.json().decision).toBe(Decision.DENY);
    const id = decided.json().id;
    const callsBefore = fakeAdapter.calls.length;

    const executed = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${id}/execute`,
      headers: authed(),
      payload: { rail: "fake", payment_method_ref: "pm_test" },
    });

    expect(executed.statusCode).toBe(409);
    expect(fakeAdapter.calls.length).toBe(callsBefore);
  });

  it("THE ATTACK: a double-execute attempt is rejected on the second call", async () => {
    const { agentId, principalId, mandateId, agentApiKey } = await createActiveMandate();
    const decided = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: authorizeRequest(mandateId, agentId, principalId, 10),
    });
    const id = decided.json().id;

    const first = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${id}/execute`,
      headers: authed(),
      payload: { rail: "fake", payment_method_ref: "pm_test" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${id}/execute`,
      headers: authed(),
      payload: { rail: "fake", payment_method_ref: "pm_test" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("step-up: approve makes it executable; decline releases the reservation and blocks execution", async () => {
    const { agentId, principalId, mandateId, agentApiKey } = await createActiveMandate({
      step_up: { above_amount: toMinorUnits(10, "USD"), ttl_seconds: 900 },
    });

    const stepUpDecision = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: authorizeRequest(mandateId, agentId, principalId, 20),
    });
    expect(stepUpDecision.json().decision).toBe(Decision.STEP_UP);
    const stepUpId = stepUpDecision.json().id;

    const declined = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${stepUpId}/step-up`,
      headers: authed(),
      payload: { outcome: "declined" },
    });
    expect(declined.json().status).toBe("STEP_UP_DECLINED");

    const rejectedExecute = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${stepUpId}/execute`,
      headers: authed(),
      payload: { rail: "fake", payment_method_ref: "pm_test" },
    });
    expect(rejectedExecute.statusCode).toBe(409);

    const secondDecision = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: authorizeRequest(mandateId, agentId, principalId, 25),
    });
    const secondId = secondDecision.json().id;

    const approved = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${secondId}/step-up`,
      headers: authed(),
      payload: { outcome: "approved" },
    });
    expect(approved.json().status).toBe("STEP_UP_APPROVED");

    const executed = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${secondId}/execute`,
      headers: authed(),
      payload: { rail: "fake", payment_method_ref: "pm_test" },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe("EXECUTED");
  });

  it("THE ATTACK: a pending step-up past its TTL cannot be executed, even without an explicit decline", async () => {
    const { agentId, principalId, mandateId, agentApiKey } = await createActiveMandate({
      step_up: { above_amount: toMinorUnits(10, "USD"), ttl_seconds: 1 },
    });
    const decided = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: authorizeRequest(mandateId, agentId, principalId, 20),
    });
    expect(decided.json().decision).toBe(Decision.STEP_UP);
    const id = decided.json().id;

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const receipt = await app.inject({ method: "GET", url: `/v1/authorizations/${id}`, headers: authed() });
    expect(receipt.json().status).toBe("EXPIRED");

    const executed = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${id}/execute`,
      headers: authed(),
      payload: { rail: "fake", payment_method_ref: "pm_test" },
    });
    expect(executed.statusCode).toBe(409);
  });
});

describe("POST /v1/webhooks/stripe", () => {
  const stripeForSigning = new Stripe("sk_test_unused_for_signing");

  async function createExecutedAuthorization() {
    const agentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: authed(),
      payload: { name: "webhook test bot" },
    });
    const agentId = agentResponse.json().agent_id;
    const principalId = `prin_webhook_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const mandateResponse = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: authed(),
      payload: {
        principal_id: principalId,
        agent_ids: [agentId],
        policy: {
          schema_version: "bles.policy/v1",
          summary: "test",
          currency: "USD",
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2026-09-23T12:00:00.000Z",
        },
        intent_text: "test policy for webhook",
        compiler_name: "manual",
      },
    });
    const mandateId = mandateResponse.json().mandate_id;

    const authenticator = createVirtualAuthenticator();
    const registerOptions = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: registerChallenge, rp_id: rpId, origin } = registerOptions.json();
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge: registerChallenge,
        response: buildRegistrationResponse({ authenticator, rpId, origin, challenge: registerChallenge }),
      },
    });
    const authOptions = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: authChallenge } = authOptions.json();
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "authenticate",
        challenge: authChallenge,
        response: buildAuthenticationResponse({ authenticator, rpId, origin, challenge: authChallenge }),
      },
    });

    const keyResponse = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/keys`,
      headers: authed(),
      payload: { name: "webhook exec key" },
    });
    const agentApiKey = keyResponse.json().api_key;

    const decided = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: {
        agent_id: agentId,
        principal_id: principalId,
        mandate_id: mandateId,
        action: {
          amount: toMinorUnits(60, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          attestations: {},
        },
        context: {},
      },
    });
    const authorizationId = decided.json().id;

    await app.inject({
      method: "POST",
      url: `/v1/authorizations/${authorizationId}/execute`,
      headers: authed(),
      payload: { rail: "fake", payment_method_ref: "pm_test" },
    });

    return authorizationId;
  }

  function refundPayload(eventId: string, authorizationId: string, amountRefunded: number): string {
    return JSON.stringify({
      id: eventId,
      object: "event",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_test_webhook",
          object: "charge",
          amount_refunded: amountRefunded,
          metadata: { bles_authorization_id: authorizationId },
        },
      },
    });
  }

  it("applies a genuinely signed refund event, and redelivery is idempotent -- one ledger effect", async () => {
    const authorizationId = await createExecutedAuthorization();
    const payload = refundPayload(`evt_${Date.now()}`, authorizationId, toMinorUnits(60, "USD"));
    const signature = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const first = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().kind).toBe("applied");

    const second = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().kind).toBe("duplicate");

    const events = await repos.evidence.listForOrganization(ORG);
    expect(events.filter((e) => e.type === "refund.applied" && e.subject_id === authorizationId)).toHaveLength(1);
  });

  it("THE ATTACK: a forged signature is rejected outright", async () => {
    const payload = refundPayload(`evt_forged_${Date.now()}`, "auth_does_not_matter", 1000);

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=0000000000forgedvalue" },
      payload,
    });

    expect(response.statusCode).toBe(400);
  });

  it("does not require a Bearer credential -- Stripe authenticates via signature, not a bearer token", async () => {
    const authorizationId = await createExecutedAuthorization();
    const payload = refundPayload(`evt_nocred_${Date.now()}`, authorizationId, toMinorUnits(60, "USD"));
    const signature = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("dashboard reads (Week 5)", () => {
  async function createMandateFor(organizationId: string, orgApiKey: string) {
    const agentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${orgApiKey}` },
      payload: { name: "dashboard test bot" },
    });
    const agentId = agentResponse.json().agent_id;
    const principalId = `prin_dash_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const mandateResponse = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: { authorization: `Bearer ${orgApiKey}` },
      payload: {
        principal_id: principalId,
        agent_ids: [agentId],
        policy: {
          schema_version: "bles.policy/v1",
          summary: `dashboard test policy for ${organizationId}`,
          currency: "USD",
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2026-09-23T12:00:00.000Z",
        },
        intent_text: "dashboard read test",
        compiler_name: "manual",
      },
    });
    return { agentId, principalId, mandateId: mandateResponse.json().mandate_id as string };
  }

  it("lists mandates for the caller's organization, most-recent-first, with a summary and no raw policy", async () => {
    const { mandateId } = await createMandateFor(ORG, orgKey);

    const response = await app.inject({ method: "GET", url: "/v1/mandates", headers: authed() });
    expect(response.statusCode).toBe(200);
    const mandates = response.json().mandates as Array<Record<string, unknown>>;
    const found = mandates.find((m) => m.mandate_id === mandateId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("PENDING_AUTHENTICATION");
    expect(typeof found!.summary).toBe("string");
    expect(found!.policy).toBeUndefined();
    // Most-recent-first: the mandate just created should not be after an older one.
    expect(mandates[0]!.created_at as string >= (mandates[mandates.length - 1]!.created_at as string)).toBe(true);
  });

  it("returns full mandate detail -- policy, intent text, assumptions, bound agents", async () => {
    const { mandateId, agentId } = await createMandateFor(ORG, orgKey);

    const response = await app.inject({ method: "GET", url: `/v1/mandates/${mandateId}`, headers: authed() });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mandate_id).toBe(mandateId);
    expect(body.intent_text).toBe("dashboard read test");
    expect(body.agent_ids).toEqual([agentId]);
    expect(body.policy.schema_version).toBe("bles.policy/v1");
    expect(body.authenticated_at).toBeNull();
  });

  it("404s a mandate detail lookup for an id that doesn't exist", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/mandates/mandate_does_not_exist",
      headers: authed(),
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists agents for the caller's organization", async () => {
    const { agentId } = await createMandateFor(ORG, orgKey);

    const response = await app.inject({ method: "GET", url: "/v1/agents", headers: authed() });
    expect(response.statusCode).toBe(200);
    const agents = response.json().agents as Array<Record<string, unknown>>;
    expect(agents.some((a) => a.agent_id === agentId && a.name === "dashboard test bot")).toBe(true);
  });

  it("lists keys for the caller's organization, prefix only -- never the full key", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/keys", headers: authed() });
    expect(response.statusCode).toBe(200);
    const keys = response.json().keys as Array<Record<string, unknown>>;
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.prefix).toBeDefined();
      expect(JSON.stringify(key)).not.toContain(orgKey);
    }
  });

  it("lists authorizations for the caller's organization, most-recent-first", async () => {
    const { agentId, principalId, mandateId } = await createMandateFor(ORG, orgKey);
    const authenticator = createVirtualAuthenticator();
    const registerOptions = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: registerChallenge, rp_id: rpId, origin } = registerOptions.json();
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge: registerChallenge,
        response: buildRegistrationResponse({ authenticator, rpId, origin, challenge: registerChallenge }),
      },
    });
    const authOptions = await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: authChallenge } = authOptions.json();
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "authenticate",
        challenge: authChallenge,
        response: buildAuthenticationResponse({ authenticator, rpId, origin, challenge: authChallenge }),
      },
    });
    const keyResponse = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/keys`,
      headers: authed(),
      payload: { name: "dashboard read key" },
    });
    const agentApiKey = keyResponse.json().api_key;

    const decided = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: { authorization: `Bearer ${agentApiKey}` },
      payload: {
        agent_id: agentId,
        principal_id: principalId,
        mandate_id: mandateId,
        action: {
          amount: toMinorUnits(5, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          attestations: {},
        },
        context: {},
      },
    });
    const authorizationId = decided.json().id;

    const response = await app.inject({ method: "GET", url: "/v1/authorizations", headers: authed() });
    expect(response.statusCode).toBe(200);
    const authorizations = response.json().authorizations as Array<Record<string, unknown>>;
    expect(authorizations.some((a) => a.id === authorizationId)).toBe(true);
    expect(
      (authorizations[0]!.created_at as string) >=
        (authorizations[authorizations.length - 1]!.created_at as string),
    ).toBe(true);
  });

  describe("THE ATTACK: cross-organization isolation", () => {
    let otherOrgKey: string;

    beforeAll(async () => {
      const created = await repos.agentKeys.createKey(
        { organizationId: "org_other_dashboard", name: "other org admin" },
        new Date(),
      );
      otherOrgKey = created.fullKey;
    });

    it("a mandate belonging to another organization does not appear in this organization's list", async () => {
      const { mandateId } = await createMandateFor("org_other_dashboard", otherOrgKey);

      const response = await app.inject({ method: "GET", url: "/v1/mandates", headers: authed() });
      const mandates = response.json().mandates as Array<Record<string, unknown>>;
      expect(mandates.some((m) => m.mandate_id === mandateId)).toBe(false);
    });

    it("mandate detail 404s when requested by a different organization's credential", async () => {
      const { mandateId } = await createMandateFor("org_other_dashboard", otherOrgKey);

      const response = await app.inject({ method: "GET", url: `/v1/mandates/${mandateId}`, headers: authed() });
      expect(response.statusCode).toBe(404);
    });

    it("agents from another organization do not appear in this organization's agent list", async () => {
      const { agentId } = await createMandateFor("org_other_dashboard", otherOrgKey);

      const response = await app.inject({ method: "GET", url: "/v1/agents", headers: authed() });
      const agents = response.json().agents as Array<Record<string, unknown>>;
      expect(agents.some((a) => a.agent_id === agentId)).toBe(false);
    });

    it("keys from another organization do not appear in this organization's key list", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/keys", headers: authed() });
      const keys = response.json().keys as Array<Record<string, unknown>>;
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key.organization_id).toBe(ORG);
      }
    });
  });
});
