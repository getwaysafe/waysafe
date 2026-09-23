/**
 * Orchestration tests -- challenge lifecycle, mandate activation gating,
 * evidence writes -- run through the real crypto (the virtual authenticator
 * against real @simplewebauthn/server verification), not a fake verifier.
 * See webauthn.test.ts for the crypto-only proofs this builds on.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createStaticDirectory,
  generateEvidenceSigningKeyPair,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  Decision,
  ReasonCode,
  type Policy,
} from "@waysafe/core";
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { authorize } from "../authorization/service.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryWebauthnRepository } from "./in-memory-repository.js";
import {
  beginMandateAuthentication,
  beginRegistration,
  completeMandateAuthentication,
  completeRegistration,
  type WebauthnServiceRepos,
} from "./service.js";
import type { WebauthnConfig } from "./webauthn.js";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "./test-support/virtual-authenticator.js";

const CONFIG: WebauthnConfig = { rpId: "localhost", origin: "http://localhost:3000" };
const ORG = "org_test";
const PRINCIPAL = "prin_test";
const AGENT = "agt_test";
const NOW = new Date("2026-08-24T12:00:00.000Z");
const TEST_IP = "203.0.113.10";

function repos(): WebauthnServiceRepos & { authorization: InMemoryAuthorizationRepository } {
  return {
    webauthn: new InMemoryWebauthnRepository(),
    authorization: new InMemoryAuthorizationRepository(createStaticDirectory([])),
    evidence: new InMemoryEvidenceRepository(new FakeEd25519Signer()),
  };
}

function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "test",
    currency: "USD",
    merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    cumulative_limits: [],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-09-23T12:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

describe("passkey registration", () => {
  it("registers a genuine passkey", async () => {
    const r = repos();
    const authenticator = createVirtualAuthenticator();
    const { challenge } = await beginRegistration(r, PRINCIPAL, NOW);
    const response = buildRegistrationResponse({ authenticator, rpId: CONFIG.rpId, origin: CONFIG.origin, challenge });

    const result = await completeRegistration(
      r,
      CONFIG,
      { organizationId: ORG, principalId: PRINCIPAL, response, claimedChallenge: challenge },
      NOW,
    );

    expect(result.kind).toBe("registered");
    const events = await r.evidence.listForOrganization(ORG);
    expect(events.map((e) => e.type)).toEqual(["passkey.registered"]);
  });

  it("THE ATTACK: a reused registration challenge is rejected", async () => {
    const r = repos();
    const authenticator = createVirtualAuthenticator();
    const { challenge } = await beginRegistration(r, PRINCIPAL, NOW);
    const response = buildRegistrationResponse({ authenticator, rpId: CONFIG.rpId, origin: CONFIG.origin, challenge });

    const first = await completeRegistration(
      r,
      CONFIG,
      { organizationId: ORG, principalId: PRINCIPAL, response, claimedChallenge: challenge },
      NOW,
    );
    const second = await completeRegistration(
      r,
      CONFIG,
      { organizationId: ORG, principalId: PRINCIPAL, response, claimedChallenge: challenge },
      new Date(NOW.getTime() + 1000),
    );

    expect(first.kind).toBe("registered");
    expect(second.kind).toBe("rejected");
    const events = await r.evidence.listForOrganization(ORG);
    expect(events.map((e) => e.type)).toEqual(["passkey.registered", "passkey.registration_rejected"]);
  });
});

describe("mandate authentication and activation (D-20)", () => {
  async function registerAuthenticator(r: WebauthnServiceRepos) {
    const authenticator = createVirtualAuthenticator();
    const { challenge } = await beginRegistration(r, PRINCIPAL, NOW);
    const response = buildRegistrationResponse({ authenticator, rpId: CONFIG.rpId, origin: CONFIG.origin, challenge });
    const result = await completeRegistration(
      r,
      CONFIG,
      { organizationId: ORG, principalId: PRINCIPAL, response, claimedChallenge: challenge },
      NOW,
    );
    if (result.kind !== "registered") throw new Error("unreachable");
    return authenticator;
  }

  it("THE ATTACK, end to end: a mandate with no authentication cannot authorize anything -- authenticating it makes it able to", async () => {
    const r = repos();
    const agentKeys = new InMemoryAgentKeyRepository();
    const authenticator = await registerAuthenticator(r);

    const { mandateId, mandateVersionId, policyHash } = r.authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "test-hash",
      status: "PENDING_AUTHENTICATION",
      authenticatedAt: null,
    });
    const key = await agentKeys.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);
    const request = {
      agent_id: AGENT,
      principal_id: PRINCIPAL,
      // Explicit mandate_id: the implicit active-mandate lookup only finds
      // mandates already ACTIVE, so a PENDING_AUTHENTICATION mandate needs
      // to be cited directly -- same pattern as the existing
      // authorization/service.test.ts gate tests.
      mandate_id: mandateId,
      action: {
        amount: toMinorUnits(10, "USD"),
        currency: "USD" as const,
        merchant: { name: "Some Shop" },
        attestations: {},
      },
      context: {},
    };

    // Before authentication: DENY_MANDATE_NOT_AUTHENTICATED, evaluate() never
    // in question -- the actor-state gate blocks it before the engine runs.
    const before = await authorize(
      { authorization: r.authorization, agentKeys, evidence: r.evidence },
      { organizationId: ORG, request, now: NOW, apiKey: key.fullKey },
    );
    if (before.kind !== "decided") throw new Error("unreachable");
    expect(before.authorization.reasons[0]?.code).toBe(ReasonCode.DENY_MANDATE_NOT_AUTHENTICATED);

    // Authenticate for real.
    const { challenge } = await beginMandateAuthentication(r, PRINCIPAL, policyHash, NOW);
    const assertion = buildAuthenticationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge,
    });
    const authResult = await completeMandateAuthentication(
      r,
      CONFIG,
      {
        organizationId: ORG,
        principalId: PRINCIPAL,
        mandateId,
        mandateVersionId,
        policyHash,
        response: assertion,
        ip: TEST_IP,
      },
      NOW,
    );
    expect(authResult.kind).toBe("activated");

    // After authentication: the same request now clears the actor-state gate
    // and reaches evaluate() -- proven by the reason changing from
    // DENY_MANDATE_NOT_AUTHENTICATED to a merchant-engine reason (STEP_UP,
    // since a name-only merchant assertion is unverified -- D-3's ceiling).
    const after = await authorize(
      { authorization: r.authorization, agentKeys, evidence: r.evidence },
      { organizationId: ORG, request, now: NOW, apiKey: key.fullKey },
    );
    if (after.kind !== "decided") throw new Error("unreachable");
    expect(after.authorization.decision).toBe(Decision.STEP_UP);
    expect(after.authorization.reasons[0]?.code).toBe(ReasonCode.STEP_UP_MERCHANT_UNVERIFIED);

    const events = await r.evidence.listForOrganization(ORG);
    expect(events.map((e) => e.type)).toContain("mandate.authenticated");

    // D-38: the real request IP is persisted on the mandate version
    // alongside authenticatedAt, not just passed through and dropped --
    // this is the only place `provisionCardForMandate` can later read a
    // genuine acceptance from.
    const detail = await r.authorization.getMandateDetail(mandateId);
    expect(detail?.authenticationIp).toBe(TEST_IP);
  });

  it("THE ATTACK: a reused authentication challenge is rejected", async () => {
    const r = repos();
    const authenticator = await registerAuthenticator(r);
    const { mandateId, mandateVersionId, policyHash } = r.authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "test-hash",
      status: "PENDING_AUTHENTICATION",
      authenticatedAt: null,
    });
    const { challenge } = await beginMandateAuthentication(r, PRINCIPAL, policyHash, NOW);
    const assertion = buildAuthenticationResponse({ authenticator, rpId: CONFIG.rpId, origin: CONFIG.origin, challenge });

    const first = await completeMandateAuthentication(
      r,
      CONFIG,
      { organizationId: ORG, principalId: PRINCIPAL, mandateId, mandateVersionId, policyHash, response: assertion, ip: TEST_IP },
      NOW,
    );
    const second = await completeMandateAuthentication(
      r,
      CONFIG,
      { organizationId: ORG, principalId: PRINCIPAL, mandateId, mandateVersionId, policyHash, response: assertion, ip: TEST_IP },
      new Date(NOW.getTime() + 1000),
    );

    expect(first.kind).toBe("activated");
    expect(second.kind).toBe("rejected");
  });

  it("THE ATTACK: a genuine signature over a different mandate's policy_hash is rejected", async () => {
    const r = repos();
    const authenticator = await registerAuthenticator(r);

    const mandateA = r.authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash-a",
      status: "PENDING_AUTHENTICATION",
      authenticatedAt: null,
    });
    const mandateB = r.authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom({ summary: "different policy" }),
      policyHash: "hash-b",
      status: "PENDING_AUTHENTICATION",
      authenticatedAt: null,
    });

    // Both mandates have a live, unconsumed challenge -- so the rejection
    // below has to come from the actual signature/challenge mismatch, not
    // merely "no challenge was ever issued for B".
    const beginA = await beginMandateAuthentication(r, PRINCIPAL, mandateA.policyHash, NOW);
    await beginMandateAuthentication(r, PRINCIPAL, mandateB.policyHash, NOW);

    // The principal genuinely authenticates mandate A -- a real signature,
    // correctly produced over A's challenge.
    const assertionForA = buildAuthenticationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: beginA.challenge,
    });

    // An attacker (or a confused client) tries to use that exact response
    // to activate mandate B instead. B's challenge row gets consumed (it's
    // real and unexpired), but the assertion itself was signed over A's
    // challenge -- the real @simplewebauthn/server verification catches
    // the mismatch and rejects it.
    const result = await completeMandateAuthentication(
      r,
      CONFIG,
      {
        organizationId: ORG,
        principalId: PRINCIPAL,
        mandateId: mandateB.mandateId,
        mandateVersionId: mandateB.mandateVersionId,
        policyHash: mandateB.policyHash,
        response: assertionForA,
        ip: TEST_IP,
      },
      NOW,
    );

    expect(result.kind).toBe("rejected");
  });

  it("THE ATTACK: activateMandate is never called when verification fails, and IS called when it succeeds", async () => {
    const r = repos();
    const activateSpy = vi.spyOn(r.authorization, "activateMandate");
    const authenticator = await registerAuthenticator(r);
    const { mandateId, mandateVersionId, policyHash } = r.authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "test-hash",
      status: "PENDING_AUTHENTICATION",
      authenticatedAt: null,
    });

    // No beginMandateAuthentication call -- no challenge was ever issued.
    const forgedAssertion = buildAuthenticationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: "not-a-real-challenge",
    });
    const rejected = await completeMandateAuthentication(
      r,
      CONFIG,
      { organizationId: ORG, principalId: PRINCIPAL, mandateId, mandateVersionId, policyHash, response: forgedAssertion, ip: TEST_IP },
      NOW,
    );
    expect(rejected.kind).toBe("rejected");
    expect(activateSpy).not.toHaveBeenCalled();

    const { challenge } = await beginMandateAuthentication(r, PRINCIPAL, policyHash, NOW);
    const realAssertion = buildAuthenticationResponse({ authenticator, rpId: CONFIG.rpId, origin: CONFIG.origin, challenge });
    const activated = await completeMandateAuthentication(
      r,
      CONFIG,
      { organizationId: ORG, principalId: PRINCIPAL, mandateId, mandateVersionId, policyHash, response: realAssertion, ip: TEST_IP },
      NOW,
    );
    expect(activated.kind).toBe("activated");
    expect(activateSpy).toHaveBeenCalledTimes(1);

    activateSpy.mockRestore();
  });
});
