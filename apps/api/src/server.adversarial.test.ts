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

/** A principal with a real, legitimately enrolled passkey, and the
 * authenticator that holds it. */
async function victimWithKey(label: string) {
  const authenticator = createVirtualAuthenticator();
  const m = await setUpMandateWith(label, authenticator);
  return { ...m, authenticator };
}

/** Creates a mandate for an EXISTING principal and leaves it
 * PENDING_AUTHENTICATION -- no ceremony run. Used to get a mandate that an
 * authentication challenge can be requested for. */
async function createMandateFor(
  principalId: string,
  label: string,
  policy: Record<string, unknown> = {},
) {
  const agentId = (
    await app.inject({ method: "POST", url: "/v1/agents", headers: authed(), payload: { name: label } })
  ).json().agent_id as string;

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
          summary: label,
          currency: "USD",
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2099-01-01T00:00:00.000Z",
          ...policy,
        },
        intent_text: label,
        compiler_name: "manual",
      },
    })
  ).json().mandate_id as string;

  return { agentId, mandateId };
}

/** Same as `setUpMandate`, but the caller supplies the authenticator -- so a
 * test can keep hold of the *legitimate* principal's key and contrast it
 * with an attacker-controlled one. */
async function setUpMandateWith(label: string, authenticator: ReturnType<typeof createVirtualAuthenticator>) {
  const principalId = (
    await app.inject({
      method: "POST",
      url: "/v1/principals",
      headers: authed(),
      payload: { display_name: `${label} principal` },
    })
  ).json().principal_id as string;

  const { agentId, mandateId } = await createMandateFor(principalId, label);

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

  return { principalId, agentId, mandateId, rpId, origin };
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

// ===================================================================
// FINDING 2 -- an authentication challenge enrolls an attacker's passkey.
// Breaks docs/THREAT-MODEL.md §2.5: the principal's passkey is supposed to
// be the root of all delegated authority and the one thing an API caller
// cannot obtain.
//
// Premise, as the review stated it: the attacker holds an ORG credential --
// a compromised dashboard session (§2.3 notes the dashboard holds exactly
// one), a malicious insider, or a leaked admin key. It does NOT hold the
// principal's passkey, and must not be able to mint one.
// ===================================================================

describe("FINDING 2: an auth challenge enrolls an attacker's passkey (breaks §2.5)", () => {
  /** A principal with a real, legitimately-enrolled passkey, plus a mandate
   * it has authenticated. This is the victim: an established principal. */
  async function victimPrincipalWithPasskey(label: string) {
    const legitimate = createVirtualAuthenticator();
    const m = await setUpMandateWith(label, legitimate);
    return { ...m, legitimate };
  }

  it("(a) THE ATTACK: an authentication challenge is answered with a registration response, enrolling an attacker's key", async () => {
    const victim = await victimPrincipalWithPasskey("finding2-a");

    // A second mandate for the same principal, so there is something to
    // request an authentication challenge for.
    const second = await createMandateFor(victim.principalId, "finding2-a second");

    // The principal already has a credential, so /options issues an
    // AUTHENTICATION challenge -- the server says so itself.
    const options = await app.inject({
      method: "POST",
      url: `/v1/mandates/${second.mandateId}/authenticate/options`,
      headers: authed(),
    });
    expect(options.statusCode).toBe(200);
    expect(options.json().mode).toBe("authenticate");
    const authChallenge = options.json().challenge as string;
    const { rp_id: rpId, origin } = options.json();

    // The attacker's own authenticator -- a key only they control.
    const attacker = createVirtualAuthenticator();

    // Answer the AUTHENTICATION challenge with a REGISTRATION response.
    // The stored purpose says AUTHENTICATION; nothing checks it, and the
    // caller's own `mode` field is what gets believed.
    const enrolled = await app.inject({
      method: "POST",
      url: `/v1/mandates/${second.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge: authChallenge,
        response: buildRegistrationResponse({
          authenticator: attacker,
          rpId,
          origin,
          challenge: authChallenge,
        }),
      },
    });

    // D-66: rejected at the purpose check. The stored purpose is
    // AUTHENTICATION; the caller's `mode: "register"` claim no longer
    // decides anything.
    expect(enrolled.statusCode).toBe(400);
    expect(enrolled.json().error).toBe("challenge_purpose_mismatch");
    expect(enrolled.json().actual_purpose).toBe("AUTHENTICATION");
    expect(enrolled.json().expected_purpose).toBe("REGISTRATION");

    // The only passkey on this principal is still the legitimate one.
    const attackerCredId = buildRegistrationResponse({
      authenticator: attacker,
      rpId,
      origin,
      challenge: authChallenge,
    }).id;
    expect(await repos.webauthn.getCredentialByCredentialId(attackerCredId)).toBeNull();
  });

  it("(b) the attacker's enrolled passkey then authenticates mandates as that principal", async () => {
    const victim = await victimPrincipalWithPasskey("finding2-b");
    const bridge = await createMandateFor(victim.principalId, "finding2-b bridge");

    // Enroll the attacker's key off an authentication challenge, as in (a).
    const attacker = createVirtualAuthenticator();
    const opts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${bridge.mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: c1, rp_id: rpId, origin } = opts.json();
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${bridge.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge: c1,
        response: buildRegistrationResponse({ authenticator: attacker, rpId, origin, challenge: c1 }),
      },
    });

    // Now a fresh mandate, with limits the real principal never agreed to,
    // activated entirely by the attacker's key.
    const target = await createMandateFor(victim.principalId, "finding2-b target", {
      per_transaction_max: toMinorUnits(999_999, "USD"),
    });
    const targetOpts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${target.mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: c2 } = targetOpts.json();
    const activated = await app.inject({
      method: "POST",
      url: `/v1/mandates/${target.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "authenticate",
        challenge: c2,
        response: buildAuthenticationResponse({ authenticator: attacker, rpId, origin, challenge: c2 }),
      },
    });

    // D-66: the attacker never got a credential enrolled, so there is no
    // key to authenticate with -- the assertion matches no credential on
    // this principal.
    expect(activated.statusCode).toBe(401);
    expect(activated.json().kind).toBe("rejected");

    // The high-limit mandate is still unauthenticated.
    const detail = await app.inject({
      method: "GET",
      url: `/v1/mandates/${target.mandateId}`,
      headers: authed(),
    });
    expect(detail.json().status).toBe("PENDING_AUTHENTICATION");
    expect(detail.json().authenticated_at).toBeNull();
  });

  it("(c) a second passkey is enrolled with no prior authentication by the existing credential", async () => {
    const victim = await victimPrincipalWithPasskey("finding2-c");
    expect(await repos.webauthn.hasCredentialForPrincipal(victim.principalId)).toBe(true);

    const bridge = await createMandateFor(victim.principalId, "finding2-c bridge");
    const attacker = createVirtualAuthenticator();
    const opts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${bridge.mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge, rp_id: rpId, origin } = opts.json();

    // D-66: enrolling an additional credential now requires a grant, which
    // requires authenticating with the existing key. No authentication
    // happens anywhere in this test, so this must fail.
    const enrolled = await app.inject({
      method: "POST",
      url: `/v1/mandates/${bridge.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge,
        response: buildRegistrationResponse({ authenticator: attacker, rpId, origin, challenge }),
      },
    });
    // Blocked at the purpose check first (this is an AUTHENTICATION
    // challenge). The grant requirement is proven independently by the
    // D-66 grant tests below, which use a genuine REGISTRATION challenge.
    expect(enrolled.statusCode).toBe(400);
    expect(enrolled.json().error).toBe("challenge_purpose_mismatch");
  });

  it("(e1) the authentication challenge is derived from the PUBLIC policy_hash, so it is predictable, not secret", async () => {
    const victim = await victimPrincipalWithPasskey("finding2-e1");
    const target = await createMandateFor(victim.principalId, "finding2-e1 target");

    // policy_hash is public: it is on the mandate detail and on every
    // receipt. The authentication challenge is base64url(policy_hash).
    const detail = await app.inject({
      method: "GET",
      url: `/v1/mandates/${target.mandateId}`,
      headers: authed(),
    });
    const policyHash = detail.json().policy_hash as string;
    const predicted = Buffer.from(policyHash, "utf8").toString("base64url");

    // The server must still have issued the challenge row, but the attacker
    // never needs to read the value out of the response -- they compute it.
    const opts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${target.mandateId}/authenticate/options`,
      headers: authed(),
    });
    expect(opts.json().challenge).toBe(predicted);

    const attacker = createVirtualAuthenticator();
    const { rp_id: rpId, origin } = opts.json();
    const enrolled = await app.inject({
      method: "POST",
      url: `/v1/mandates/${target.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge: predicted,
        response: buildRegistrationResponse({ authenticator: attacker, rpId, origin, challenge: predicted }),
      },
    });
    // The challenge remains predictable -- that is still true and recorded
    // as OQ-12 -- but predicting it no longer buys an enrollment, because
    // the purpose check does not care how the attacker learned the value.
    expect(enrolled.statusCode).toBe(400);
    expect(enrolled.json().error).toBe("challenge_purpose_mismatch");
  });

  it("(e2) the reverse direction -- a registration challenge answered with an authentication response -- is already refused", async () => {
    // Not a hole, and worth pinning so a fix does not accidentally open it:
    // completeMandateAuthentication derives the expected challenge from the
    // policy hash, so a *random* registration challenge can never match. The
    // defense here is the challenge's derivation, not a purpose check.
    const fresh = await createMandateFor(
      (
        await app.inject({
          method: "POST",
          url: "/v1/principals",
          headers: authed(),
          payload: { display_name: "finding2-e2 principal" },
        })
      ).json().principal_id as string,
      "finding2-e2",
    );

    const opts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${fresh.mandateId}/authenticate/options`,
      headers: authed(),
    });
    expect(opts.json().mode).toBe("register"); // no credential yet
    const { challenge: regChallenge, rp_id: rpId, origin } = opts.json();

    const attacker = createVirtualAuthenticator();
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/mandates/${fresh.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "authenticate",
        challenge: regChallenge,
        response: buildAuthenticationResponse({ authenticator: attacker, rpId, origin, challenge: regChallenge }),
      },
    });
    // D-66 turns this from an accidental defense into a deliberate one: it
    // used to fail only because a random registration challenge can never
    // equal policyHashToChallenge(policy_hash). Now it is refused by name.
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe("challenge_purpose_mismatch");
    expect(rejected.json().actual_purpose).toBe("REGISTRATION");
    expect(rejected.json().expected_purpose).toBe("AUTHENTICATION");
  });

  it("the legitimate first enrollment and the legitimate authentication both work -- the control case", async () => {
    const legitimate = createVirtualAuthenticator();
    const m = await setUpMandateWith("finding2-control", legitimate);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/mandates/${m.mandateId}`,
      headers: authed(),
    });
    expect(detail.json().status).toBe("ACTIVE");
  });
});

// ===================================================================
// FINDING 2, tenancy sub-finding -- own commit, own D-number.
// Mandate creation does not check that the principal belongs to the
// caller's organization.
// ===================================================================

describe("FINDING 2 sub-finding: mandate creation ignores the principal's organization (tenancy)", () => {
  it("THE ATTACK: org A creates a mandate naming org B's principal", async () => {
    // A second organization, with its own credential and its own principal.
    const orgB = await repos.agentKeys.createKey(
      { organizationId: "org_victim_tenant", name: "org B admin" },
      new Date(),
    );
    const orgBAuth = { authorization: `Bearer ${orgB.fullKey}` };
    const orgBPrincipalId = (
      await app.inject({
        method: "POST",
        url: "/v1/principals",
        headers: orgBAuth,
        payload: { display_name: "org B's principal" },
      })
    ).json().principal_id as string;

    // Org A's own agent, so only the principal is foreign.
    const orgAAgentId = (
      await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: authed(),
        payload: { name: "org A agent" },
      })
    ).json().agent_id as string;

    const created = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: authed(),
      payload: {
        principal_id: orgBPrincipalId,
        agent_ids: [orgAAgentId],
        policy: {
          schema_version: "waysafe.policy/v1",
          summary: "a mandate over another tenant's principal",
          currency: "USD",
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        intent_text: "a mandate over another tenant's principal",
        compiler_name: "manual",
      },
    });

    // D-67: rejected. The principal exists, but not in this organization.
    expect(created.statusCode).toBe(422);
    expect(created.json().error).toBe("unknown_principal");
  });

  it("D-67: org B can still create a mandate for its OWN principal -- the control case", async () => {
    const orgB = await repos.agentKeys.createKey(
      { organizationId: "org_control_tenant", name: "org B control admin" },
      new Date(),
    );
    const orgBAuth = { authorization: `Bearer ${orgB.fullKey}` };
    const principalId = (
      await app.inject({
        method: "POST",
        url: "/v1/principals",
        headers: orgBAuth,
        payload: { display_name: "org B's own principal" },
      })
    ).json().principal_id as string;
    const agentId = (
      await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: orgBAuth,
        payload: { name: "org B agent" },
      })
    ).json().agent_id as string;

    const created = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: orgBAuth,
      payload: {
        principal_id: principalId,
        agent_ids: [agentId],
        policy: {
          schema_version: "waysafe.policy/v1",
          summary: "org B's own mandate",
          currency: "USD",
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        intent_text: "org B's own mandate",
        compiler_name: "manual",
      },
    });
    expect(created.statusCode).toBe(201);
  });

  it("D-67: the rejection does not distinguish wrong-org from non-existent -- no cross-tenant existence oracle", async () => {
    const orgB = await repos.agentKeys.createKey(
      { organizationId: "org_oracle_tenant", name: "org B oracle admin" },
      new Date(),
    );
    const realButForeign = (
      await app.inject({
        method: "POST",
        url: "/v1/principals",
        headers: { authorization: `Bearer ${orgB.fullKey}` },
        payload: { display_name: "a real principal in another org" },
      })
    ).json().principal_id as string;

    const agentId = (
      await app.inject({ method: "POST", url: "/v1/agents", headers: authed(), payload: { name: "oracle probe" } })
    ).json().agent_id as string;

    const policy = {
      schema_version: "waysafe.policy/v1",
      summary: "oracle probe",
      currency: "USD",
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
      cumulative_limits: [],
      step_up: { ttl_seconds: 900 },
      accounting: {},
      expires_at: "2099-01-01T00:00:00.000Z",
    };

    const foreign = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: authed(),
      payload: { principal_id: realButForeign, agent_ids: [agentId], policy, intent_text: "x", compiler_name: "manual" },
    });
    const nonexistent = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: authed(),
      payload: { principal_id: "prin_does_not_exist_anywhere", agent_ids: [agentId], policy, intent_text: "x", compiler_name: "manual" },
    });

    // Byte-identical responses: an attacker cannot use this route to learn
    // whether a principal id exists in some other tenant.
    expect(foreign.statusCode).toBe(nonexistent.statusCode);
    expect(foreign.json()).toEqual(nonexistent.json());
  });

  it("a principal that does not exist at all is also accepted", async () => {
    const agentId = (
      await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: authed(),
        payload: { name: "phantom principal agent" },
      })
    ).json().agent_id as string;

    const created = await app.inject({
      method: "POST",
      url: "/v1/mandates",
      headers: authed(),
      payload: {
        principal_id: "prin_never_created_anywhere",
        agent_ids: [agentId],
        policy: {
          schema_version: "waysafe.policy/v1",
          summary: "phantom principal",
          currency: "USD",
          merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
          cumulative_limits: [],
          step_up: { ttl_seconds: 900 },
          accounting: {},
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        intent_text: "phantom principal",
        compiler_name: "manual",
      },
    });
    // D-67: a principal that exists nowhere is rejected the same way.
    expect(created.statusCode).toBe(422);
    expect(created.json().error).toBe("unknown_principal");
  });
});

// ===================================================================
// FINDING 2 fix (D-66): the re-enrollment grant's own properties.
// ===================================================================

describe("D-66: the re-enrollment grant (binding, single-use, expiry)", () => {
  /** Runs the two-step re-enrollment ceremony and returns the grant. */
  async function mintGrant(principalId: string, authenticator: ReturnType<typeof createVirtualAuthenticator>) {
    const opts = await app.inject({
      method: "POST",
      url: `/v1/principals/${principalId}/passkeys/options`,
      headers: authed(),
    });
    expect(opts.statusCode).toBe(200);
    const { challenge, rp_id: rpId, origin } = opts.json();
    const verified = await app.inject({
      method: "POST",
      url: `/v1/principals/${principalId}/passkeys/verify`,
      headers: authed(),
      payload: {
        challenge,
        response: buildAuthenticationResponse({ authenticator, rpId, origin, challenge }),
      },
    });
    return verified;
  }

  /** Attempts to enroll `newKey` on `principalId`, optionally with a grant. */
  async function tryEnroll(
    principalId: string,
    newKey: ReturnType<typeof createVirtualAuthenticator>,
    grant?: string,
  ) {
    const m = await createMandateFor(principalId, "reenroll target");
    // A principal with credentials gets an AUTHENTICATION challenge from
    // /options, so mint a genuine REGISTRATION challenge the way the
    // re-enrollment flow documents: via the registration path for this
    // principal. We reach it directly through the repository, because the
    // only route that issues one is gated on having no credential yet --
    // which is itself the point of the grant.
    const reg = await beginRegistrationForTest(principalId);
    return app.inject({
      method: "POST",
      url: `/v1/mandates/${m.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge: reg,
        response: buildRegistrationResponse({
          authenticator: newKey,
          rpId: WEBAUTHN_CONFIG.rpId,
          origin: WEBAUTHN_CONFIG.origin,
          challenge: reg,
        }),
        ...(grant ? { reenrollment_grant: grant } : {}),
      },
    });
  }

  async function beginRegistrationForTest(principalId: string): Promise<string> {
    const challenge = Buffer.from(`reg-${principalId}-${Math.random()}`).toString("base64url");
    await repos.webauthn.createChallenge(
      {
        principalId,
        challenge,
        purpose: "REGISTRATION",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
      new Date(),
    );
    return challenge;
  }

  it("a grant for principal X cannot enroll on principal Y", async () => {
    const x = await victimWithKey("d66-bind-x");
    const y = await victimWithKey("d66-bind-y");

    const granted = await mintGrant(x.principalId, x.authenticator);
    expect(granted.json().kind).toBe("granted");
    const grantForX = granted.json().grant as string;

    const attacker = createVirtualAuthenticator();
    const crossUse = await tryEnroll(y.principalId, attacker, grantForX);
    expect(crossUse.statusCode).toBe(401);
    expect(crossUse.json().reason).toMatch(/grant not found|not a grant/);
  });

  it("a grant is single-use: a second registration with the same grant is rejected", async () => {
    const victim = await victimWithKey("d66-single-use");
    const granted = await mintGrant(victim.principalId, victim.authenticator);
    const grant = granted.json().grant as string;

    const first = await tryEnroll(victim.principalId, createVirtualAuthenticator(), grant);
    expect(first.statusCode).toBe(200);
    expect(first.json().kind).toBe("registered");

    const second = await tryEnroll(victim.principalId, createVirtualAuthenticator(), grant);
    expect(second.statusCode).toBe(401);
    expect(second.json().reason).toMatch(/grant not found|already used/);
  });

  it("a grant expires: registration after its TTL is rejected", async () => {
    const victim = await victimWithKey("d66-expiry");

    // A real grant first, to confirm the happy path issues a FUTURE expiry
    // -- so this test is about the TTL being enforced, not about the TTL
    // being absent.
    const granted = await mintGrant(victim.principalId, victim.authenticator);
    expect(new Date(granted.json().expires_at as string).getTime()).toBeGreaterThan(Date.now());

    // Now an already-expired grant, written directly, which is exactly what
    // the clock would have produced five minutes later.
    const expiredGrant = `expired-${Math.random()}.cred`;
    await repos.webauthn.createChallenge(
      {
        principalId: victim.principalId,
        challenge: expiredGrant,
        purpose: "REENROLLMENT_GRANT",
        expiresAt: new Date(Date.now() - 1000),
      },
      new Date(),
    );

    const afterTtl = await tryEnroll(victim.principalId, createVirtualAuthenticator(), expiredGrant);
    expect(afterTtl.statusCode).toBe(401);
    expect(afterTtl.json().reason).toMatch(/grant not found|expired/);
  });

  it("CONTROL: first enrollment on a principal with zero credentials still works with no grant", async () => {
    const principalId = (
      await app.inject({
        method: "POST",
        url: "/v1/principals",
        headers: authed(),
        payload: { display_name: "d66 first enrollment" },
      })
    ).json().principal_id as string;
    expect(await repos.webauthn.hasCredentialForPrincipal(principalId)).toBe(false);

    const m = await createMandateFor(principalId, "d66 first enrollment");
    const opts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${m.mandateId}/authenticate/options`,
      headers: authed(),
    });
    expect(opts.json().mode).toBe("register");
    const { challenge, rp_id: rpId, origin } = opts.json();
    const enrolled = await app.inject({
      method: "POST",
      url: `/v1/mandates/${m.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge,
        response: buildRegistrationResponse({
          authenticator: createVirtualAuthenticator(),
          rpId,
          origin,
          challenge,
        }),
      },
    });
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.json().kind).toBe("registered");
  });

  it("the legitimate re-enrollment flow works end to end: authenticate with the old key, enroll a new one", async () => {
    const victim = await victimWithKey("d66-happy-path");
    const granted = await mintGrant(victim.principalId, victim.authenticator);
    expect(granted.statusCode).toBe(200);

    const secondKey = createVirtualAuthenticator();
    const enrolled = await tryEnroll(victim.principalId, secondKey, granted.json().grant as string);
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.json().kind).toBe("registered");
  });

  it("a grant cannot be minted without the principal's existing passkey", async () => {
    const victim = await victimWithKey("d66-no-key-no-grant");
    // An attacker with an org credential but no passkey: they can request
    // the challenge, but cannot sign it.
    const attacker = createVirtualAuthenticator();
    const attempt = await mintGrant(victim.principalId, attacker);
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json().kind).toBe("rejected");
  });
});

// ===================================================================
// FINDING 2 -- what an attacker-enrolled passkey could do under D-62.
// ===================================================================

describe("D-66: an attacker-enrolled passkey cannot approve a step-up as that principal", () => {
  it("THE ATTACK, carried through to the actual approval attempt: step-up stays pending", async () => {
    // An established approver principal -- it already holds a real passkey,
    // which is what makes D-66's grant requirement apply to it.
    const approverKey = createVirtualAuthenticator();
    const approver = await setUpMandateWith("d66-approver", approverKey);

    // A spender whose policy names that approver mandate, and which is
    // itself authenticated so it can actually spend.
    const spenderKey = createVirtualAuthenticator();
    const spenderPrincipalId = (
      await app.inject({
        method: "POST",
        url: "/v1/principals",
        headers: authed(),
        payload: { display_name: "d66 spender principal" },
      })
    ).json().principal_id as string;
    const spender = await createMandateFor(spenderPrincipalId, "d66-spender", {
      step_up: { above_amount: toMinorUnits(10, "USD"), ttl_seconds: 900 },
      escalation: { approvers: [approver.mandateId] },
    });
    // Authenticate it (first enrollment for this principal, so no grant).
    const sOpts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${spender.mandateId}/authenticate/options`,
      headers: authed(),
    });
    const { challenge: sReg, rp_id: rpId, origin } = sOpts.json();
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${spender.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge: sReg,
        response: buildRegistrationResponse({ authenticator: spenderKey, rpId, origin, challenge: sReg }),
      },
    });
    const sAuth = await app.inject({
      method: "POST",
      url: `/v1/mandates/${spender.mandateId}/authenticate/options`,
      headers: authed(),
    });
    const sAuthChallenge = sAuth.json().challenge as string;
    await app.inject({
      method: "POST",
      url: `/v1/mandates/${spender.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "authenticate",
        challenge: sAuthChallenge,
        response: buildAuthenticationResponse({ authenticator: spenderKey, rpId, origin, challenge: sAuthChallenge }),
      },
    });

    const spenderAgentKey = (
      await app.inject({
        method: "POST",
        url: `/v1/agents/${spender.agentId}/keys`,
        headers: authed(),
        payload: { name: "d66 spender key" },
      })
    ).json().api_key as string;

    // A real STEP_UP the spender may not resolve itself.
    const stepUp = await app.inject({
      method: "POST",
      url: "/v1/authorizations",
      headers: asAgent(spenderAgentKey),
      payload: {
        agent_id: spender.agentId,
        principal_id: spenderPrincipalId,
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

    // Step 1 BLOCKED (D-66): the attacker tries to put its own passkey on
    // the approver's principal by answering an authentication challenge
    // with a registration response.
    const bridge = await createMandateFor(approver.principalId, "d66-bridge");
    const bOpts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${bridge.mandateId}/authenticate/options`,
      headers: authed(),
    });
    expect(bOpts.json().mode).toBe("authenticate");
    const bChallenge = bOpts.json().challenge as string;
    const attacker = createVirtualAuthenticator();
    const attackerResponse = buildRegistrationResponse({
      authenticator: attacker,
      rpId,
      origin,
      challenge: bChallenge,
    });
    const enrolled = await app.inject({
      method: "POST",
      url: `/v1/mandates/${bridge.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: { mode: "register", challenge: bChallenge, response: attackerResponse },
    });
    expect(enrolled.statusCode).toBe(400);
    expect(enrolled.json().error).toBe("challenge_purpose_mismatch");
    expect(await repos.webauthn.getCredentialByCredentialId(attackerResponse.id)).toBeNull();

    // Step 2, CARRIED THROUGH -- the part the earlier version of this test
    // asserted nothing about. Even having failed to enroll, the attacker
    // still tries to resolve the step-up as the approver, both ways it
    // could: with its org credential, and with the approver's own agent id.
    const viaOrg = await app.inject({
      method: "POST",
      url: `/v1/authorizations/${stepUpId}/step-up`,
      headers: authed(),
      payload: {
        agent_id: approver.agentId,
        principal_id: approver.principalId,
        mandate_id: approver.mandateId,
      },
    });
    // An org credential has no agent identity (D-18), so it cannot act as
    // the approver's agent whatever it claims in the body.
    expect(viaOrg.statusCode).toBe(403);

    // And it cannot mint the approver's agent key to try again (D-64).
    const mint = await app.inject({
      method: "POST",
      url: `/v1/agents/${approver.agentId}/keys`,
      headers: asAgent(spenderAgentKey),
      payload: { name: "d66 forged approver key" },
    });
    expect(mint.statusCode).toBe(403);

    // The step-up is untouched: still pending, still needing the real
    // approver's own credential.
    const receipt = await app.inject({
      method: "GET",
      url: `/v1/authorizations/${stepUpId}`,
      headers: authed(),
    });
    expect(receipt.json().status).toBe("PENDING_STEP_UP");
  });

  it("RESIDUAL RISK, documented not fixed: an org credential can still enroll a FIRST passkey on a principal that has none", async () => {
    // D-66 gates *additional* enrollments, because a principal with no
    // credential has nothing to prove control of. So an org credential can
    // still bootstrap a brand-new principal's first passkey and authenticate
    // mandates for it. That is the intended boundary, not an oversight --
    // but it means a compromised org credential can create a principal,
    // enroll a key, write a mandate, and activate it, all by itself.
    // Pinned here so the boundary is explicit rather than implied.
    const principalId = (
      await app.inject({
        method: "POST",
        url: "/v1/principals",
        headers: authed(),
        payload: { display_name: "d66 residual risk principal" },
      })
    ).json().principal_id as string;

    const m = await createMandateFor(principalId, "d66-residual");
    const opts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${m.mandateId}/authenticate/options`,
      headers: authed(),
    });
    expect(opts.json().mode).toBe("register");
    const { challenge, rp_id: rpId, origin } = opts.json();
    const attacker = createVirtualAuthenticator();
    const enrolled = await app.inject({
      method: "POST",
      url: `/v1/mandates/${m.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: {
        mode: "register",
        challenge,
        response: buildRegistrationResponse({ authenticator: attacker, rpId, origin, challenge }),
      },
    });
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.json().kind).toBe("registered");
  });
});

// ===================================================================
// FINDING 2 (e1) follow-up: is a captured assertion replayable onto a
// second mandate with the same policy hash? signCount says no.
// ===================================================================

describe("D-66 (e1): signCount makes a captured assertion non-replayable", () => {
  it("the same assertion cannot activate a second mandate with an identical policy hash", async () => {
    const key = createVirtualAuthenticator();
    const first = await setUpMandateWith("e1-replay", key);

    // Two mandates with BYTE-IDENTICAL policy therefore share a policy_hash,
    // and so share an authentication challenge (D-20 derives it from the
    // hash). That is what makes a replay conceivable at all.
    const identicalPolicy = { summary: "identical policy for replay test" };
    const a = await createMandateFor(first.principalId, "e1-a", identicalPolicy);
    const b = await createMandateFor(first.principalId, "e1-b", identicalPolicy);

    const aOpts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${a.mandateId}/authenticate/options`,
      headers: authed(),
    });
    const bOpts = await app.inject({
      method: "POST",
      url: `/v1/mandates/${b.mandateId}/authenticate/options`,
      headers: authed(),
    });
    // Same challenge, confirming the precondition for a replay.
    expect(aOpts.json().challenge).toBe(bOpts.json().challenge);

    const { challenge, rp_id: rpId, origin } = aOpts.json();
    const assertion = buildAuthenticationResponse({ authenticator: key, rpId, origin, challenge });

    const activatedA = await app.inject({
      method: "POST",
      url: `/v1/mandates/${a.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: { mode: "authenticate", challenge, response: assertion },
    });
    expect(activatedA.json().kind).toBe("activated");

    // Replay the EXACT same assertion bytes at the second mandate. The
    // signature verifies and the challenge matches -- the only thing
    // standing in the way is the persisted signCount, which has already
    // advanced past this assertion's.
    const replayed = await app.inject({
      method: "POST",
      url: `/v1/mandates/${b.mandateId}/authenticate/verify`,
      headers: authed(),
      payload: { mode: "authenticate", challenge, response: assertion },
    });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json().kind).toBe("rejected");

    const bDetail = await app.inject({
      method: "GET",
      url: `/v1/mandates/${b.mandateId}`,
      headers: authed(),
    });
    expect(bDetail.json().status).toBe("PENDING_AUTHENTICATION");
  });
});
