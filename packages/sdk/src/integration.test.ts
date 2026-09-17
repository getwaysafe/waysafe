/**
 * The SDK against a real, listening Waysafe server -- not a mocked fetch.
 *
 * index.test.ts proves the SDK's own logic (error mapping, retries,
 * idempotency, the executable brand) against a fake `fetch`; it can't catch
 * a wire-format mismatch between what this SDK sends/expects and what
 * apps/api/src/server.ts actually sends/expects, because both sides of that
 * mismatch would agree with each other in a mock. This file closes that gap
 * by running the SDK against `buildServer()` bound to a real port, using the
 * real global `fetch` -- the same code path an external developer's process
 * would use.
 *
 * Imports server.ts and the WebAuthn virtual authenticator by relative path
 * rather than as a dependency: the SDK package itself has no dependency on
 * @waysafe/api (it would be a layering violation -- SDK is a client, not
 * coupled to one implementation of the server), but this test file is
 * allowed to reach into the sibling app since it exists to prove the two are
 * wire-compatible, in the one place that needs both.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaticDirectory,
  toMinorUnits,
  FixtureIntentCompiler,
  generateEvidenceSigningKeyPair,
  loadCompilerFixtures,
} from "@waysafe/core";
import { buildServer, type ServerRepos } from "../../../apps/api/src/server.js";
import { InMemoryAgentKeyRepository } from "../../../apps/api/src/agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "../../../apps/api/src/authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../../../apps/api/src/evidence/in-memory-repository.js";
import { InMemoryPrincipalRepository } from "../../../apps/api/src/principals/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "../../../apps/api/src/instruments/in-memory-repository.js";
import { InMemoryWebauthnRepository } from "../../../apps/api/src/webauthn/in-memory-repository.js";
import { InMemoryProviderEventRepository } from "../../../apps/api/src/webhooks/in-memory-repository.js";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "../../../apps/api/src/webauthn/test-support/virtual-authenticator.js";
import { FakeAdapter } from "../../../apps/api/src/execution/test-support/fake-adapter.js";
import { Waysafe, asExecutable, NoActiveMandateError, verifyEvidenceIndependently } from "./index.js";

let app: ReturnType<typeof buildServer>;
let repos: ServerRepos;
let baseUrl: string;
let orgClient: Waysafe;
let orgKey: string;

const ORG = "org_sdk_integration";
const fakeAdapter = new FakeAdapter({ providerFee: 25 });

beforeAll(async () => {
  repos = {
    authorization: new InMemoryAuthorizationRepository(
      createStaticDirectory([{ domain: "staples.com", display_name: "Staples" }]),
    ),
    agentKeys: new InMemoryAgentKeyRepository(),
    evidence: new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey),
    webauthn: new InMemoryWebauthnRepository(),
    providerEvents: new InMemoryProviderEventRepository(),
    principals: new InMemoryPrincipalRepository(),
    instruments: new InMemoryInstrumentRepository(),
  };

  app = buildServer({
    compiler: new FixtureIntentCompiler(loadCompilerFixtures()),
    logger: false,
    repos,
    webauthnConfig: { rpId: "localhost", origin: "http://localhost:3000" },
    adapters: { fake: fakeAdapter },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await repos.agentKeys.createKey({ organizationId: ORG, name: "org admin" }, new Date());
  orgKey = created.fullKey;
  orgClient = new Waysafe({ baseUrl, apiKey: orgKey });
});

afterAll(async () => {
  await app.close();
});

const PROCUREMENT_STRICT =
  "You may spend $500 per month on office supplies. Amazon and Staples are approved. Never spend more than $150 in a single transaction. Ask me before buying from another merchant.";

/** Full setup a developer would do once per agent: compile, create, and
 * authenticate a mandate, mint an agent key. Runs entirely through the SDK --
 * including registering the principal itself over HTTP (OQ-9), not a
 * locally-minted id nobody asked the API about. */
async function setUpAuthenticatedMandate() {
  const agent = await orgClient.createAgent({ name: "sdk integration bot" });

  const compiled = await orgClient.compileMandate({ instruction: PROCUREMENT_STRICT });
  if (compiled.status !== "compiled") throw new Error("expected the fixture instruction to compile");

  const principal = await orgClient.createPrincipal({ display_name: "sdk integration principal" });
  const principalId = principal.principal_id;
  const mandate = await orgClient.createMandate({
    principal_id: principalId,
    agent_ids: [agent.agent_id],
    policy: compiled.policy,
    intent_text: PROCUREMENT_STRICT,
  });

  const authenticator = createVirtualAuthenticator();

  const registerOptions = await orgClient.getMandateAuthenticationOptions(mandate.mandate_id);
  const registerResult = await orgClient.verifyMandateAuthentication(mandate.mandate_id, {
    mode: "register",
    challenge: registerOptions.challenge,
    response: buildRegistrationResponse({
      authenticator,
      rpId: registerOptions.rp_id,
      origin: registerOptions.origin,
      challenge: registerOptions.challenge,
    }),
  });
  expect(registerResult.kind).toBe("registered");

  const authOptions = await orgClient.getMandateAuthenticationOptions(mandate.mandate_id);
  const authResult = await orgClient.verifyMandateAuthentication(mandate.mandate_id, {
    mode: "authenticate",
    challenge: authOptions.challenge,
    response: buildAuthenticationResponse({
      authenticator,
      rpId: authOptions.rp_id,
      origin: authOptions.origin,
      challenge: authOptions.challenge,
    }),
  });
  expect(authResult.kind).toBe("activated");

  const key = await orgClient.createAgentKey(agent.agent_id, { name: "sdk integration key" });
  const agentClient = new Waysafe({ baseUrl, apiKey: key.api_key });

  return { agent, mandate, principalId, agentClient };
}

describe("POST /v1/principals + GET /v1/principals/:id (OQ-9)", () => {
  it("creates a principal over HTTP and reads it back through the SDK", async () => {
    const created = await orgClient.createPrincipal({
      display_name: "Integration Test Principal",
      email: "principal@example.com",
      type: "ORGANIZATION",
    });
    expect(created.principal_id).toMatch(/^prin_/);
    expect(created.display_name).toBe("Integration Test Principal");
    expect(created.type).toBe("ORGANIZATION");

    const fetched = await orgClient.getPrincipal(created.principal_id);
    expect(fetched).toEqual(created);
  });
});

describe("the full journey through the SDK against a real server", () => {
  it("compiles, creates, authenticates a mandate, authorizes, executes, and verifies -- no raw REST", async () => {
    const { agent, mandate, principalId, agentClient } = await setUpAuthenticatedMandate();

    const decision = await agentClient.authorize({
      agent_id: agent.agent_id,
      principal_id: principalId,
      mandate_id: mandate.mandate_id,
      action: {
        amount: toMinorUnits(42, "USD"),
        currency: "USD",
        merchant: { domain: "staples.com" },
        category: "office_supplies",
        attestations: {},
      },
    });
    expect(decision.decision).toBe("ALLOW");
    expect(decision.status).toBe("AUTHORIZED");

    const executable = asExecutable(decision);
    expect(executable).not.toBeNull();

    const executed = await agentClient.execute(executable!, { rail: "fake", paymentMethodRef: "pm_test" });
    expect(executed.status).toBe("EXECUTED");

    const receipt = await agentClient.verify(decision.authorization_id);
    expect(receipt.status).toBe("EXECUTED");
    expect(receipt.authorization_id).toBe(decision.authorization_id);
  });

  it("a DENYing decision cannot be executed -- asExecutable() returns null, execute() never called", async () => {
    const { agent, mandate, principalId, agentClient } = await setUpAuthenticatedMandate();

    const decision = await agentClient.authorize({
      agent_id: agent.agent_id,
      principal_id: principalId,
      mandate_id: mandate.mandate_id,
      action: {
        amount: toMinorUnits(999, "USD"),
        currency: "USD",
        merchant: { domain: "staples.com" },
        attestations: {},
      },
    });
    expect(decision.decision).toBe("DENY");
    expect(asExecutable(decision)).toBeNull();
  });

  it("a step-up decision is approved through the SDK and becomes executable", async () => {
    // The "procurement-demo" fixture (fixtures/compiler/procurement.json):
    // "Ask me before spending more than $150" produces STEP_UP at $203 --
    // above the step-up threshold, but not a hard DENY the way
    // PROCUREMENT_STRICT's "Never spend more than $150" is.
    const instruction =
      "You may spend $500 per month on office supplies. Amazon and Staples are approved. Ask me before spending more than $150 in a single transaction. Ask me before buying from another merchant.";

    const agent = await orgClient.createAgent({ name: "sdk step-up bot" });
    const compiled = await orgClient.compileMandate({ instruction });
    if (compiled.status !== "compiled") throw new Error("expected the fixture instruction to compile");

    const principalId = `prin_sdk_stepup_${Date.now()}`;
    const mandate = await orgClient.createMandate({
      principal_id: principalId,
      agent_ids: [agent.agent_id],
      policy: compiled.policy,
      intent_text: instruction,
    });

    const authenticator = createVirtualAuthenticator();
    const registerOptions = await orgClient.getMandateAuthenticationOptions(mandate.mandate_id);
    await orgClient.verifyMandateAuthentication(mandate.mandate_id, {
      mode: "register",
      challenge: registerOptions.challenge,
      response: buildRegistrationResponse({
        authenticator,
        rpId: registerOptions.rp_id,
        origin: registerOptions.origin,
        challenge: registerOptions.challenge,
      }),
    });
    const authOptions = await orgClient.getMandateAuthenticationOptions(mandate.mandate_id);
    await orgClient.verifyMandateAuthentication(mandate.mandate_id, {
      mode: "authenticate",
      challenge: authOptions.challenge,
      response: buildAuthenticationResponse({
        authenticator,
        rpId: authOptions.rp_id,
        origin: authOptions.origin,
        challenge: authOptions.challenge,
      }),
    });

    const key = await orgClient.createAgentKey(agent.agent_id, { name: "sdk step-up key" });
    const agentClient = new Waysafe({ baseUrl, apiKey: key.api_key });

    const decision = await agentClient.authorize({
      agent_id: agent.agent_id,
      principal_id: principalId,
      mandate_id: mandate.mandate_id,
      action: {
        amount: toMinorUnits(203, "USD"),
        currency: "USD",
        merchant: { domain: "staples.com" },
        category: "office_supplies",
        attestations: {},
      },
    });
    expect(decision.decision).toBe("STEP_UP");
    expect(decision.step_up).not.toBeNull();
    expect(decision.step_up!.authorization_id).toBe(decision.authorization_id);
    expect(asExecutable(decision)).toBeNull();

    const approved = await agentClient.approveStepUp(decision.authorization_id);
    expect(approved.status).toBe("STEP_UP_APPROVED");
    expect(asExecutable(approved)).not.toBeNull();
  });

  it("THE ATTACK: authorizing against a mandate id from a different organization throws NoActiveMandateError, not someone else's decision", async () => {
    const otherOrgKey = (
      await repos.agentKeys.createKey({ organizationId: "org_sdk_other", name: "other org" }, new Date())
    ).fullKey;
    const otherOrgClient = new Waysafe({ baseUrl, apiKey: otherOrgKey });
    const { mandate: victimMandate } = await setUpAuthenticatedMandate();

    const otherAgent = await otherOrgClient.createAgent({ name: "attacker bot" });
    const otherKey = await otherOrgClient.createAgentKey(otherAgent.agent_id, { name: "attacker key" });
    const attackerClient = new Waysafe({ baseUrl, apiKey: otherKey.api_key });

    await expect(
      attackerClient.authorize({
        agent_id: otherAgent.agent_id,
        principal_id: "prin_doesnt_matter",
        mandate_id: victimMandate.mandate_id,
        action: {
          amount: toMinorUnits(10, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          attestations: {},
        },
      }),
    ).rejects.toBeInstanceOf(NoActiveMandateError);
  });

  it("dashboard reads round-trip real wire JSON: mandates, authorizations, agents, keys, evidence, reason codes", async () => {
    const { agent, mandate, principalId, agentClient } = await setUpAuthenticatedMandate();
    const decision = await agentClient.authorize({
      agent_id: agent.agent_id,
      principal_id: principalId,
      mandate_id: mandate.mandate_id,
      action: {
        amount: toMinorUnits(15, "USD"),
        currency: "USD",
        merchant: { domain: "staples.com" },
        attestations: {},
      },
    });

    const mandates = await orgClient.listMandates({ limit: 100 });
    expect(mandates.some((m) => m.mandate_id === mandate.mandate_id)).toBe(true);

    const detail = await orgClient.getMandate(mandate.mandate_id);
    expect(detail.agent_ids).toContain(agent.agent_id);
    expect(detail.policy.schema_version).toBe("waysafe.policy/v1");

    const authorizations = await orgClient.listAuthorizations({ limit: 100 });
    expect(authorizations.some((a) => a.authorization_id === decision.authorization_id)).toBe(true);

    const agents = await orgClient.listAgents();
    expect(agents.some((a) => a.agent_id === agent.agent_id)).toBe(true);

    const keys = await orgClient.listKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.prefix).toBeDefined();

    // D-35: getInstrument's wire shape round-trips real JSON too, not just
    // a mocked fetch's fixture.
    const instrument = await repos.instruments.createInstrument(
      { organizationId: ORG, mandateId: mandate.mandate_id, rail: "stripe_issuing", externalRef: "ic_test_sdk_integration_9999" },
      new Date(),
    );
    const instrumentDetail = await orgClient.getInstrument(instrument.id);
    expect(instrumentDetail.instrument_id).toBe(instrument.id);
    expect(instrumentDetail.mandate_id).toBe(mandate.mandate_id);
    expect(instrumentDetail.rail).toBe("stripe_issuing");
    expect(instrumentDetail.external_ref).toBe("ic_test_sdk_integration_9999");

    // "mandate.authenticated" is recorded against the mandate *version*
    // (subject_type "mandate_version"), not the mandate itself.
    const evidence = await orgClient.listEvidence({ subject: mandate.mandate_version_id });
    expect(evidence.some((e) => e.type === "mandate.authenticated")).toBe(true);
    expect(evidence.every((e) => typeof e.signature === "string" && e.signature.length > 0)).toBe(true);

    const chain = await orgClient.verifyEvidenceChain();
    expect(chain).toEqual({ ok: true, signed: true });

    const reasonCodes = await orgClient.listReasonCodes();
    expect(reasonCodes.some((r) => r.code === "ALLOW_WITHIN_MANDATE")).toBe(true);
  });

  it("D-26/OQ-8: the full chain verifies independently, using nothing but listEvidence() + getEvidencePublicKey() -- no trust in this server's own /v1/evidence/verify judgment", async () => {
    await setUpAuthenticatedMandate();

    const [allEvidence, publicKey] = await Promise.all([
      orgClient.listEvidence(),
      orgClient.getEvidencePublicKey(),
    ]);
    expect(allEvidence.length).toBeGreaterThan(0);
    expect(publicKey.algorithm).toBe("Ed25519");

    const result = verifyEvidenceIndependently(allEvidence, publicKey.public_key);
    expect(result).toEqual({ ok: true, signed: true });

    // D-52: the same real chain also verifies through the key-directory
    // path -- every event this server just wrote carries a real key_id,
    // and it round-trips against the directory entry of the same name.
    expect(publicKey.key_directory).toBeDefined();
    expect(allEvidence.every((e) => typeof e.key_id === "string")).toBe(true);
    const directoryResult = verifyEvidenceIndependently(allEvidence, publicKey.public_key, publicKey.key_directory);
    expect(directoryResult).toEqual({ ok: true, signed: true });
  });

  it("THE ATTACK: verifyEvidenceIndependently catches a tampered payload fetched from the real API, entirely locally", async () => {
    await setUpAuthenticatedMandate();
    const [events, publicKey] = await Promise.all([
      orgClient.listEvidence(),
      orgClient.getEvidencePublicKey(),
    ]);
    expect(events.length).toBeGreaterThan(0);

    // A real event, actually fetched over HTTP -- then tampered with after
    // the fact, the way a compromised database (not this SDK) would produce
    // one. The hash isn't recomputed, same as evidence.test.ts's simplest
    // tamper case; the "full chain rewrite" that recomputes hashes
    // consistently is proven once, thoroughly, in
    // @waysafe/core's evidence.test.ts -- this test's job is only to prove the
    // SDK's local verification wires up correctly against real server data.
    const tampered = events.map((e) => ({ ...e }));
    tampered[0]!.payload = { tampered: true };

    const result = verifyEvidenceIndependently(tampered, publicKey.public_key);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
  });
});
