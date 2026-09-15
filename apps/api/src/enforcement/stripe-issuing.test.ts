/**
 * D-32/D-33/D-35: runs entirely offline, against recorded issuing_authorization.
 * request-shaped payloads -- no STRIPE_ISSUING_SECRET_KEY required, same
 * spirit as the compiler's FixtureIntentCompiler tests (D-12). The live
 * bypass test that proves the same enforcement against a genuine Stripe
 * test-mode authorization, with no Waysafe SDK involved at all, lives in
 * stripe-issuing.bypass.test.ts, gated on that key.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import {
  createStaticDirectory,
  generateEvidenceSigningKeyPair,
  parsePolicy,
  toMinorUnits,
  Decision,
  POLICY_SCHEMA_VERSION,
  ReasonCode,
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
  NO_CARD_ISSUING_TERMS_ACCEPTANCE_PREFIX,
  handleIssuingAuthorizationRequest,
  provisionCardForMandate,
  StripeIssuingAdapter,
} from "./stripe-issuing.js";

const ORG = "org_enforcement_test";
const PRINCIPAL = "prin_test";
const AGENT = "agt_test";
const NOW = new Date("2026-09-07T12:00:00.000Z");
const NETWORK_MID = "visa_network_id_staples_001";

function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "card enforcement test policy",
    currency: "USD",
    merchants: {
      allow: [{ scheme: "network_mid", value: NETWORK_MID, label: "Staples (network)" }],
      deny: [],
      unlisted: "STEP_UP",
    },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    per_transaction_max: toMinorUnits(150, "USD"),
    cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-12-31T00:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

/** A recorded issuing_authorization.request payload's `data.object`, trimmed
 * to the fields this codebase actually reads. Real Stripe payloads carry
 * many more fields; nothing here depends on any of them. */
function buildAuthorization(
  overrides: {
    instrumentId?: string | null;
    amount?: number;
    pendingAmount?: number;
    currency?: string;
    networkId?: string;
    categoryCode?: string;
    merchantName?: string;
    cardId?: string;
    authorizationId?: string;
  } = {},
): Stripe.Issuing.Authorization {
  const cardId = overrides.cardId ?? "ic_test_card_1";
  return {
    id: overrides.authorizationId ?? "iauth_test_1",
    object: "issuing.authorization",
    amount: overrides.amount ?? 0,
    approved: false,
    currency: overrides.currency ?? "usd",
    merchant_data: {
      category: "office_supplies",
      category_code: overrides.categoryCode ?? "5943",
      city: "San Francisco",
      country: "US",
      // Deliberately a *different* brand than the network id represents --
      // THE ATTACK tests below rely on this name never being read.
      name: overrides.merchantName ?? "Totally Legit Store",
      network_id: overrides.networkId ?? NETWORK_MID,
      postal_code: "94105",
      state: "CA",
      tax_id: null,
      terminal_id: null,
      url: null,
    },
    card: {
      id: cardId,
      metadata:
        overrides.instrumentId === null
          ? {}
          : { waysafe_instrument_id: overrides.instrumentId ?? "inst_placeholder" },
    } as Stripe.Issuing.Card,
    pending_request: {
      amount: overrides.pendingAmount ?? overrides.amount ?? toMinorUnits(60, "USD"),
      amount_details: null,
      currency: overrides.currency ?? "usd",
      is_amount_controllable: false,
      merchant_amount: overrides.pendingAmount ?? overrides.amount ?? toMinorUnits(60, "USD"),
      merchant_currency: overrides.currency ?? "usd",
      network_risk_score: null,
    },
  } as unknown as Stripe.Issuing.Authorization;
}

async function setup() {
  const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
  const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
  const instruments = new InMemoryInstrumentRepository();
  const { mandateId } = authorization.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy: policyFrom(),
    policyHash: "hash",
  });
  const instrument = await instruments.createInstrument(
    { organizationId: ORG, mandateId, rail: "stripe_issuing", externalRef: "ic_test_card_1" },
    NOW,
  );
  return { authorization, evidence, instruments, mandateId, instrumentId: instrument.id };
}

describe("StripeIssuingAdapter.parseRequest", () => {
  const adapter = new StripeIssuingAdapter();

  it("maps network_id and category_code, never merchant_data.name (D-3)", () => {
    const parsed = adapter.parseRequest(
      buildAuthorization({ instrumentId: "inst_x", merchantName: "Staples" }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.action.merchant).toEqual({ network_mid: NETWORK_MID, mcc: "5943" });
    expect(parsed!.action.merchant).not.toHaveProperty("name");
  });

  it("returns null when the card carries no Waysafe instrument reference", () => {
    const parsed = adapter.parseRequest(buildAuthorization({ instrumentId: null }));
    expect(parsed).toBeNull();
  });

  it("prefers pending_request.amount over the top-level (pre-decision) amount", () => {
    const parsed = adapter.parseRequest(
      buildAuthorization({ instrumentId: "inst_x", amount: 0, pendingAmount: toMinorUnits(42, "USD") }),
    );
    expect(parsed!.action.amount).toBe(toMinorUnits(42, "USD"));
  });
});

describe("StripeIssuingAdapter.toResponse", () => {
  const adapter = new StripeIssuingAdapter();
  const authorization = buildAuthorization({ instrumentId: "inst_x" });

  it("approves only ALLOW", () => {
    const response = adapter.toResponse(
      { decision: Decision.ALLOW, reasons: [{ code: ReasonCode.ALLOW_WITHIN_MANDATE, message: "ok" }] },
      authorization,
    );
    expect(response).toEqual({ approved: true, reason_codes: [ReasonCode.ALLOW_WITHIN_MANDATE] });
  });

  it("D-33: STEP_UP fails closed on this synchronous rail, but keeps its own reason codes", () => {
    const response = adapter.toResponse(
      {
        decision: Decision.STEP_UP,
        reasons: [{ code: ReasonCode.STEP_UP_MERCHANT_UNVERIFIED, message: "needs a human" }],
      },
      authorization,
    );
    expect(response.approved).toBe(false);
    expect(response.reason_codes).toEqual([ReasonCode.STEP_UP_MERCHANT_UNVERIFIED]);
  });

  it("declines DENY", () => {
    const response = adapter.toResponse(
      { decision: Decision.DENY, reasons: [{ code: ReasonCode.DENY_MERCHANT_BLOCKED, message: "blocked" }] },
      authorization,
    );
    expect(response.approved).toBe(false);
  });
});

describe("handleIssuingAuthorizationRequest", () => {
  const adapter = new StripeIssuingAdapter();

  it(
    "D-34: approves a network_mid the policy allowlists, within its limits -- rail-attested, " +
      "so unlike the same value arriving via authorize() (service.test.ts), this one genuinely verifies",
    async () => {
      const { authorization, evidence, instruments, instrumentId } = await setup();
      const decision = await handleIssuingAuthorizationRequest(
        { authorization, evidence, instruments },
        adapter,
        buildAuthorization({ instrumentId, amount: toMinorUnits(60, "USD") }),
        NOW,
      );

      expect(decision.response.approved).toBe(true);
      expect(decision.response.reason_codes).toEqual([ReasonCode.ALLOW_WITHIN_MANDATE]);

      const events = await evidence.listForOrganization(ORG);
      const event = events.find((e) => e.type === "enforcement.stripe_issuing.decision");
      expect(event).toBeDefined();
      expect((event!.payload as { instrument_id: string }).instrument_id).toBe(instrumentId);
      expect((event!.payload as { decision: string }).decision).toBe("ALLOW");

      // D-35: this is the whole point -- the ALLOW actually reserved budget.
      const [auth] = await authorization.listAuthorizations(ORG, 10);
      expect(auth!.actor_kind).toBe("instrument");
      expect(auth!.instrument_id).toBe(instrumentId);
      expect(auth!.agent_id).toBeNull();
      expect(authorization.ledgerEntriesFor(decision.mandateId!)).toEqual([
        expect.objectContaining({ type: "RESERVATION", amount: toMinorUnits(60, "USD") }),
      ]);
    },
  );

  it("declines a merchant the policy does not allowlist, and records why in evidence", async () => {
    const { authorization, evidence, instruments, instrumentId } = await setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      adapter,
      buildAuthorization({ instrumentId, networkId: "some_other_network_id" }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toContain(ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED);

    const events = await evidence.listForOrganization(ORG);
    const event = events.find((e) => e.type === "enforcement.stripe_issuing.decision");
    expect((event!.payload as { reason_codes: string[] }).reason_codes).toContain(
      ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
    );
    // No ledger effect from a decline (D-35 item 4).
    expect(authorization.ledgerEntriesFor(decision.mandateId!)).toEqual([]);
  });

  it("THE ATTACK: a merchant_data.name claiming the allowlisted brand does not launder a mismatched network_id", async () => {
    const { authorization, evidence, instruments, instrumentId } = await setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      adapter,
      buildAuthorization({
        instrumentId,
        networkId: "attacker_controlled_network_id",
        merchantName: "Staples (network)", // matches the allowlist label, not its value
      }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
  });

  it("enforces the per-transaction limit", async () => {
    const { authorization, evidence, instruments, instrumentId } = await setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      adapter,
      buildAuthorization({ instrumentId, amount: toMinorUnits(300, "USD") }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toContain(ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED);
  });

  it(
    "D-35 (closes D-33 point 6): two card authorizations that individually pass the per-transaction " +
      "cap but together exceed the monthly cumulative cap -- the second is declined, not both approved",
    async () => {
      const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
      const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
      const instruments = new InMemoryInstrumentRepository();
      // A per-transaction cap high enough that $300 individually always
      // passes -- the $500/month cumulative cap is the only thing that can
      // decline the second of two $300 charges.
      const { mandateId } = authorization.seedMandate({
        organizationId: ORG,
        principalId: PRINCIPAL,
        agentId: AGENT,
        policy: policyFrom({ per_transaction_max: toMinorUnits(400, "USD") }),
        policyHash: "hash",
      });
      const instrument = await instruments.createInstrument(
        { organizationId: ORG, mandateId, rail: "stripe_issuing", externalRef: "ic_test_card_2" },
        NOW,
      );

      const first = await handleIssuingAuthorizationRequest(
        { authorization, evidence, instruments },
        adapter,
        buildAuthorization({
          instrumentId: instrument.id,
          amount: toMinorUnits(300, "USD"),
          authorizationId: "iauth_a",
        }),
        NOW,
      );
      const second = await handleIssuingAuthorizationRequest(
        { authorization, evidence, instruments },
        adapter,
        buildAuthorization({
          instrumentId: instrument.id,
          amount: toMinorUnits(300, "USD"),
          authorizationId: "iauth_b",
        }),
        new Date(NOW.getTime() + 1000),
      );

      expect(first.response.approved).toBe(true);
      expect(second.response.approved).toBe(false);
      expect(second.response.reason_codes).toContain(ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED);

      const events = await evidence.listForOrganization(ORG);
      const declineEvent = events.find(
        (e) =>
          e.type === "enforcement.stripe_issuing.decision" &&
          (e.payload as { reason_codes: string[] }).reason_codes.includes(
            ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED,
          ),
      );
      expect(declineEvent).toBeDefined();
    },
  );

  it("declines when the card carries no instrument reference at all, with no evidence to attach it to", async () => {
    const { authorization, evidence, instruments } = await setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      adapter,
      buildAuthorization({ instrumentId: null }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.mandateId).toBeNull();
    expect(await evidence.listForOrganization(ORG)).toHaveLength(0);
  });

  it("declines when the instrument id on the card matches nothing Waysafe knows about", async () => {
    const { authorization, evidence, instruments } = await setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      adapter,
      buildAuthorization({ instrumentId: "inst_does_not_exist" }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toEqual([ReasonCode.DENY_NO_ACTIVE_MANDATE]);
    expect(await evidence.listForOrganization(ORG)).toHaveLength(0);
  });

  it.each([
    ["REVOKED" as const, ReasonCode.DENY_MANDATE_REVOKED],
    ["EXPIRED" as const, ReasonCode.DENY_MANDATE_EXPIRED],
    ["SUPERSEDED" as const, ReasonCode.DENY_MANDATE_SUPERSEDED],
    ["PENDING_AUTHENTICATION" as const, ReasonCode.DENY_MANDATE_NOT_AUTHENTICATED],
  ])("declines a %s mandate with %s, and records it in evidence", async (status, expectedCode) => {
    const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const instruments = new InMemoryInstrumentRepository();
    const { mandateId } = authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash",
      status,
    });
    const instrument = await instruments.createInstrument(
      { organizationId: ORG, mandateId, rail: "stripe_issuing", externalRef: "ic_test_card_x" },
      NOW,
    );

    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence, instruments },
      adapter,
      buildAuthorization({ instrumentId: instrument.id }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toEqual([expectedCode]);
    const events = await evidence.listForOrganization(ORG);
    expect((events[0]!.payload as { reason_codes: string[] }).reason_codes).toEqual([expectedCode]);
  });
});

describe("provisionCardForMandate (D-37/D-38)", () => {
  const ORIGINAL_FINANCIAL_ACCOUNT = process.env.STRIPE_ISSUING_FINANCIAL_ACCOUNT;

  beforeEach(() => {
    process.env.STRIPE_ISSUING_FINANCIAL_ACCOUNT = "fa_test_fake_account";
  });

  afterEach(() => {
    if (ORIGINAL_FINANCIAL_ACCOUNT === undefined) {
      delete process.env.STRIPE_ISSUING_FINANCIAL_ACCOUNT;
    } else {
      process.env.STRIPE_ISSUING_FINANCIAL_ACCOUNT = ORIGINAL_FINANCIAL_ACCOUNT;
    }
  });

  /** A fake Stripe client that never leaves the process -- these tests are
   * about D-38's consent-provenance contract, not about Stripe's own API,
   * so no live key or network call is involved. Captures exactly what each
   * call was invoked with, for the "matches what was captured at
   * authentication" assertion below. */
  function fakeStripe() {
    const cardholderCreate = vi.fn(async (params: Record<string, unknown>) => ({
      id: "ich_fake",
      ...params,
    }));
    // D-48: `provisionCardForMandate` polls this once after creating a
    // cardholder (see `waitForCardholderReview`) -- this fake account's
    // cardholder is never actually under Stripe's real async review, so
    // reporting it already clear lets these tests reach the same
    // card-creation step they always did, in one call, unaffected by that
    // polling loop's own timing.
    const cardholderRetrieve = vi.fn(async (id: string) => ({ id, requirements: { disabled_reason: null } }));
    const cardCreate = vi.fn(async (params: Record<string, unknown>) => ({ id: "ic_fake", ...params }));
    const cardUpdate = vi.fn(async (id: string, params: Record<string, unknown>) => ({ id, ...params }));
    const stripe = {
      issuing: {
        cardholders: { create: cardholderCreate, retrieve: cardholderRetrieve },
        cards: { create: cardCreate, update: cardUpdate },
      },
    } as unknown as Stripe;
    return { stripe, cardholderCreate, cardholderRetrieve, cardCreate, cardUpdate };
  }

  function baseParams(mandateId: string) {
    return {
      organizationId: ORG,
      mandateId,
      cardholderName: "Waysafe Test",
      cardholderFirstName: "Waysafe",
      cardholderLastName: "Test",
      cardholderPhone: "+15555550100",
      cardholderDob: { day: 1, month: 1, year: 1990 },
      currency: "USD" as const,
      billingAddress: {
        line1: "123 Market St",
        city: "San Francisco",
        state: "CA",
        postal_code: "94105",
        country: "US",
      },
    };
  }

  it("THE ATTACK: refuses to provision -- and never touches Stripe at all -- when the mandate was never authenticated", async () => {
    const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const instruments = new InMemoryInstrumentRepository();
    const { mandateId } = authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash",
      authenticatedAt: null,
    });
    const { stripe, cardholderCreate } = fakeStripe();

    await expect(
      provisionCardForMandate(stripe, { authorization, instruments, evidence }, baseParams(mandateId), NOW),
    ).rejects.toThrow(NO_CARD_ISSUING_TERMS_ACCEPTANCE_PREFIX);

    expect(cardholderCreate).not.toHaveBeenCalled();
    expect(await evidence.listForOrganization(ORG)).toHaveLength(0);
  });

  it("records the acceptance as its own evidence event, distinct from mandate.authenticated", async () => {
    const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const instruments = new InMemoryInstrumentRepository();
    const authenticatedAt = new Date("2026-08-01T09:30:00.000Z");
    const { mandateId, mandateVersionId } = authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash",
      authenticatedAt,
      authenticationIp: "198.51.100.7",
    });
    const { stripe } = fakeStripe();

    await provisionCardForMandate(stripe, { authorization, instruments, evidence }, baseParams(mandateId), NOW);

    const events = await evidence.listForOrganization(ORG);
    const event = events.find((e) => e.type === "mandate.card_issuing_terms_accepted");
    expect(event).toBeDefined();
    expect(event!.subject_type).toBe("mandate_version");
    expect(event!.subject_id).toBe(mandateVersionId);
    expect((event!.payload as { ip: string }).ip).toBe("198.51.100.7");
    expect((event!.payload as { accepted_at: string }).accepted_at).toBe(authenticatedAt.toISOString());
  });

  it("THE ATTACK: sends Stripe the moment the principal actually authenticated, never a fresh timestamp taken at provisioning time", async () => {
    const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const instruments = new InMemoryInstrumentRepository();
    // Authenticated ten days before provisioning ever runs -- if
    // provisionCardForMandate took `now` (or Date.now()) as the acceptance
    // time instead of reading the mandate's own authenticatedAt, this would
    // catch it immediately.
    const authenticatedAt = new Date("2026-08-28T00:00:00.000Z");
    const provisionedAt = new Date("2026-09-07T12:00:00.000Z");
    const { mandateId } = authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash",
      authenticatedAt,
      authenticationIp: "198.51.100.7",
    });
    const { stripe, cardholderCreate } = fakeStripe();

    await provisionCardForMandate(
      stripe,
      { authorization, instruments, evidence },
      baseParams(mandateId),
      provisionedAt,
    );

    expect(cardholderCreate).toHaveBeenCalledTimes(1);
    const sent = cardholderCreate.mock.calls[0]![0] as {
      individual: { card_issuing: { user_terms_acceptance: { ip: string; date: number } } };
    };
    expect(sent.individual.card_issuing.user_terms_acceptance.ip).toBe("198.51.100.7");
    expect(sent.individual.card_issuing.user_terms_acceptance.date).toBe(
      Math.floor(authenticatedAt.getTime() / 1000),
    );
    expect(sent.individual.card_issuing.user_terms_acceptance.date).not.toBe(
      Math.floor(provisionedAt.getTime() / 1000),
    );
  });
});

describe("POST /v1/enforcement/stripe-issuing (route, signature verification)", () => {
  const ISSUING_WEBHOOK_SECRET = "whsec_test_issuing_secret";
  const stripeForSigning = new Stripe("sk_test_unused_for_signing");
  let app: ReturnType<typeof buildServer>;
  let repos: ServerRepos;
  let instrumentId: string;

  beforeAll(async () => {
    const authorizationRepo = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    const instruments = new InMemoryInstrumentRepository();
    repos = {
      authorization: authorizationRepo,
      agentKeys: new InMemoryAgentKeyRepository(),
      evidence: new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey),
      webauthn: new InMemoryWebauthnRepository(),
      providerEvents: new InMemoryProviderEventRepository(),
      principals: new InMemoryPrincipalRepository(),
      instruments,
    };
    const { mandateId } = authorizationRepo.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash",
    });
    const instrument = await instruments.createInstrument(
      { organizationId: ORG, mandateId, rail: "stripe_issuing", externalRef: "ic_test_card_route" },
      NOW,
    );
    instrumentId = instrument.id;

    app = buildServer({
      logger: false,
      repos,
      stripeIssuingWebhookSecret: ISSUING_WEBHOOK_SECRET,
    });
    await app.ready();
  });

  function eventPayload(authorization: Stripe.Issuing.Authorization): string {
    return JSON.stringify({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      object: "event",
      type: "issuing_authorization.request",
      data: { object: authorization },
    });
  }

  it("does not require a Bearer credential, and responds with a Stripe-Version header", async () => {
    const payload = eventPayload(buildAuthorization({ instrumentId, amount: toMinorUnits(60, "USD") }));
    const signature = stripeForSigning.webhooks.generateTestHeaderString({
      payload,
      secret: ISSUING_WEBHOOK_SECRET,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/enforcement/stripe-issuing",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["stripe-version"]).toBeTruthy();
    expect(response.json()).toEqual({ approved: true, reason_codes: [ReasonCode.ALLOW_WITHIN_MANDATE] });
  });

  it("THE ATTACK: a forged signature is rejected outright, fails closed with no decision made", async () => {
    const payload = eventPayload(buildAuthorization({ instrumentId }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/enforcement/stripe-issuing",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=0000000000forgedvalue" },
      payload,
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a request with no signature at all", async () => {
    const payload = eventPayload(buildAuthorization({ instrumentId }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/enforcement/stripe-issuing",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it("acknowledges without deciding when an unexpected event type is delivered", async () => {
    const payload = JSON.stringify({
      id: `evt_${Date.now()}`,
      object: "event",
      type: "issuing_authorization.created",
      data: { object: buildAuthorization({ instrumentId }) },
    });
    const signature = stripeForSigning.webhooks.generateTestHeaderString({
      payload,
      secret: ISSUING_WEBHOOK_SECRET,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/enforcement/stripe-issuing",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ approved: false, reason_codes: [] });
  });
});
