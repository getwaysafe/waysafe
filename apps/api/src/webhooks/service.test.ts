import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  createStaticDirectory,
  generateEvidenceSigningKeyPair,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  type Policy,
} from "@waysafe/core";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { authorize } from "../authorization/service.js";
import { asExecutable } from "../execution/executable.js";
import { executePayment } from "../execution/service.js";
import { FakeAdapter } from "../execution/test-support/fake-adapter.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "../instruments/in-memory-repository.js";
import { handleIssuingAuthorizationRequest, StripeIssuingAdapter } from "../enforcement/stripe-issuing.js";
import { InMemoryProviderEventRepository } from "./in-memory-repository.js";
import { handleStripeWebhook } from "./service.js";

const ORG = "org_test";
const PRINCIPAL = "prin_test";
const AGENT = "agt_test";
const NOW = new Date("2026-08-24T12:00:00.000Z");
const DIRECTORY = createStaticDirectory([{ domain: "staples.com", display_name: "Staples" }]);

function policyFrom(): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "test",
    currency: "USD",
    merchants: { allow: [{ scheme: "domain", value: "staples.com", label: "Staples" }], deny: [], unlisted: "STEP_UP" },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    cumulative_limits: [],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-09-23T12:00:00.000Z",
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

async function setupExecutedAuthorization() {
  const authorization = new InMemoryAuthorizationRepository(DIRECTORY);
  const agentKeys = new InMemoryAgentKeyRepository();
  const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
  const providerEvents = new InMemoryProviderEventRepository();
  const { mandateId } = authorization.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy: policyFrom(),
    policyHash: "hash",
  });
  const key = await agentKeys.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);

  const decided = await authorize(
    { authorization, agentKeys, evidence },
    {
      organizationId: ORG,
      request: {
        agent_id: AGENT,
        principal_id: PRINCIPAL,
        mandate_id: mandateId,
        action: { amount: toMinorUnits(83, "USD"), currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
        context: {},
      },
      now: NOW,
      apiKey: key.fullKey,
    },
  );
  if (decided.kind !== "decided") throw new Error("unreachable");

  const executable = asExecutable(decided.authorization);
  if (!executable) throw new Error("unreachable");
  const executed = await executePayment({ authorization, evidence }, executable, new FakeAdapter(), "pm_test", NOW);
  if (executed.kind !== "executed") throw new Error("unreachable");

  return { authorization, evidence, providerEvents, mandateId, authorizationId: executed.authorization.id };
}

function refundEvent(id: string, authorizationId: string, amountRefunded: number): Stripe.Event {
  return {
    id,
    object: "event",
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_test_123",
        object: "charge",
        amount_refunded: amountRefunded,
        metadata: { waysafe_authorization_id: authorizationId },
      },
    },
  } as unknown as Stripe.Event;
}

describe("handleStripeWebhook", () => {
  it("applies a refund as a CREDIT ledger entry", async () => {
    const ctx = await setupExecutedAuthorization();
    const result = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      refundEvent("evt_1", ctx.authorizationId, toMinorUnits(83, "USD")),
      NOW,
    );

    expect(result).toEqual({ kind: "applied", effect: "refund" });
    const events = await ctx.evidence.listForOrganization(ORG);
    expect(events.map((e) => e.type)).toContain("refund.applied");
  });

  it("THE ATTACK: the same provider event delivered twice produces exactly one ledger effect", async () => {
    const ctx = await setupExecutedAuthorization();
    const event = refundEvent("evt_2", ctx.authorizationId, toMinorUnits(83, "USD"));

    const first = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      event,
      NOW,
    );
    const second = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      event,
      new Date(NOW.getTime() + 1000),
    );

    expect(first).toEqual({ kind: "applied", effect: "refund" });
    expect(second).toEqual({ kind: "duplicate" });

    const evidenceEvents = await ctx.evidence.listForOrganization(ORG);
    expect(evidenceEvents.filter((e) => e.type === "refund.applied")).toHaveLength(1);
  });

  it("ignores an event type it doesn't handle, without erroring", async () => {
    const ctx = await setupExecutedAuthorization();
    const event = {
      id: "evt_3",
      object: "event",
      type: "customer.created",
      data: { object: {} },
    } as unknown as Stripe.Event;

    const result = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      event,
      NOW,
    );
    expect(result.kind).toBe("ignored");
  });

  it("ignores a refund with no matching authorization instead of throwing", async () => {
    const ctx = await setupExecutedAuthorization();
    const result = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      refundEvent("evt_4", "auth_does_not_exist", 1000),
      NOW,
    );
    expect(result).toEqual({ kind: "ignored", reason: "no such authorization: auth_does_not_exist" });
  });
});

describe("handleStripeWebhook: issuing_authorization.updated (D-35 capture)", () => {
  const NETWORK_MID = "visa_network_id_webhook_test";

  function cardPolicy(): Policy {
    const result = parsePolicy({
      schema_version: POLICY_SCHEMA_VERSION,
      summary: "card capture test policy",
      currency: "USD",
      merchants: { allow: [{ scheme: "network_mid", value: NETWORK_MID }], deny: [], unlisted: "STEP_UP" },
      categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
      cumulative_limits: [],
      step_up: { ttl_seconds: 900 },
      accounting: {},
      expires_at: "2026-09-23T12:00:00.000Z",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.policy;
  }

  function issuingAuthorization(overrides: { id: string; status: string; approved: boolean }): Stripe.Issuing.Authorization {
    return {
      id: overrides.id,
      object: "issuing.authorization",
      status: overrides.status,
      approved: overrides.approved,
      amount: toMinorUnits(60, "USD"),
      currency: "usd",
      merchant_data: {
        category: "office_supplies",
        category_code: "5943",
        name: "Staples",
        network_id: NETWORK_MID,
        city: null,
        country: null,
        postal_code: null,
        state: null,
        tax_id: null,
        terminal_id: null,
        url: null,
      },
      card: { id: "ic_test_webhook", metadata: {} },
    } as unknown as Stripe.Issuing.Authorization;
  }

  async function setupApprovedCardAuthorization() {
    const authorization = new InMemoryAuthorizationRepository(DIRECTORY);
    const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const providerEvents = new InMemoryProviderEventRepository();
    const instruments = new InMemoryInstrumentRepository();
    const { mandateId } = authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: cardPolicy(),
      policyHash: "hash",
    });
    const instrument = await instruments.createInstrument(
      { organizationId: ORG, mandateId, rail: "stripe_issuing", externalRef: "ic_test_webhook" },
      NOW,
    );

    const stripeAuthorizationId = "iauth_webhook_test";
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      new StripeIssuingAdapter(),
      {
        id: stripeAuthorizationId,
        object: "issuing.authorization",
        amount: toMinorUnits(60, "USD"),
        approved: false,
        currency: "usd",
        merchant_data: {
          category: "office_supplies",
          category_code: "5943",
          name: "Staples",
          network_id: NETWORK_MID,
          city: null,
          country: null,
          postal_code: null,
          state: null,
          tax_id: null,
          terminal_id: null,
          url: null,
        },
        card: { id: "ic_test_webhook", metadata: { waysafe_instrument_id: instrument.id } },
        pending_request: {
          amount: toMinorUnits(60, "USD"),
          amount_details: null,
          currency: "usd",
          is_amount_controllable: false,
          merchant_amount: toMinorUnits(60, "USD"),
          merchant_currency: "usd",
          network_risk_score: null,
        },
      } as unknown as Stripe.Issuing.Authorization,
      NOW,
    );
    if (!decision.response.approved) throw new Error("unreachable: setup expects an ALLOW");

    const [stored] = await authorization.listAuthorizations(ORG, 10);
    return { authorization, evidence, providerEvents, stripeAuthorizationId, authorizationId: stored!.id };
  }

  it("releases the RESERVATION and writes a CAPTURE once Stripe closes the authorization approved", async () => {
    const ctx = await setupApprovedCardAuthorization();
    const result = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      {
        id: "evt_capture_1",
        object: "event",
        type: "issuing_authorization.updated",
        data: { object: issuingAuthorization({ id: ctx.stripeAuthorizationId, status: "closed", approved: true }) },
      } as unknown as Stripe.Event,
      new Date(NOW.getTime() + 1000),
    );

    expect(result).toEqual({ kind: "applied", effect: "capture" });

    const stored = await ctx.authorization.getAuthorization(ctx.authorizationId);
    expect(stored!.status).toBe("EXECUTED");
    const entries = ctx.authorization.ledgerEntriesFor(stored!.mandate_id);
    expect(entries.map((e) => e.type)).toEqual(
      expect.arrayContaining(["RESERVATION", "RELEASE", "CAPTURE"]),
    );

    const events = await ctx.evidence.listForOrganization(ORG);
    expect(events.map((e) => e.type)).toContain("enforcement.stripe_issuing.captured");
  });

  it("ignores an authorization that isn't closed-and-approved yet", async () => {
    const ctx = await setupApprovedCardAuthorization();
    const result = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      {
        id: "evt_capture_2",
        object: "event",
        type: "issuing_authorization.updated",
        data: { object: issuingAuthorization({ id: ctx.stripeAuthorizationId, status: "pending", approved: true }) },
      } as unknown as Stripe.Event,
      new Date(NOW.getTime() + 1000),
    );

    expect(result.kind).toBe("ignored");
    const stored = await ctx.authorization.getAuthorization(ctx.authorizationId);
    expect(stored!.status).toBe("AUTHORIZED");
  });

  it("THE ATTACK: the same capture event delivered twice produces exactly one CAPTURE", async () => {
    const ctx = await setupApprovedCardAuthorization();
    const event = {
      id: "evt_capture_3",
      object: "event",
      type: "issuing_authorization.updated",
      data: { object: issuingAuthorization({ id: ctx.stripeAuthorizationId, status: "closed", approved: true }) },
    } as unknown as Stripe.Event;

    const first = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      event,
      new Date(NOW.getTime() + 1000),
    );
    const second = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      event,
      new Date(NOW.getTime() + 2000),
    );

    expect(first).toEqual({ kind: "applied", effect: "capture" });
    expect(second).toEqual({ kind: "duplicate" });

    const stored = await ctx.authorization.getAuthorization(ctx.authorizationId);
    const captures = ctx.authorization
      .ledgerEntriesFor(stored!.mandate_id)
      .filter((e) => e.type === "CAPTURE");
    expect(captures).toHaveLength(1);
  });
});
