#!/usr/bin/env -S npx tsx
/**
 * The Waysafe demo (Week 6). One scripted, watchable run:
 *
 *   npx tsx examples/demo.ts
 *
 * or, from the repo root:
 *
 *   npm run demo
 *
 * Tells one story end to end: a plain-English instruction becomes an
 * enforceable policy, a principal authenticates it with a passkey, an agent
 * makes four attempts against it -- an ordinary purchase (ALLOW), one over
 * the spending limit (DENY), a real merchant that just isn't pre-approved
 * (STEP_UP, a human approves it live), and a merchant the agent can't
 * actually prove is who it claims (STEP_UP, a human declines it live) --
 * and closes by verifying the signed evidence chain independently, the way
 * a third party who doesn't trust this server would.
 *
 * Two things make this genuinely runnable with one command against a fresh
 * database, not just in the best case:
 *
 *  - If DATABASE_URL is set, this runs against real Postgres -- the same
 *    Prisma repositories apps/api/src/index.ts uses in production, not a
 *    simulation of them. Every run mints a fresh, uniquely-suffixed
 *    organization, so re-running this against a database that already has
 *    prior demo runs in it never collides with them. If it's unset, this
 *    falls back to the same zero-config in-memory bootstrap
 *    examples/quickstart.ts uses, so the demo still runs with nothing
 *    configured at all.
 *  - The two step-up moments pause for a real keypress -- "a real human
 *    approval" is not a euphemism for calling approveStepUp() on a timer.
 *    Run this at a terminal, not piped or redirected, so stdin is a TTY;
 *    without one, it auto-decides (documented at the prompt itself) rather
 *    than hanging forever, so a CI run or a accidental pipe doesn't stall.
 *
 * The instruction is compiled with the same deterministic fixture compiler
 * examples/quickstart.ts uses (no ANTHROPIC_API_KEY needed), so every run
 * tells the identical, reliable story -- see apps/api/src/cli.ts for
 * compiling your own instructions against the real model instead.
 */

import { createInterface } from "node:readline/promises";
import { Waysafe, asExecutable, verifyEvidenceIndependently } from "@waysafe/sdk";

const section = (title: string) => console.log(`\n\x1b[1m\x1b[36m${title}\x1b[0m`);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const ok = (s: string) => `\x1b[32m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A real pause, not a cosmetic one -- gives a live audience a moment to
 * read what just happened before the next beat starts. */
async function beat(ms = 900): Promise<void> {
  await sleep(ms);
}

/**
 * Blocks on real keyboard input when one is available. Without a TTY (CI,
 * a pipe, `< /dev/null`), auto-decides after saying so out loud -- a demo
 * script that just hangs forever in a non-interactive run is worse than
 * one that makes an documented, visible default choice.
 */
async function askYesNo(question: string, autoAnswerIfNoTTY: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(
      warn(
        `  (no interactive terminal attached -- auto-${autoAnswerIfNoTTY ? "approving" : "declining"} so this run doesn't hang)`,
      ),
    );
    return autoAnswerIfNoTTY;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${bold(question)} [y/N] `);
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

let closeServer: () => Promise<void> = async () => {};

/**
 * Real Postgres when DATABASE_URL is configured (the same Prisma
 * repositories, and the same evidence-signing-key loading, apps/api's own
 * entrypoint uses); the zero-config in-memory bootstrap otherwise. Either
 * way, a real Fastify server, listening on a real local port, driven only
 * through @waysafe/sdk from here on -- this file never imports the server's
 * internals for anything except constructing this one, honest exception.
 */
async function startServer(): Promise<{
  baseUrl: string;
  apiKey: string;
  usingRealDatabase: boolean;
  ensurePrincipal: (principalId: string) => Promise<void>;
}> {
  const { buildServer } = await import("../apps/api/src/server.js");
  const { InMemoryAgentKeyRepository } = await import("../apps/api/src/agent-keys/in-memory-repository.js");
  const { InMemoryAuthorizationRepository } = await import(
    "../apps/api/src/authorization/in-memory-repository.js"
  );
  const { InMemoryEvidenceRepository } = await import("../apps/api/src/evidence/in-memory-repository.js");
  const { InMemoryWebauthnRepository } = await import("../apps/api/src/webauthn/in-memory-repository.js");
  const { InMemoryProviderEventRepository } = await import("../apps/api/src/webhooks/in-memory-repository.js");
  const { FakeAdapter } = await import("../apps/api/src/execution/test-support/fake-adapter.js");
  const { loadOrGenerateEvidenceSigningKey } = await import("../apps/api/src/evidence/signing-key.js");
  const { createStaticDirectory, FixtureIntentCompiler, loadCompilerFixtures } = await import("@waysafe/core");

  const directory = createStaticDirectory([
    { domain: "staples.com", display_name: "Staples" },
    { domain: "amazon.com", display_name: "Amazon" },
    { domain: "bestbuy.com", display_name: "Best Buy" },
  ]);
  const adapters = { demo_rail: new FakeAdapter({ providerFee: 25 }) };
  const compiler = new FixtureIntentCompiler(loadCompilerFixtures());

  let agentKeys: InstanceType<typeof InMemoryAgentKeyRepository>;
  let app: ReturnType<typeof buildServer>;
  let usingRealDatabase = false;
  // No-op for the in-memory repositories (no foreign keys to satisfy); on
  // real Postgres, seeds the Principal row createMandate's FK requires --
  // there is no public API route that creates one (see DECISIONS.md OQ-9),
  // so this mirrors exactly what the Prisma test suites already do by hand.
  let ensurePrincipal: (principalId: string) => Promise<void> = async () => {};

  // A fresh organization every run -- the "against a fresh database" half
  // of this file's promise. Re-running this against a real, already-used
  // Postgres database never collides with a previous run's data.
  const organizationId = `org_demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (process.env.DATABASE_URL) {
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaAgentKeyRepository } = await import("../apps/api/src/agent-keys/prisma-repository.js");
    const { PrismaAuthorizationRepository } = await import(
      "../apps/api/src/authorization/prisma-repository.js"
    );
    const { PrismaEvidenceRepository } = await import("../apps/api/src/evidence/prisma-repository.js");
    const { PrismaWebauthnRepository } = await import("../apps/api/src/webauthn/prisma-repository.js");
    const { PrismaProviderEventRepository } = await import("../apps/api/src/webhooks/prisma-repository.js");

    const prisma = new PrismaClient();
    // The parent Organization row a real database's foreign keys require --
    // the in-memory repositories have no such constraint, so this step only
    // exists on this branch.
    await prisma.organization.create({ data: { id: organizationId, name: "Demo Org" } });
    ensurePrincipal = async (principalId: string) => {
      await prisma.principal.create({
        data: { id: principalId, organizationId, displayName: "Demo Principal" },
      });
    };

    const signingKey = loadOrGenerateEvidenceSigningKey((msg) => console.warn(`  ${warn(msg)}`));
    const prismaAgentKeys = new PrismaAgentKeyRepository(prisma);
    agentKeys = prismaAgentKeys as unknown as InstanceType<typeof InMemoryAgentKeyRepository>;
    app = buildServer({
      logger: false,
      compiler,
      repos: {
        authorization: new PrismaAuthorizationRepository(prisma, directory),
        agentKeys: prismaAgentKeys,
        evidence: new PrismaEvidenceRepository(prisma, signingKey),
        webauthn: new PrismaWebauthnRepository(prisma),
        providerEvents: new PrismaProviderEventRepository(prisma),
      },
      webauthnConfig: { rpId: "localhost", origin: "http://localhost:3000" },
      adapters,
    });
    usingRealDatabase = true;
    closeServer = async () => {
      await app.close();
      await prisma.$disconnect();
    };
  } else {
    const inMemoryAgentKeys = new InMemoryAgentKeyRepository();
    agentKeys = inMemoryAgentKeys;
    app = buildServer({
      logger: false,
      compiler,
      repos: {
        authorization: new InMemoryAuthorizationRepository(directory),
        agentKeys: inMemoryAgentKeys,
        evidence: new InMemoryEvidenceRepository(loadOrGenerateEvidenceSigningKey()),
        webauthn: new InMemoryWebauthnRepository(),
        providerEvents: new InMemoryProviderEventRepository(),
      },
      webauthnConfig: { rpId: "localhost", origin: "http://localhost:3000" },
      adapters,
    });
    closeServer = () => app.close();
  }

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");

  const org = await agentKeys.createKey({ organizationId, name: "demo org credential" }, new Date());

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: org.fullKey,
    usingRealDatabase,
    ensurePrincipal,
  };
}

function printDecision(label: string, decision: Awaited<ReturnType<Waysafe["authorize"]>>): void {
  console.log(`  ${dim(label)}`);
  console.log(`  decision: ${bold(decision.decision)}   status: ${bold(decision.status)}`);
  for (const reason of decision.reasons) {
    console.log(`    ${dim("-")} ${reason.code}: ${reason.message}`);
  }
  console.log(
    `  merchant: trust=${decision.merchant.trust}, refs=${JSON.stringify(decision.merchant.refs)}`,
  );
}

async function main() {
  console.log(bold("\n=== Waysafe: instruction to verifiable receipt ===\n"));

  section("1. Connect");
  const { baseUrl, apiKey, usingRealDatabase, ensurePrincipal } = await startServer();
  const org = new Waysafe({ baseUrl, apiKey });
  console.log(
    `  ${ok("connected")} to ${baseUrl} (${usingRealDatabase ? "real Postgres" : "in-memory, no database configured"})`,
  );
  await beat();

  section("2. The instruction, in the principal's own words");
  const instruction =
    "You may spend $500 per month on office supplies. Amazon and Staples are approved. " +
    "Never spend more than $150 in a single transaction. Ask me before buying from another merchant.";
  console.log(`  "${instruction}"`);
  await beat();

  const compiled = await org.compileMandate({ instruction });
  if (compiled.status !== "compiled") throw new Error("expected the fixture instruction to compile");
  console.log(`\n  ${dim("compiled policy:")} ${compiled.confirmation.summary}`);
  for (const assumption of compiled.confirmation.assumptions) {
    console.log(`  ${dim("assumption:")} ${assumption}`);
  }
  await beat(1200);

  section("3. The principal authenticates the policy with a passkey");
  console.log(dim("  (a real WebAuthn ceremony, run against a simulated authenticator so this"));
  console.log(dim("   demo needs no physical device -- your own integration puts a browser here"));
  console.log(dim("   calling navigator.credentials, exactly as getMandateAuthenticationOptions"));
  console.log(dim("   and verifyMandateAuthentication expect)"));
  const { createVirtualAuthenticator, buildRegistrationResponse, buildAuthenticationResponse } = await import(
    "../apps/api/src/webauthn/test-support/virtual-authenticator.js"
  );

  const agent = await org.createAgent({ name: "procurement bot" });
  const principalId = `prin_demo_${Date.now()}`;
  await ensurePrincipal(principalId);
  const mandate = await org.createMandate({
    principal_id: principalId,
    agent_ids: [agent.agent_id],
    policy: compiled.policy,
    intent_text: instruction,
  });

  const authenticator = createVirtualAuthenticator();
  const registerOptions = await org.getMandateAuthenticationOptions(mandate.mandate_id);
  await org.verifyMandateAuthentication(mandate.mandate_id, {
    mode: "register",
    challenge: registerOptions.challenge,
    response: buildRegistrationResponse({
      authenticator,
      rpId: registerOptions.rp_id,
      origin: registerOptions.origin,
      challenge: registerOptions.challenge,
    }),
  });
  const authOptions = await org.getMandateAuthenticationOptions(mandate.mandate_id);
  const authResult = await org.verifyMandateAuthentication(mandate.mandate_id, {
    mode: "authenticate",
    challenge: authOptions.challenge,
    response: buildAuthenticationResponse({
      authenticator,
      rpId: authOptions.rp_id,
      origin: authOptions.origin,
      challenge: authOptions.challenge,
    }),
  });
  if (authResult.kind !== "activated") throw new Error("expected the mandate to activate");
  console.log(`  ${ok("authenticated")} -- mandate ${mandate.mandate_id} is now ACTIVE`);

  const key = await org.createAgentKey(agent.agent_id, { name: "demo agent key" });
  const agentClient = new Waysafe({ baseUrl, apiKey: key.api_key });
  await beat(1200);

  const executed: string[] = [];

  section("4. Attempt 1 -- an ordinary purchase, well inside the mandate");
  const allow = await agentClient.authorize({
    agent_id: agent.agent_id,
    principal_id: principalId,
    mandate_id: mandate.mandate_id,
    action: {
      amount: 4200,
      currency: "USD",
      merchant: { domain: "staples.com" },
      category: "office_supplies",
      description: "Printer paper and toner",
      attestations: {},
    },
  });
  printDecision("$42.00 at staples.com", allow);
  const allowExecutable = asExecutable(allow);
  if (allowExecutable) {
    const result = await agentClient.execute(allowExecutable, { rail: "demo_rail", paymentMethodRef: "pm_demo" });
    console.log(`  ${ok("executed")} -- status is now ${result.status}`);
    executed.push(result.authorization_id);
  }
  await beat(1200);

  section("5. Attempt 2 -- over the hard per-transaction cap");
  const deny = await agentClient.authorize({
    agent_id: agent.agent_id,
    principal_id: principalId,
    mandate_id: mandate.mandate_id,
    action: {
      amount: 20300,
      currency: "USD",
      merchant: { domain: "staples.com" },
      category: "office_supplies",
      description: "A very large bulk order",
      attestations: {},
    },
  });
  printDecision("$203.00 at staples.com", deny);
  console.log(`  ${dim("This is a normal, successful return value -- not a thrown error.")}`);
  await beat(1200);

  section("6. Attempt 3 -- a real merchant, just not pre-approved (STEP_UP)");
  const stepUpLegit = await agentClient.authorize({
    agent_id: agent.agent_id,
    principal_id: principalId,
    mandate_id: mandate.mandate_id,
    action: {
      amount: 8700,
      currency: "USD",
      merchant: { domain: "bestbuy.com" },
      category: "office_supplies",
      description: "A monitor for the home office",
      attestations: {},
    },
  });
  printDecision("$87.00 at bestbuy.com", stepUpLegit);
  console.log(
    dim("  bestbuy.com is a real, verified merchant -- it's simply not on this mandate's allowlist."),
  );
  const approveLegit = await askYesNo("A verified merchant, just unlisted. Approve this step-up?", true);
  if (approveLegit) {
    const approved = await agentClient.approveStepUp(stepUpLegit.authorization_id);
    console.log(`  ${ok("approved")} -- status is now ${approved.status}`);
    const executable = asExecutable(approved);
    if (executable) {
      const result = await agentClient.execute(executable, { rail: "demo_rail", paymentMethodRef: "pm_demo" });
      console.log(`  ${ok("executed")} -- status is now ${result.status}`);
      executed.push(result.authorization_id);
    }
  } else {
    const declined = await agentClient.declineStepUp(stepUpLegit.authorization_id);
    console.log(`  ${warn("declined")} -- status is now ${declined.status}`);
  }
  await beat(1200);

  section("7. Attempt 4 -- an agent claiming to be a merchant it can't prove it is");
  const stepUpSpoof = await agentClient.authorize({
    agent_id: agent.agent_id,
    principal_id: principalId,
    mandate_id: mandate.mandate_id,
    action: {
      amount: 6500,
      currency: "USD",
      // No domain, no PSP account -- just a name. D-3's whole point: a
      // name is an assertion, not an identity. Compare merchant.trust
      // and merchant.refs here against attempt 3's above.
      merchant: { name: "Staples" },
      category: "office_supplies",
      description: '"Staples" -- no domain, no account, just the agent\'s word for it',
      attestations: {},
    },
  });
  printDecision('$65.00, merchant asserted only as "Staples" (no domain)', stepUpSpoof);
  console.log(
    warn(
      "  The agent says this is Staples. There is nothing here that actually proves that --" +
        " compare merchant.trust to attempt 3's VERIFIED.",
    ),
  );
  const approveSpoof = await askYesNo(
    "An unverifiable claim of a well-known name. Approve this step-up anyway?",
    false,
  );
  if (approveSpoof) {
    const approved = await agentClient.approveStepUp(stepUpSpoof.authorization_id);
    console.log(`  ${warn("approved")} -- status is now ${approved.status}`);
  } else {
    const declined = await agentClient.declineStepUp(stepUpSpoof.authorization_id);
    console.log(`  ${ok("declined")} -- status is now ${declined.status}. The spoofing attempt is refused.`);
  }
  await beat(1200);

  section("8. The signed receipt");
  const receiptId = executed[0];
  if (receiptId) {
    const receipt = await agentClient.verify(receiptId);
    console.log(`  ${dim("authorization:")} ${receipt.authorization_id}`);
    console.log(`  ${dim("policy hash:")} ${receipt.policy_hash}`);
    console.log(`  ${dim("status:")} ${receipt.status}`);
  }
  await beat(900);

  section("9. Verifying the evidence chain -- independently, not by asking this server to grade itself");
  const [allEvidence, publicKey, serverSideVerify] = await Promise.all([
    org.listEvidence(),
    org.getEvidencePublicKey(),
    org.verifyEvidenceChain(),
  ]);
  console.log(`  ${dim("events on this organization's chain:")} ${allEvidence.length}`);
  console.log(`  ${dim("this server's own answer:")} ${JSON.stringify(serverSideVerify)}`);

  const independent = verifyEvidenceIndependently(allEvidence, publicKey.public_key);
  console.log(
    `  ${dim("verified independently, locally, using only the public key below:")} ${JSON.stringify(independent)}`,
  );
  console.log(`  ${dim("public key:")} ${publicKey.public_key}`);
  console.log(
    independent.ok && independent.signed
      ? `\n  ${ok(bold("VERIFIED"))} -- every event on this chain is signed, and the signatures check out against a key this server never had to be trusted to hand over honestly.`
      : `\n  ${warn(bold("NOT VERIFIED"))}`,
  );

  section("Done");
  console.log("  Plain-English instruction to a signed, independently verifiable receipt --");
  console.log("  compiled, authenticated, decided four different ways, and closed out without");
  console.log("  asking anyone to take this server's word for any of it.\n");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeServer());
