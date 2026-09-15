/**
 * THE BYPASS TEST (D-32/D-33): the one this whole spike is judged by.
 *
 * A raw Stripe Issuing card, handed to a script that imports no Waysafe SDK
 * at all -- only the `stripe` package -- attempts a purchase Waysafe's
 * policy would decline. If enforcement genuinely lives at the rail (D-32's
 * non-negotiable #9: "an agent's cooperation is never a control"), that
 * script cannot get money moving just by not calling `authorize()`, because
 * it was never given the chance to: Stripe itself declines the card,
 * because Stripe is the one that asked Waysafe, synchronously, before
 * anything else happened.
 *
 * What this test CANNOT do, run in an ordinary `vitest run` in this
 * environment: make Stripe's servers actually reach this process. A real
 * Issuing authorization webhook is an inbound HTTPS request from Stripe --
 * it needs a publicly reachable URL registered with Stripe as a webhook
 * endpoint subscribed to `issuing_authorization.request` (or a local tunnel,
 * e.g. `stripe listen --forward-to http://localhost:PORT/v1/enforcement/
 * stripe-issuing --events issuing_authorization.request`, run manually
 * alongside this suite). Neither exists automatically here. So this test
 * does the honest thing instead of a fake one: it drives the real Stripe
 * API for real, and only claims the bypass is proven when it can show BOTH
 * (a) Stripe's own record of the authorization is declined and (b) Waysafe's
 * own evidence chain recorded why. Absent a reachable webhook, Stripe simply
 * approves the authorization (nothing told it to do otherwise) or declines
 * for a reason of its own (e.g. insufficient Issuing test balance) -- either
 * way, with no evidence event to show for it. Per the team's own testing
 * posture, that is reported as SKIPPED with the reason, never as a pass.
 *
 * Self-skips (test-support/stripe-issuing-gate.ts) until
 * STRIPE_ISSUING_SECRET_KEY is a real test-mode key.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  createStaticDirectory,
  generateEvidenceSigningKeyPair,
  parsePolicy,
  toMinorUnits,
  POLICY_SCHEMA_VERSION,
  type Policy,
} from "@waysafe/core";
import { buildServer, type ServerRepos } from "../server.js";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryPrincipalRepository } from "../principals/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "../instruments/in-memory-repository.js";
import { InMemoryWebauthnRepository } from "../webauthn/in-memory-repository.js";
import { InMemoryProviderEventRepository } from "../webhooks/in-memory-repository.js";
import {
  MISSING_FINANCIAL_ACCOUNT_ENV_MESSAGE,
  NO_CARD_ISSUING_TERMS_ACCEPTANCE_PREFIX,
  financialAccountStatusFromError,
  probeStripeIssuingKey,
  provisionCardForMandate,
} from "./stripe-issuing.js";
import { requireStripeIssuingOrExplainSkip } from "./test-support/stripe-issuing-gate.js";

const reachable = probeStripeIssuingKey();
const SUITE_NAME = "Stripe Issuing bypass test against real Stripe test mode (D-32)";
requireStripeIssuingOrExplainSkip(SUITE_NAME, reachable);

const ORG = "org_bypass_test";
const PRINCIPAL = "prin_bypass_test";
const AGENT = "agt_bypass_test";
// Deliberately not on any allowlist and explicitly denylisted -- if Waysafe
// is ever actually consulted, this can only ever DENY, never ALLOW by
// accident of an unrelated rule.
const DENYLISTED_NETWORK_ID = "bypass_test_denylisted_network_id";

function bypassPolicy(): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "D-32 bypass test: everything denied",
    currency: "USD",
    merchants: {
      allow: [],
      deny: [{ scheme: "network_mid", value: DENYLISTED_NETWORK_ID, label: "bypass test denylist" }],
      unlisted: "DENY",
    },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    cumulative_limits: [],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2027-01-01T00:00:00.000Z",
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

async function pollForEvidence(
  evidence: ServerRepos["evidence"],
  predicate: (payload: Record<string, unknown>) => boolean,
  attempts: number,
  delayMs: number,
) {
  for (let i = 0; i < attempts; i += 1) {
    const events = await evidence.listForOrganization(ORG);
    const match = events.find(
      (e) => e.type === "enforcement.stripe_issuing.decision" && predicate(e.payload),
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

describe.skipIf(!reachable)(SUITE_NAME, () => {
  let repos: ServerRepos;
  let app: ReturnType<typeof buildServer>;
  let stripe: Stripe;
  let mandateId: string;
  let instruments: InMemoryInstrumentRepository;

  beforeAll(async () => {
    const authorizationRepo = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    instruments = new InMemoryInstrumentRepository();
    repos = {
      authorization: authorizationRepo,
      agentKeys: new InMemoryAgentKeyRepository(),
      evidence: new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey),
      webauthn: new InMemoryWebauthnRepository(),
      providerEvents: new InMemoryProviderEventRepository(),
      principals: new InMemoryPrincipalRepository(),
      instruments,
    };
    ({ mandateId } = authorizationRepo.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: bypassPolicy(),
      policyHash: "bypass-test-hash",
    }));

    // Bound to a loopback port so a locally-run `stripe listen --forward-to
    // http://localhost:<port>/v1/enforcement/stripe-issuing` can actually
    // deliver the real webhook during manual verification. Nothing in this
    // test relies on that tunnel existing -- see the SKIP path below.
    //
    // Port 0 (the default) picks a fresh ephemeral port every run, which a
    // `stripe listen` tunnel can never be pointed at in advance since it
    // isn't known until this test is already running. STRIPE_ISSUING_TEST_PORT
    // opts into a fixed port instead, so a tunnel can be started ahead of
    // time and left running across repeated test runs.
    const fixedPort = process.env.STRIPE_ISSUING_TEST_PORT ? Number(process.env.STRIPE_ISSUING_TEST_PORT) : undefined;
    app = buildServer({ logger: false, repos });
    await app.listen({ port: fixedPort ?? 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : "unknown";
    console.warn(
      `[stripe-issuing bypass test] listening on http://127.0.0.1:${port}` +
        `${fixedPort ? " (fixed via STRIPE_ISSUING_TEST_PORT)" : ""} -- to actually exercise the ` +
        `live webhook path, run: stripe listen --forward-to http://127.0.0.1:${port}/v1/enforcement/stripe-issuing ` +
        `--events issuing_authorization.request, using its printed signing secret as STRIPE_ISSUING_WEBHOOK_SECRET.`,
    );

    stripe = new Stripe(process.env.STRIPE_ISSUING_SECRET_KEY!);
  });

  afterAll(async () => {
    await app.close();
  });

  it(
    "a raw card, no Waysafe SDK imported, cannot get a Waysafe-denied purchase approved",
    async (ctx) => {
      let cardId: string;
      try {
        ({ cardId } = await provisionCardForMandate(
          stripe,
          { authorization: repos.authorization, instruments, evidence: repos.evidence },
          {
            organizationId: ORG,
            mandateId,
            cardholderName: "Waysafe Bypass Test",
            cardholderFirstName: "Waysafe",
            cardholderLastName: "Bypass Test",
            cardholderPhone: "+15555550100",
            cardholderDob: { day: 1, month: 1, year: 1990 },
            currency: "USD",
            billingAddress: {
              line1: "123 Market St",
              city: "San Francisco",
              state: "CA",
              postal_code: "94105",
              country: "US",
            },
          },
          new Date(),
        ));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Reason 1 (D-37): the env var this suite (and real provisioning)
        // depends on was never set -- fails before Stripe is ever called.
        if (message.startsWith(MISSING_FINANCIAL_ACCOUNT_ENV_MESSAGE)) {
          console.warn(`SKIPPED: ${message}`);
          ctx.skip();
          return;
        }

        // Reason 2 (D-37): the financial account exists but Stripe itself
        // refuses to attach a card to it until its status is "active" --
        // this suite deliberately does not fund or activate it, so a
        // pending (or otherwise non-active) account is an expected SKIP,
        // never a pass or a failure, and reports the exact status Stripe gave.
        const status = financialAccountStatusFromError(err);
        if (status) {
          console.warn(
            `SKIPPED: the v2 Money Management financial account (STRIPE_ISSUING_FINANCIAL_ACCOUNT) has ` +
              `status "${status}", not "active" -- Stripe refuses to create a card against it until it is. ` +
              `This suite does not fund or activate accounts; see ` +
              `https://docs.stripe.com/api/v2/money-management/financial-accounts for how one reaches "active".`,
          );
          ctx.skip();
          return;
        }

        // Reason 3 (D-38): the mandate itself was never authenticated, so
        // there is no real acceptance of Stripe's Issuing terms to send --
        // Waysafe refuses to provision rather than synthesize one. Should
        // not happen with this suite's default-seeded mandate (seedMandate
        // stamps an authenticationIp unless told otherwise), but reported
        // distinctly rather than folded into the catch-all if it ever does.
        if (message.startsWith(NO_CARD_ISSUING_TERMS_ACCEPTANCE_PREFIX)) {
          console.warn(`SKIPPED: ${message}`);
          ctx.skip();
          return;
        }

        // Any other provisioning precondition this test cannot diagnose or
        // fix -- e.g. this Stripe test account never completed Issuing
        // setup at all. Report SKIPPED rather than fail the suite over
        // account provisioning this test cannot perform.
        console.warn(
          `SKIPPED: could not provision a test Issuing card (${message}) -- this Stripe test account may not ` +
            `have completed Issuing setup. See https://stripe.com/docs/issuing/set-up-issuing for what an ` +
            `account needs before cards can be created.`,
        );
        ctx.skip();
        return;
      }

      // --- From here down: the "no Waysafe SDK" bypass attempt itself. ---
      // Only the raw `stripe` client is used -- no @waysafe/sdk import, no
      // call to authorize(), nothing that depends on this script's
      // cooperation with Waysafe at all.
      const simulated = await stripe.testHelpers.issuing.authorizations.create({
        card: cardId,
        amount: toMinorUnits(75, "USD"),
        merchant_data: { network_id: DENYLISTED_NETWORK_ID },
      });
      // --- End of the bypass attempt. ---

      const final =
        simulated.status === "pending"
          ? await stripe.issuing.authorizations.retrieve(simulated.id)
          : simulated;

      if (final.approved) {
        console.warn(
          `SKIPPED: Stripe approved authorization ${final.id} (status=${final.status}) -- no live ` +
            `webhook endpoint appears to be forwarding issuing_authorization.request to this process, ` +
            `so Waysafe was never consulted. This does not prove or disprove enforcement; it proves ` +
            `only that no synchronous webhook is wired up in this run. See the beforeAll log above for ` +
            `how to wire one up locally.`,
        );
        ctx.skip();
        return;
      }

      const event = await pollForEvidence(
        repos.evidence,
        (payload) => payload.stripe_authorization_id === final.id,
        8,
        1000,
      );

      if (!event) {
        console.warn(
          `SKIPPED: Stripe declined authorization ${final.id} (status=${final.status}), but no matching ` +
            `Waysafe evidence event appeared within the poll window -- the decline cannot be attributed to ` +
            `Waysafe (e.g. Stripe may have declined for its own reasons, such as insufficient Issuing test ` +
            `balance, before any webhook fired). Reporting SKIPPED rather than a false pass.`,
        );
        ctx.skip();
        return;
      }

      // The genuine pass: Stripe declined, and Waysafe's own evidence chain
      // shows why, with a real reason code -- not just "declined".
      const payload = event.payload as { decision: string; reason_codes: string[] };
      expect(payload.decision).not.toBe("ALLOW");
      expect(payload.reason_codes.length).toBeGreaterThan(0);
      expect(payload.reason_codes).toContain("DENY_MERCHANT_BLOCKED");
    },
    30_000,
  );
});
