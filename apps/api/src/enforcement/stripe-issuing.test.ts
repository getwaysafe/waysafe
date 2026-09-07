/**
 * D-32/D-33: runs entirely offline, against recorded issuing_authorization.
 * request-shaped payloads -- no STRIPE_ISSUING_SECRET_KEY required, same
 * spirit as the compiler's FixtureIntentCompiler tests (D-12). The live
 * bypass test that proves the same enforcement against a genuine Stripe
 * test-mode authorization, with no Waysafe SDK involved at all, lives in
 * stripe-issuing.bypass.test.ts, gated on that key.
 */

import { beforeAll, describe, expect, it } from "vitest";
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
import { InMemoryWebauthnRepository } from "../webauthn/in-memory-repository.js";
import { InMemoryProviderEventRepository } from "../webhooks/in-memory-repository.js";
import { handleIssuingAuthorizationRequest, StripeIssuingAdapter } from "./stripe-issuing.js";

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
    mandateId?: string | null;
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
        overrides.mandateId === null
          ? {}
          : { waysafe_mandate_id: overrides.mandateId ?? "mdt_placeholder" },
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

function setup() {
  const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
  const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
  const { mandateId } = authorization.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy: policyFrom(),
    policyHash: "hash",
  });
  return { authorization, evidence, mandateId };
}

describe("StripeIssuingAdapter.parseRequest", () => {
  const adapter = new StripeIssuingAdapter();

  it("maps network_id and category_code, never merchant_data.name (D-3)", () => {
    const parsed = adapter.parseRequest(buildAuthorization({ mandateId: "mdt_x", merchantName: "Staples" }));
    expect(parsed).not.toBeNull();
    expect(parsed!.action.merchant).toEqual({ network_mid: NETWORK_MID, mcc: "5943" });
    expect(parsed!.action.merchant).not.toHaveProperty("name");
  });

  it("returns null when the card carries no Waysafe mandate reference", () => {
    const parsed = adapter.parseRequest(buildAuthorization({ mandateId: null }));
    expect(parsed).toBeNull();
  });

  it("prefers pending_request.amount over the top-level (pre-decision) amount", () => {
    const parsed = adapter.parseRequest(
      buildAuthorization({ mandateId: "mdt_x", amount: 0, pendingAmount: toMinorUnits(42, "USD") }),
    );
    expect(parsed!.action.amount).toBe(toMinorUnits(42, "USD"));
  });
});

describe("StripeIssuingAdapter.toResponse", () => {
  const adapter = new StripeIssuingAdapter();
  const authorization = buildAuthorization({ mandateId: "mdt_x" });

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

  it("approves a network_mid the policy allowlists, within its limits", async () => {
    const { authorization, evidence, mandateId } = setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence },
      adapter,
      buildAuthorization({ mandateId, amount: toMinorUnits(60, "USD") }),
      NOW,
    );

    expect(decision.response.approved).toBe(true);
    expect(decision.response.reason_codes).toEqual([ReasonCode.ALLOW_WITHIN_MANDATE]);

    const events = await evidence.listForOrganization(ORG);
    const event = events.find((e) => e.type === "enforcement.stripe_issuing.decision");
    expect(event).toBeDefined();
    expect(event!.subject_id).toBe(mandateId);
    expect((event!.payload as { decision: string }).decision).toBe("ALLOW");
  });

  it("declines a merchant the policy does not allowlist, and records why in evidence", async () => {
    const { authorization, evidence, mandateId } = setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence },
      adapter,
      buildAuthorization({ mandateId, networkId: "some_other_network_id" }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toContain(ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED);

    const events = await evidence.listForOrganization(ORG);
    const event = events.find((e) => e.type === "enforcement.stripe_issuing.decision");
    expect((event!.payload as { reason_codes: string[] }).reason_codes).toContain(
      ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
    );
  });

  it("THE ATTACK: a merchant_data.name claiming the allowlisted brand does not launder a mismatched network_id", async () => {
    const { authorization, evidence, mandateId } = setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence },
      adapter,
      buildAuthorization({
        mandateId,
        networkId: "attacker_controlled_network_id",
        merchantName: "Staples (network)", // matches the allowlist label, not its value
      }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
  });

  it("enforces the per-transaction limit", async () => {
    const { authorization, evidence, mandateId } = setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence },
      adapter,
      buildAuthorization({ mandateId, amount: toMinorUnits(300, "USD") }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toContain(ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED);
  });

  it("declines when the card carries no mandate reference at all, with no evidence to attach it to", async () => {
    const { authorization, evidence } = setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence },
      adapter,
      buildAuthorization({ mandateId: null }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.mandateId).toBeNull();
    expect(await evidence.listForOrganization(ORG)).toHaveLength(0);
  });

  it("declines when the mandate id on the card matches nothing Waysafe knows about", async () => {
    const { authorization, evidence } = setup();
    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence },
      adapter,
      buildAuthorization({ mandateId: "mdt_does_not_exist" }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toEqual([ReasonCode.DENY_NO_ACTIVE_MANDATE]);
  });

  it.each([
    ["REVOKED" as const, ReasonCode.DENY_MANDATE_REVOKED],
    ["EXPIRED" as const, ReasonCode.DENY_MANDATE_EXPIRED],
    ["SUPERSEDED" as const, ReasonCode.DENY_MANDATE_SUPERSEDED],
    ["PENDING_AUTHENTICATION" as const, ReasonCode.DENY_MANDATE_NOT_AUTHENTICATED],
  ])("declines a %s mandate with %s, and records it in evidence", async (status, expectedCode) => {
    const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const { mandateId } = authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash",
      status,
    });

    const decision = await handleIssuingAuthorizationRequest(
      { authorization, evidence },
      adapter,
      buildAuthorization({ mandateId }),
      NOW,
    );

    expect(decision.response.approved).toBe(false);
    expect(decision.response.reason_codes).toEqual([expectedCode]);
    const events = await evidence.listForOrganization(ORG);
    expect((events[0]!.payload as { reason_codes: string[] }).reason_codes).toEqual([expectedCode]);
  });

  it(
    "D-33 (documented limitation): approved card spend is not yet reserved against the ledger, " +
      "so a cumulative cap does not yet see repeated card authorizations",
    async () => {
      const { authorization, evidence, mandateId } = setup();
      // Two authorizations of $300 each, both individually within the
      // $150-per-transaction... no -- each *individually* under the $500
      // monthly cap, but together ($600) over it. If ledger reservation
      // were wired up, the second would DENY_CUMULATIVE_LIMIT_EXCEEDED.
      const first = await handleIssuingAuthorizationRequest(
        { authorization, evidence },
        adapter,
        buildAuthorization({ mandateId, amount: toMinorUnits(120, "USD") }),
        NOW,
      );
      const second = await handleIssuingAuthorizationRequest(
        { authorization, evidence },
        adapter,
        buildAuthorization({ mandateId, amount: toMinorUnits(120, "USD") }),
        new Date(NOW.getTime() + 1000),
      );

      // Both approved -- neither exceeds the $150 per-transaction cap, and
      // the $500/month cumulative cap never saw either one land in the
      // ledger. This is the known gap D-33 records, proven here rather than
      // silently assumed away.
      expect(first.response.approved).toBe(true);
      expect(second.response.approved).toBe(true);
    },
  );
});

describe("POST /v1/enforcement/stripe-issuing (route, signature verification)", () => {
  const ISSUING_WEBHOOK_SECRET = "whsec_test_issuing_secret";
  const stripeForSigning = new Stripe("sk_test_unused_for_signing");
  let app: ReturnType<typeof buildServer>;
  let repos: ServerRepos;
  let mandateId: string;

  beforeAll(async () => {
    const authorizationRepo = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    repos = {
      authorization: authorizationRepo,
      agentKeys: new InMemoryAgentKeyRepository(),
      evidence: new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey),
      webauthn: new InMemoryWebauthnRepository(),
      providerEvents: new InMemoryProviderEventRepository(),
      principals: new InMemoryPrincipalRepository(),
    };
    ({ mandateId } = authorizationRepo.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash",
    }));

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
    const payload = eventPayload(buildAuthorization({ mandateId, amount: toMinorUnits(60, "USD") }));
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
    const payload = eventPayload(buildAuthorization({ mandateId }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/enforcement/stripe-issuing",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=0000000000forgedvalue" },
      payload,
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a request with no signature at all", async () => {
    const payload = eventPayload(buildAuthorization({ mandateId }));
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
      data: { object: buildAuthorization({ mandateId }) },
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
