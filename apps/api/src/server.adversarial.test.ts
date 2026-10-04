/**
 * Attacks from the independent adversarial review of 387958a.
 *
 * Every test in this file is written as the attack first, and is expected
 * to PASS against the reviewed commit -- that is the point: a test that
 * only ever passed after the fix proves nothing about whether the hole was
 * real. Each one names the non-negotiable it breaks.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaticDirectory,
  toMinorUnits,
  Decision,
  FixtureIntentCompiler,
  loadCompilerFixtures,
} from "@waysafe/core";
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { buildServer, type ServerRepos } from "./server.js";
import { InMemoryAgentKeyRepository } from "./agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "./authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "./evidence/in-memory-repository.js";
import { InMemoryPrincipalRepository } from "./principals/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "./instruments/in-memory-repository.js";
import { InMemoryWebauthnRepository } from "./webauthn/in-memory-repository.js";
import { InMemoryProviderEventRepository } from "./webhooks/in-memory-repository.js";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "./webauthn/test-support/virtual-authenticator.js";
import { FakeAdapter } from "./execution/test-support/fake-adapter.js";

let app: ReturnType<typeof buildServer>;
let repos: ServerRepos;
let orgKey: string;

const ORG = "org_adversarial";
const WEBAUTHN_CONFIG = { rpId: "localhost", origin: "http://localhost:3000" };

beforeAll(async () => {
  repos = {
    authorization: new InMemoryAuthorizationRepository(
      createStaticDirectory([{ domain: "staples.com", display_name: "Staples" }]),
    ),
    agentKeys: new InMemoryAgentKeyRepository(),
    evidence: new InMemoryEvidenceRepository(new FakeEd25519Signer()),
    webauthn: new InMemoryWebauthnRepository(),
    providerEvents: new InMemoryProviderEventRepository(),
    principals: new InMemoryPrincipalRepository(),
    instruments: new InMemoryInstrumentRepository(),
  };
  app = buildServer({
    compiler: new FixtureIntentCompiler(loadCompilerFixtures()),
    logger: false,
    repos,
    webauthnConfig: WEBAUTHN_CONFIG,
    adapters: { fake: new FakeAdapter({ providerFee: 0 }) },
  });
  await app.ready();
  const created = await repos.agentKeys.createKey({ organizationId: ORG, name: "org admin" }, new Date());
  orgKey = created.fullKey;
});

afterAll(async () => {
  await app.close();
});

/** An org-level credential: `agentId: null`. The intended caller for every
 * administrative route. */
function authed(headers: Record<string, string> = {}) {
  return { authorization: `Bearer ${orgKey}`, ...headers };
}

function asAgent(apiKey: string) {
  return { authorization: `Bearer ${apiKey}` };
}

/** Creates an agent + principal + ACTIVE mandate, and mints the agent's own
 * key. `policy` overrides are merged over a permissive base. */
async function setUpMandate(opts: { name: string; policy?: Record<string, unknown> } ) {
  const agentId = (
    await app.inject({ method: "POST", url: "/v1/agents", headers: authed(), payload: { name: opts.name } })
  ).json().agent_id as string;

  const principalId = (
    await app.inject({
      method: "POST",
      url: "/v1/principals",
      headers: authed(),
      payload: { display_name: `${opts.name} principal` },
    })
  ).json().principal_id as string;

  const mandateId = (
    await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: authed(),
      payload: {
        principal_id: principalId,
        agent_ids: [agentId],
        policy: {
          schema_version: "waysafe.policy/v1",
          summary: opts.name,
          currency: "USD",
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2099-01-01T00:00:00.000Z",
          ...(opts.policy ?? {}),
        },
        intent_text: opts.name,
        compiler_name: "manual",
      },
    })
  ).json().mandate_id as string;

  // Real WebAuthn ceremony against a virtual authenticator, same as every
  // other test in this package -- the mandate is unusable until it runs.
  const authenticator = createVirtualAuthenticator();
  const reg = await app.inject({
    method: "POST",
    url: `/v1/mandates/${mandateId}/authenticate/options`,
    headers: authed(),
  });
  const { challenge: regChallenge, rp_id: rpId, origin } = reg.json();
  await app.inject({
    method: "POST",
    url: `/v1/mandates/${mandateId}/authenticate/verify`,
    headers: authed(),
    payload: {
      mode: "register",
      challenge: regChallenge,
      response: buildRegistrationResponse({ authenticator, rpId, origin, challenge: regChallenge }),
    },
  });
  const auth = await app.inject({
    method: "POST",
    url: `/v1/mandates/${mandateId}/authenticate/options`,
    headers: authed(),
  });
  const { challenge: authChallenge } = auth.json();
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

  const apiKey = (
    await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/keys`,
      headers: authed(),
      payload: { name: `${opts.name} key` },
    })
  ).json().api_key as string;

  return { agentId, principalId, mandateId, apiKey };
}

// ===================================================================
// FINDING 1 -- agent keys can mint keys for other agents.
// Breaks non-negotiable #8 (and reopens D-59, which D-62 closed).
// ===================================================================

describe("FINDING 1: key minting is not administrative (breaks non-negotiable #8)", () => {
  it("THE ATTACK, end to end: a spending agent mints its own approver's key and approves its own step-up", async () => {
    // An approver mandate, and a spending mandate that names it.
    const approver = await setUpMandate({ name: "treasury approver" });
    const spender = await setUpMandate({
      name: "spending agent",
      policy: {
        step_up: { above_amount: toMinorUnits(10, "USD"), ttl_seconds: 900 },
        escalation: { approvers: [approver.mandateId] },
      },
    });

    // Step 1: the agent spends above its threshold and gets a STEP_UP it
    // is not allowed to resolve itself (D-62 rule 1).
    const stepUp = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: asAgent(spender.apiKey),
      payload: {
        agent_id: spender.agentId,
        principal_id: spender.principalId,
        mandate_id: spender.mandateId,
        action: {
          amount: toMinorUnits(50, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          attestations: {},
        },
        context: {},
      },
    });
    expect(stepUp.json().decision).toBe(Decision.STEP_UP);
    const stepUpId = stepUp.json().id as string;

    // Confirm the intended control is in place: resolving it with its own
    // credential is refused.
    const selfApproval = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${stepUpId}/step-up`,
      headers: asAgent(spender.apiKey),
      payload: { agent_id: spender.agentId, principal_id: spender.principalId },
    });
    expect(selfApproval.statusCode).toBe(403);
    expect(selfApproval.json().reasons[0].code).toBe("DENY_STEP_UP_SELF_APPROVAL");

    // Step 2: the agent reads its OWN mandate -- still allowed, it needs to
    // know its own limits -- and learns which mandate may approve for it.
    // escalation.approvers is part of its own policy, so this much is
    // unavoidable and fine.
    const ownMandate = await app.inject({
      method: "GET",
      url: `/v1/mandates/${spender.mandateId}`,
      headers: asAgent(spender.apiKey),
    });
    expect(ownMandate.statusCode).toBe(200);
    const approverMandateId = ownMandate.json().policy.escalation.approvers[0] as string;
    expect(approverMandateId).toBe(approver.mandateId);

    // Step 3 BLOCKED (D-64): reading a mandate it is not bound to now 404s,
    // so the agent cannot discover which agent to impersonate.
    const approverMandate = await app.inject({
      method: "GET",
      url: `/v1/mandates/${approverMandateId}`,
      headers: asAgent(spender.apiKey),
    });
    expect(approverMandate.statusCode).toBe(404);

    // Step 4 BLOCKED (D-64), the load-bearing fix: even handed the approver's
    // agent id out of band, minting a credential for it is administrative.
    const minted = await app.inject({
      method: "POST",
      url: `/v1/agents/${approver.agentId}/keys`,
      headers: asAgent(spender.apiKey),
      payload: { name: "minted by the spender" },
    });
    expect(minted.statusCode).toBe(403);
    expect(minted.json().error).toBe("org_credential_required");

    // Step 5: with no forged credential to act through, the step-up is still
    // pending and the agent's only route to it remains self-approval, which
    // D-62 already refuses. The chain is dead.
    const stillPending = await app.inject({
      method: "GET",
      url: `/v1/authorizations/${stepUpId}`,
      headers: authed(),
    });
    expect(stillPending.json().status).toBe("PENDING_STEP_UP");
  });

  it("an agent key mints a key for a DIFFERENT agent", async () => {
    const victim = await setUpMandate({ name: "victim agent" });
    const attacker = await setUpMandate({ name: "attacker agent" });

    const minted = await app.inject({
      method: "POST",
      url: `/v1/agents/${victim.agentId}/keys`,
      headers: asAgent(attacker.apiKey),
      payload: { name: "minted for the victim" },
    });
    expect(minted.statusCode).toBe(403);
    expect(minted.json().error).toBe("org_credential_required");
  });

  it("an agent key mints another key for ITSELF", async () => {
    const agent = await setUpMandate({ name: "self minting agent" });

    // Refused even for itself: key minting is administrative, full stop.
    // An agent that could mint its own second key could outlive a
    // revocation of its first.
    const minted = await app.inject({
      method: "POST",
      url: `/v1/agents/${agent.agentId}/keys`,
      headers: asAgent(agent.apiKey),
      payload: { name: "second key for myself" },
    });
    expect(minted.statusCode).toBe(403);
  });

  it("an org credential mints a key -- the legitimate path, which must keep working", async () => {
    const agent = await setUpMandate({ name: "legit mint target" });
    const minted = await app.inject({
      method: "POST",
      url: `/v1/agents/${agent.agentId}/keys`,
      headers: authed(),
      payload: { name: "minted by the org" },
    });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().api_key).toMatch(/^wsf_live_/);
  });
});

// ===================================================================
// FINDING 1, audit: every other credential/agent/membership-mutating
// route, checked for the same shape.
// ===================================================================

describe("FINDING 1 remediation audit: four more routes with the same shape (D-65)", () => {
  it("an agent key creates a new agent", async () => {
    const agent = await setUpMandate({ name: "agent creating agents" });
    const created = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: asAgent(agent.apiKey),
      payload: { name: "agent created by an agent" },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error).toBe("org_credential_required");
  });

  it("an agent key creates a new principal", async () => {
    const agent = await setUpMandate({ name: "agent creating principals" });
    const created = await app.inject({
      method: "POST",
      url: "/v1/principals",
      headers: asAgent(agent.apiKey),
      payload: { display_name: "principal created by an agent" },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error).toBe("org_credential_required");
  });

  it("an agent key revokes another agent's key -- denial of service against its own approver", async () => {
    const victim = await setUpMandate({ name: "revoke victim" });
    const attacker = await setUpMandate({ name: "revoke attacker" });

    const victimKey = await app.inject({
      method: "POST",
      url: `/v1/agents/${victim.agentId}/keys`,
      headers: authed(),
      payload: { name: "victim key to revoke" },
    });
    const victimKeyId = victimKey.json().key_id as string;

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${victim.agentId}/keys/${victimKeyId}`,
      headers: asAgent(attacker.apiKey),
    });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().error).toBe("org_credential_required");
  });

  it("an agent key creates a mandate -- granting itself fresh authority", async () => {
    const agent = await setUpMandate({ name: "mandate creating agent" });
    const principalId = (
      await app.inject({
        method: "POST",
        url: "/v1/principals",
        headers: authed(),
        payload: { display_name: "self granted principal" },
      })
    ).json().principal_id as string;

    const created = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: asAgent(agent.apiKey),
      payload: {
        principal_id: principalId,
        agent_ids: [agent.agentId],
        policy: {
          schema_version: "waysafe.policy/v1",
          summary: "authority this agent granted itself",
          currency: "USD",
          per_transaction_max: toMinorUnits(1_000_000, "USD"),
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        intent_text: "authority this agent granted itself",
        compiler_name: "manual",
      },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error).toBe("org_credential_required");
  });
});

// ===================================================================
// FINDING 1, structural guard (D-64): the allowlist cannot drift.
// ===================================================================

describe("FINDING 1 structural guard: every route is org-only unless explicitly agent-accessible", () => {
  /** The routes an agent credential is allowed to reach, each justified in
   * `AGENT_ACCESSIBLE_ROUTES` in server.ts. Duplicated here on purpose: if
   * someone widens the set in server.ts, this list must be updated too, and
   * updating it is where the argument for widening it gets made. */
  const EXPECTED_AGENT_ROUTES = new Set([
    "/v1/authorizations",
    "/v1/authorizations/:id",
    "/v1/authorizations/:id/execute",
    "/v1/authorizations/:id/step-up",
    "/v1/enforcement/x402",
    "/v1/mandates/:id",
  ]);

  /** Public routes take no credential at all, so the tier check never runs. */
  const PUBLIC = new Set([
    "/health",
    "/v1/reason-codes",
    "/v1/webhooks/stripe",
    "/v1/enforcement/stripe-issuing",
    "/v1/evidence/public-key",
  ]);

  it("enumerates every registered route, and each is agent-accessible by name or rejects an agent credential", async () => {
    // The real route table, collected by an `onRoute` hook in server.ts, so
    // a route added tomorrow appears here with no edit to this test.
    //
    // Deliberately NOT `printRoutes()`: that emits a tree of *relative*
    // fragments ("/compile", "/:id/keys"), so a guard built on it probes
    // URLs that do not exist and passes while proving nothing. Confirmed by
    // trying it first.
    const paths = [...app.registeredRoutes];
    expect(paths.length).toBeGreaterThan(20); // sanity: the table was really read
    expect(paths).toContain("/v1/agents/:id/keys"); // sanity: full paths, not fragments

    const agent = await setUpMandate({ name: "enumeration probe" });
    const unexpectedlyOpen: string[] = [];

    for (const path of paths) {
      if (PUBLIC.has(path) || EXPECTED_AGENT_ROUTES.has(path)) continue;

      const url = path.replace(":keyId", "key_probe").replace(":id", "probe");
      for (const method of ["GET", "POST", "DELETE"] as const) {
        const res = await app.inject({
          method,
          url,
          headers: asAgent(agent.apiKey),
          ...(method === "GET" ? {} : { payload: {} }),
        });
        // 404 with no body error = that method isn't registered here.
        if (res.statusCode === 404) continue;
        if (res.statusCode === 403 && res.json().error === "org_credential_required") continue;
        unexpectedlyOpen.push(`${method} ${path} -> ${res.statusCode}`);
      }
    }

    expect(unexpectedlyOpen).toEqual([]);
  });

  it("the agent-accessible set in server.ts matches this test's expectation exactly", async () => {
    // Proves the two lists agree: an agent credential must actually be
    // ACCEPTED (not 403) on every route named above, so a stale entry here
    // -- one server.ts no longer allows -- fails loudly rather than
    // quietly over-permitting in the test's own model.
    const agent = await setUpMandate({ name: "allowlist probe" });
    for (const path of EXPECTED_AGENT_ROUTES) {
      const url = path.replace(":id", "probe");
      const res = await app.inject({
        method: path === "/v1/authorizations/:id" || path === "/v1/mandates/:id" ? "GET" : "POST",
        url,
        headers: asAgent(agent.apiKey),
        payload: {},
      });
      expect(
        res.statusCode === 403 && res.json().error === "org_credential_required",
        `${path} should be agent-accessible but the tier gate rejected it`,
      ).toBe(false);
    }
  });
});
