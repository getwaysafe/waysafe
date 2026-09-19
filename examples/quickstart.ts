#!/usr/bin/env -S npx tsx
/**
 * The Waysafe quickstart. This is a program, not documentation -- run it:
 *
 *   npx tsx examples/quickstart.ts
 *
 * With no configuration, it starts its own local Waysafe API (in-memory,
 * no database, no Anthropic key) and runs against that -- clone the repo and
 * this just works, no setup. That's deliberate: if getting to a first
 * decision takes more than an hour, the SDK is wrong, not these docs.
 *
 * To run it against a real, already-running Waysafe deployment and your
 * own key instead, set:
 *
 *   WAYSAFE_BASE_URL=https://api.your-waysafe-deployment.example
 *   WAYSAFE_API_KEY=wsf_live_...          # an org credential
 *
 * Everything below this point uses only `@waysafe/sdk` -- no raw `fetch`,
 * no hand-built request bodies. If you find yourself wanting to reach past
 * the SDK for something in this file, that's a bug in the SDK, not a gap
 * this script should route around.
 */

import {
  Waysafe,
  WaysafeError,
  StepUpResolutionRejectedError,
  asExecutable,
  verifyEvidenceIndependently,
  type AuthorizationDecision,
} from "@waysafe/sdk";

const SELF_HOSTED = !process.env.WAYSAFE_BASE_URL && !process.env.WAYSAFE_API_KEY;

/** Set once `main()` connects, so the top-level runner can shut down the
 * self-hosted server (if any) whether the script finishes or throws --
 * otherwise its open TCP listener keeps the process alive forever. */
let closeServer: () => Promise<void> = async () => {};

const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const ok = (s: string) => `\x1b[32m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;

/**
 * Only reachable in self-hosted mode. Boots a real Waysafe API in-process
 * (in-memory repositories, the deterministic fixture compiler so this runs
 * with no ANTHROPIC_API_KEY, a small seeded merchant directory so a
 * domain-only assertion for "staples.com" resolves VERIFIED) and mints the
 * one org credential every developer needs to get started.
 *
 * A real deployment doesn't have this step: an operator hands you your org
 * credential out of band, the same way you'd get a first API key from any
 * platform's dashboard. This block exists purely so the quickstart runs
 * with zero setup -- it is not part of the SDK and nothing past this
 * function touches it again.
 */
async function startLocalServerAndMintOrgCredential(): Promise<{
  baseUrl: string;
  apiKey: string;
  close: () => Promise<void>;
}> {
  const { buildServer } = await import("../apps/api/src/server.js");
  const { InMemoryAgentKeyRepository } = await import("../apps/api/src/agent-keys/in-memory-repository.js");
  const { InMemoryAuthorizationRepository } = await import(
    "../apps/api/src/authorization/in-memory-repository.js"
  );
  const { InMemoryEvidenceRepository } = await import("../apps/api/src/evidence/in-memory-repository.js");
  const { InMemoryPrincipalRepository } = await import("../apps/api/src/principals/in-memory-repository.js");
  const { InMemoryInstrumentRepository } = await import("../apps/api/src/instruments/in-memory-repository.js");
  const { InMemoryWebauthnRepository } = await import("../apps/api/src/webauthn/in-memory-repository.js");
  const { InMemoryProviderEventRepository } = await import("../apps/api/src/webhooks/in-memory-repository.js");
  const { FakeAdapter } = await import("../apps/api/src/execution/test-support/fake-adapter.js");
  const { createStaticDirectory, FixtureIntentCompiler, generateEvidenceSigningKeyPair, loadCompilerFixtures } =
    await import("@waysafe/core");

  const agentKeys = new InMemoryAgentKeyRepository();
  const app = buildServer({
    logger: false,
    compiler: new FixtureIntentCompiler(loadCompilerFixtures()),
    repos: {
      authorization: new InMemoryAuthorizationRepository(
        createStaticDirectory([
          { domain: "staples.com", display_name: "Staples" },
          { domain: "amazon.com", display_name: "Amazon" },
          { domain: "bestbuy.com", display_name: "Best Buy" },
        ]),
      ),
      agentKeys,
      evidence: new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey),
      webauthn: new InMemoryWebauthnRepository(),
      providerEvents: new InMemoryProviderEventRepository(),
      principals: new InMemoryPrincipalRepository(),
      instruments: new InMemoryInstrumentRepository(),
    },
    webauthnConfig: { rpId: "localhost", origin: "http://localhost:3000" },
    adapters: { demo_rail: new FakeAdapter({ providerFee: 25 }) },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");

  const org = await agentKeys.createKey({ organizationId: "org_quickstart", name: "quickstart org credential" }, new Date());

  console.log(dim(`  started a local Waysafe API on 127.0.0.1:${address.port} (in-memory, no database)`));
  return { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: org.fullKey, close: () => app.close() };
}

/**
 * Only reachable in self-hosted mode: simulates the principal's passkey so
 * this script can run end to end with no browser attached. Your own
 * integration replaces this entire function with your frontend calling
 * `navigator.credentials.create()` / `.get()` (or `@simplewebauthn/browser`)
 * against the `challenge`/`rp_id`/`origin` that `getMandateAuthenticationOptions`
 * returns, then posting the result to `verifyMandateAuthentication` -- the
 * SDK calls either side of that gap identically regardless of what produced
 * the response (I-10: it never depends on a specific WebAuthn library).
 */
async function authenticateMandateWithASimulatedPasskey(waysafe: Waysafe, mandateId: string): Promise<void> {
  const {
    createVirtualAuthenticator,
    buildRegistrationResponse,
    buildAuthenticationResponse,
  } = await import("../apps/api/src/webauthn/test-support/virtual-authenticator.js");
  const authenticator = createVirtualAuthenticator();

  const registerOptions = await waysafe.getMandateAuthenticationOptions(mandateId);
  await waysafe.verifyMandateAuthentication(mandateId, {
    mode: "register",
    challenge: registerOptions.challenge,
    response: buildRegistrationResponse({
      authenticator,
      rpId: registerOptions.rp_id,
      origin: registerOptions.origin,
      challenge: registerOptions.challenge,
    }),
  });

  const authOptions = await waysafe.getMandateAuthenticationOptions(mandateId);
  const result = await waysafe.verifyMandateAuthentication(mandateId, {
    mode: "authenticate",
    challenge: authOptions.challenge,
    response: buildAuthenticationResponse({
      authenticator,
      rpId: authOptions.rp_id,
      origin: authOptions.origin,
      challenge: authOptions.challenge,
    }),
  });
  if (result.kind !== "activated") throw new Error(`expected the mandate to activate, got: ${JSON.stringify(result)}`);
}

/**
 * Silent setup, same pattern as authenticateMandateWithASimulatedPasskey
 * just above: registers a second, independent mandate that will act as
 * the first mandate's approver (D-62). Nothing about creating or
 * authenticating an approver mandate is special -- it's an ordinary
 * mandate, the same ceremony as any other; what makes it an approver is
 * being named in another mandate's escalation.approvers, set once at
 * mandate creation (non-negotiable #5: that's a policy field like any
 * other). Prints nothing of its own, so it doesn't appear between
 * quickstart's own numbered sections.
 */
async function registerApproverMandate(
  org: Waysafe,
  baseUrl: string,
): Promise<{ mandateId: string; agentId: string; principalId: string; client: Waysafe }> {
  const { POLICY_SCHEMA_VERSION } = await import("@waysafe/core");
  const agent = await org.createAgent({ name: "quickstart approver bot" });
  const principal = await org.createPrincipal({ display_name: "Quickstart Approver Principal" });
  const mandate = await org.createMandate({
    principal_id: principal.principal_id,
    agent_ids: [agent.agent_id],
    policy: {
      schema_version: POLICY_SCHEMA_VERSION,
      summary: "Approver: may authorize up to $2,000/month, any merchant this mandate is asked about.",
      currency: "USD",
      per_transaction_max: 200000, // $2,000.00
      cumulative_limits: [{ window: "month", max_amount: 200000 }],
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      categories: { allow: [], deny: [], unlisted: "ALLOW" },
      step_up: { ttl_seconds: 900 },
      accounting: {},
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    intent_text: "approver mandate for the quickstart demo",
  });
  await authenticateMandateWithASimulatedPasskey(org, mandate.mandate_id);
  const key = await org.createAgentKey(agent.agent_id, { name: "quickstart approver key" });
  return {
    mandateId: mandate.mandate_id,
    agentId: agent.agent_id,
    principalId: principal.principal_id,
    client: new Waysafe({ baseUrl, apiKey: key.api_key }),
  };
}

function printDecision(decision: AuthorizationDecision): void {
  console.log(`  ${dim("decision:")} ${decision.decision}  ${dim("status:")} ${decision.status}`);
  for (const reason of decision.reasons) {
    console.log(`  ${dim("  -")} ${reason.code}: ${reason.message}`);
  }
}

async function main() {
  section("1. Connect");
  const { baseUrl, apiKey, close } = SELF_HOSTED
    ? await startLocalServerAndMintOrgCredential()
    : {
        baseUrl: process.env.WAYSAFE_BASE_URL!,
        apiKey: process.env.WAYSAFE_API_KEY!,
        close: async () => {},
      };
  closeServer = close;
  const org = new Waysafe({ baseUrl, apiKey });
  console.log(`  ${ok("connected")} to ${baseUrl}`);

  // Silent setup for section 6 below -- see registerApproverMandate's own
  // doc comment for why this prints nothing here.
  const approver = await registerApproverMandate(org, baseUrl);

  section("2. Compile a natural-language instruction into a policy");
  const instruction =
    "You may spend $500 per month on office supplies. Amazon and Staples are approved. " +
    "Never spend more than $150 in a single transaction. Ask me before buying from another merchant.";
  const compiled = await org.compileMandate({ instruction });
  if (compiled.status === "needs_clarification") {
    console.log(warn("  the compiler wants more detail -- inspect compiled.clarifications and re-ask."));
    return;
  }
  console.log(`  ${dim("summary:")} ${compiled.confirmation.summary}`);
  for (const assumption of compiled.confirmation.assumptions) {
    console.log(`  ${dim("assumption:")} ${assumption}`);
  }

  section("3. Register an agent, and create + authenticate a mandate for it");
  const agent = await org.createAgent({ name: "quickstart procurement bot" });
  const principal = await org.createPrincipal({ display_name: "Quickstart Demo Principal" });
  const principalId = principal.principal_id;
  const mandate = await org.createMandate({
    principal_id: principalId,
    agent_ids: [agent.agent_id],
    // escalation.approvers names the approver mandate registered silently
    // above -- see section 6. Setting it is an ordinary part of this
    // mandate's policy, signed by the same WebAuthn ceremony just below
    // (D-62: no separate enrollment step).
    policy: { ...compiled.policy, escalation: { approvers: [approver.mandateId] } },
    intent_text: instruction,
  });
  console.log(`  ${dim("mandate:")} ${mandate.mandate_id} (${mandate.status})`);

  // In your own integration, this authentication step happens in the
  // principal's browser, not your backend -- see the function's own doc
  // comment. The mandate is not usable by authorize() until this completes.
  await authenticateMandateWithASimulatedPasskey(org, mandate.mandate_id);
  console.log(`  ${ok("authenticated")} -- the mandate is now ACTIVE`);

  const key = await org.createAgentKey(agent.agent_id, { name: "quickstart demo key" });
  const agentClient = new Waysafe({ baseUrl, apiKey: key.api_key });
  console.log(`  ${dim("agent key minted:")} ${key.prefix}...  ${dim("(shown once -- store it now)")}`);

  section("4. Ask permission for a purchase that's clearly within the mandate");
  const smallPurchase = await agentClient.authorize({
    agent_id: agent.agent_id,
    principal_id: principalId,
    mandate_id: mandate.mandate_id,
    action: {
      amount: 4200, // $42.00, integer minor units -- never a decimal
      currency: "USD",
      merchant: { domain: "staples.com" },
      category: "office_supplies",
      attestations: {},
    },
  });
  printDecision(smallPurchase);

  const executable = asExecutable(smallPurchase);
  if (executable) {
    section("5. Execute it against a payment rail");
    const executed = await agentClient.execute(executable, { rail: "demo_rail", paymentMethodRef: "pm_demo" });
    console.log(`  ${ok("executed")} -- status is now ${executed.status}`);

    const receipt = await agentClient.verify(executed.authorization_id);
    console.log(`  ${dim("verified receipt:")} ${receipt.authorization_id} -- ${receipt.status}`);
  }

  section("6. A merchant not on the mandate's allowlist -- STEP_UP, resolved by a real approver mandate (D-62)");
  const unlistedMerchantPurchase = await agentClient.authorize({
    agent_id: agent.agent_id,
    principal_id: principalId,
    mandate_id: mandate.mandate_id,
    action: {
      amount: 8700, // $87.00 -- well under the hard cap; it's the merchant, not the amount
      currency: "USD",
      merchant: { domain: "bestbuy.com" },
      category: "office_supplies",
      attestations: {},
    },
  });
  printDecision(unlistedMerchantPurchase);

  if (unlistedMerchantPurchase.step_up) {
    // I-10: `step_up` is just `{ authorization_id, expires_at }` -- no
    // hosted page. Show the receipt in your own approval UI, then call
    // resolveStepUp naming which approver mandate is deciding.
    console.log(dim(`  step-up pending, expires ${unlistedMerchantPurchase.step_up.expires_at}`));

    // D-59/D-62: the same agent that triggered the step-up cannot resolve
    // its own escalation. This is the exact hole D-59 named -- closed here,
    // not just documented.
    try {
      await agentClient.resolveStepUp(unlistedMerchantPurchase.step_up.authorization_id, {
        agentId: agent.agent_id,
        principalId,
      });
      throw new Error("expected self-approval to be rejected");
    } catch (error) {
      if (!(error instanceof StepUpResolutionRejectedError)) throw error;
      console.log(`  ${warn("rejected")} -- an agent cannot resolve its own step-up: ${error.reasons[0]?.code}`);
    }

    // A real approver: a different mandate, its own policy, its own
    // passkey enrollment. evaluate() runs again, against ITS bounds.
    const approved = await approver.client.resolveStepUp(unlistedMerchantPurchase.step_up.authorization_id, {
      agentId: approver.agentId,
      principalId: approver.principalId,
      mandateId: approver.mandateId,
    });
    console.log(`  ${ok("approved")} by the approver mandate -- status is now ${approved.status}`);

    const nowExecutable = asExecutable(approved);
    if (nowExecutable) {
      const executed = await agentClient.execute(nowExecutable, { rail: "demo_rail", paymentMethodRef: "pm_demo" });
      console.log(`  ${ok("executed")} -- status is now ${executed.status}`);
    }
  }

  section("7. A purchase over the hard cap -- DENY. This is a normal return value, not a thrown error");
  const overCap = await agentClient.authorize({
    agent_id: agent.agent_id,
    principal_id: principalId,
    mandate_id: mandate.mandate_id,
    action: {
      amount: 20300, // $203.00 -- over the $150 per-transaction ceiling
      currency: "USD",
      merchant: { domain: "staples.com" },
      category: "office_supplies",
      attestations: {},
    },
  });
  printDecision(overCap);
  console.log(`  ${dim("asExecutable() on a DENY:")} ${asExecutable(overCap)}`);

  section("8. Try to authorize with something malformed -- the SDK throws a typed error, not a generic one");
  try {
    // @ts-expect-error -- deliberately missing `action.currency` to show the
    // typed error path; a real caller wouldn't get past the type checker here.
    await agentClient.authorize({ agent_id: agent.agent_id, principal_id: principalId, action: { amount: 100 } });
  } catch (error) {
    if (error instanceof WaysafeError) {
      console.log(`  ${dim(error.constructor.name + ":")} ${error.message}`);
    } else {
      throw error;
    }
  }

  section("9. The same data your dashboard shows, read straight through the SDK");
  const [mandates, authorizations, agents, keys, evidence, chain] = await Promise.all([
    org.listMandates({ limit: 5 }),
    org.listAuthorizations({ limit: 5 }),
    org.listAgents(),
    org.listKeys(),
    org.listEvidence(),
    org.verifyEvidenceChain(),
  ]);
  console.log(`  ${dim("mandates:")} ${mandates.length}  ${dim("authorizations:")} ${authorizations.length}`);
  console.log(`  ${dim("agents:")} ${agents.length}  ${dim("keys:")} ${keys.length}`);
  console.log(`  ${dim("evidence events:")} ${evidence.length}  ${dim("chain verifies:")} ${chain.ok} (signed: ${chain.signed ?? false})`);

  section("10. Verify the evidence chain yourself -- no trust in this server's own judgment required");
  // This is the point of signing (D-26/OQ-8): a third party -- an auditor,
  // the principal, anyone -- can check every event's signature themselves,
  // in their own process, using only the published public key. They never
  // have to take this server's "ok: true" on faith.
  const publicKey = await org.getEvidencePublicKey();
  const independentResult = verifyEvidenceIndependently(evidence, publicKey.public_key);
  console.log(`  ${dim("public key:")} ${publicKey.public_key}`);
  console.log(`  ${dim("verified independently, locally, no server trust:")} ${JSON.stringify(independentResult)}`);

  section("Done");
  console.log("  You just compiled a policy, created and authenticated a mandate, asked permission");
  console.log("  for four purchases (an ALLOW, a step-up resolved by a real approver mandate after a");
  console.log("  rejected self-approval attempt, and a DENY), executed two of them, and read back and");
  console.log("  independently verified the signed evidence chain -- entirely through @waysafe/sdk.");
  console.log("  See apps/dashboard for the same data in a UI.\n");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeServer());
