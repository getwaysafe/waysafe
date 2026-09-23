/**
 * D-40: runs entirely offline, against recorded 402 Payment Required
 * payloads -- no network call and no key required, same spirit as
 * stripe-issuing.test.ts (D-32/D-33) and the compiler's FixtureIntentCompiler
 * tests (D-12). `X402Fetcher` is faked with a canned response; nothing here
 * ever calls `createHttpX402Fetcher`. The bypass proof that Waysafe's own
 * co-signature is structurally insufficient to move funds alone -- the
 * custody constraint's whole point -- lives in x402.bypass.test.ts.
 */

import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
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
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "../instruments/in-memory-repository.js";
import {
  X402Adapter,
  coSignaturePayloadHash,
  handleX402PaymentRequest,
  provisionX402InstrumentForMandate,
  verifyCoSignature,
  type X402Callback,
  type X402Fetcher,
  type X402PaymentRequirement,
  type X402PaymentRequiredResponse,
} from "./x402.js";

const ORG = "org_x402_test";
const PRINCIPAL = "prin_test";
const AGENT = "agt_test";
const NOW = new Date("2026-09-09T12:00:00.000Z");
const PAY_TO = "0xabc0000000000000000000000000000000def1";
const RESOURCE_URL = "https://api.example.com/paid-endpoint";
const SESSION_KEY_ADDRESS = "0x1111111111111111111111111111111111aaaa";
const COSIGNER_ADDRESS = "0x2222222222222222222222222222222222bbbb";

/** D-41: the real deployer (`x402-safe.ts`'s `createOnChainSafeDeployer`)
 * makes an RPC call and pays gas -- this file stays offline (see the
 * file-level comment) by injecting a fake that returns instantly, the same
 * shape `fetcherFor` already fakes `X402Fetcher` with. */
function fakeSafeDeployer(safeAddress = "0x3333333333333333333333333333333333cccc") {
  return { deploySafe: async () => ({ safeAddress }) };
}

function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "x402 enforcement test policy",
    currency: "USD",
    merchants: {
      allow: [{ scheme: "onchain_address", value: PAY_TO, label: "Test x402 merchant" }],
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

/** A recorded 402 requirement, trimmed to the fields this codebase reads.
 * `extra.decimals: 6` mirrors a real 6-decimal USDC -- see assetAtomicToCents. */
function buildRequirement(
  overrides: Partial<X402PaymentRequirement> & { amountUsd?: number } = {},
): X402PaymentRequirement {
  const amountUsd = overrides.amountUsd ?? 60;
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: overrides.maxAmountRequired ?? String(Math.round(amountUsd * 1_000_000)),
    resource: RESOURCE_URL,
    description: "Totally Legit API",
    payTo: overrides.payTo ?? PAY_TO,
    maxTimeoutSeconds: 60,
    asset: overrides.asset ?? "usdc-test",
    extra: overrides.extra === undefined ? { decimals: 6 } : overrides.extra,
  };
}

function fakeFetcher(response: X402PaymentRequiredResponse): X402Fetcher {
  return {
    async fetchPaymentRequirements() {
      return response;
    },
  };
}

function fetcherFor(requirement: X402PaymentRequirement): X402Fetcher {
  return fakeFetcher({ x402Version: 1, accepts: [requirement] });
}

async function setup() {
  const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
  const evidence = new InMemoryEvidenceRepository(new FakeEd25519Signer());
  const instruments = new InMemoryInstrumentRepository();
  const { mandateId } = authorization.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy: policyFrom(),
    policyHash: "hash",
  });
  const instrument = await provisionX402InstrumentForMandate(
    { instruments },
    fakeSafeDeployer(),
    { organizationId: ORG, mandateId, sessionKeyAddress: SESSION_KEY_ADDRESS, cosignerAddress: COSIGNER_ADDRESS },
    NOW,
  );
  return { authorization, evidence, instruments, mandateId, instrumentId: instrument.id };
}

const signingKey = new FakeEd25519Signer();

describe("X402Adapter.parseRequest", () => {
  const adapter = new X402Adapter(signingKey);

  it("maps payTo/asset/network and converts atomic units to USD cents", () => {
    const callback: X402Callback = {
      instrumentRef: "inst_x",
      resourceUrl: RESOURCE_URL,
      requirement: buildRequirement({ amountUsd: 60 }),
    };
    const parsed = adapter.parseRequest(callback);
    expect(parsed).not.toBeNull();
    expect(parsed!.instrumentRef).toBe("inst_x");
    expect(parsed!.action.amount).toBe(toMinorUnits(60, "USD"));
    expect(parsed!.action.currency).toBe("USD");
    expect(parsed!.action.merchant.onchain_address).toBe(PAY_TO.toLowerCase());
    expect(parsed!.action.merchant.domain).toBe("api.example.com");
  });

  it("returns null when the caller carries no instrument reference", () => {
    const parsed = adapter.parseRequest({
      instrumentRef: "",
      resourceUrl: RESOURCE_URL,
      requirement: buildRequirement(),
    });
    expect(parsed).toBeNull();
  });

  it("returns null when payTo is missing", () => {
    const parsed = adapter.parseRequest({
      instrumentRef: "inst_x",
      resourceUrl: RESOURCE_URL,
      requirement: buildRequirement({ payTo: "" }),
    });
    expect(parsed).toBeNull();
  });

  it("returns null when the requirement states no asset decimals -- never guesses", () => {
    const parsed = adapter.parseRequest({
      instrumentRef: "inst_x",
      resourceUrl: RESOURCE_URL,
      requirement: buildRequirement({ extra: {} }),
    });
    expect(parsed).toBeNull();
  });

  it("never parses maxAmountRequired as a float -- a non-digit string is unparseable, not truncated", () => {
    const parsed = adapter.parseRequest({
      instrumentRef: "inst_x",
      resourceUrl: RESOURCE_URL,
      requirement: buildRequirement({ maxAmountRequired: "1.5" }),
    });
    expect(parsed).toBeNull();
  });
});

describe("X402Adapter.toResponse", () => {
  const adapter = new X402Adapter(signingKey);
  const callback: X402Callback = {
    instrumentRef: "inst_x",
    resourceUrl: RESOURCE_URL,
    requirement: buildRequirement(),
  };

  it("produces a validly-signed co-signature only on ALLOW", async () => {
    const response = await adapter.toResponse(
      { decision: Decision.ALLOW, reasons: [{ code: ReasonCode.ALLOW_WITHIN_MANDATE, message: "ok" }] },
      callback,
    );
    expect(response.decision).toBe(Decision.ALLOW);
    expect(response.co_signature).not.toBeNull();
    const publicKey = signingKey.publicKeyObject();
    expect(verifyCoSignature(publicKey, response.co_signature!)).toBe(true);
    expect(response.co_signature!.pay_to).toBe(callback.requirement.payTo);
    expect(response.co_signature!.amount_atomic).toBe(callback.requirement.maxAmountRequired);
  });

  it("D-33 point 4, mirrored: STEP_UP fails closed on this synchronous rail -- no co-signature", async () => {
    const response = await adapter.toResponse(
      {
        decision: Decision.STEP_UP,
        reasons: [{ code: ReasonCode.STEP_UP_MERCHANT_UNVERIFIED, message: "needs a human" }],
      },
      callback,
    );
    expect(response.co_signature).toBeNull();
    expect(response.reason_codes).toEqual([ReasonCode.STEP_UP_MERCHANT_UNVERIFIED]);
  });

  it("produces no co-signature on DENY", async () => {
    const response = await adapter.toResponse(
      { decision: Decision.DENY, reasons: [{ code: ReasonCode.DENY_MERCHANT_BLOCKED, message: "blocked" }] },
      callback,
    );
    expect(response.co_signature).toBeNull();
  });

  it("a tampered co-signature fails verification", async () => {
    const response = await adapter.toResponse(
      { decision: Decision.ALLOW, reasons: [{ code: ReasonCode.ALLOW_WITHIN_MANDATE, message: "ok" }] },
      callback,
    );
    const publicKey = signingKey.publicKeyObject();
    const tampered = { ...response.co_signature!, amount_atomic: "999999999999" };
    expect(verifyCoSignature(publicKey, tampered)).toBe(false);
  });

  it("mutating authorization_id after signing does not invalidate the signature (it was never signed)", async () => {
    const response = await adapter.toResponse(
      { decision: Decision.ALLOW, reasons: [{ code: ReasonCode.ALLOW_WITHIN_MANDATE, message: "ok" }] },
      callback,
    );
    const publicKey = signingKey.publicKeyObject();
    response.co_signature!.authorization_id = "auth_filled_in_later";
    expect(verifyCoSignature(publicKey, response.co_signature!)).toBe(true);
  });
});

describe("handleX402PaymentRequest", () => {
  const adapter = new X402Adapter(signingKey);

  it("D-40: approves an on-chain payee the policy allowlists, within its limits -- rail-attested via Waysafe's own fetch", async () => {
    const { authorization, evidence, instruments, instrumentId } = await setup();
    const decision = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fetcherFor(buildRequirement({ amountUsd: 60 })),
      { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
      NOW,
    );

    expect(decision.response.decision).toBe(Decision.ALLOW);
    expect(decision.response.co_signature).not.toBeNull();
    expect(decision.response.co_signature!.authorization_id).not.toBe("");

    const events = await evidence.listForOrganization(ORG);
    const event = events.find((e) => e.type === "enforcement.x402.decision");
    expect(event).toBeDefined();
    expect((event!.payload as { instrument_id: string }).instrument_id).toBe(instrumentId);
    expect((event!.payload as { decision: string }).decision).toBe("ALLOW");

    // D-35: the ALLOW reserved budget, attributed to the instrument.
    const [auth] = await authorization.listAuthorizations(ORG, 10);
    expect(auth!.actor_kind).toBe("instrument");
    expect(auth!.instrument_id).toBe(instrumentId);
    expect(auth!.agent_id).toBeNull();
    expect(authorization.ledgerEntriesFor(decision.mandateId!)).toEqual([
      expect.objectContaining({ type: "RESERVATION", amount: toMinorUnits(60, "USD") }),
    ]);
  });

  it("declines a payee the policy does not allowlist, and records why in evidence", async () => {
    const { authorization, evidence, instruments, instrumentId } = await setup();
    const decision = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fetcherFor(buildRequirement({ payTo: "0x000000000000000000000000000000attacker" })),
      { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
      NOW,
    );

    expect(decision.response.decision).not.toBe(Decision.ALLOW);
    expect(decision.response.co_signature).toBeNull();
    expect(decision.response.reason_codes).toContain(ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED);
    expect(authorization.ledgerEntriesFor(decision.mandateId!)).toEqual([]);
  });

  it(
    "THE ATTACK: whatever a resourceUrl looks like, the merchant evaluated is always what Waysafe's " +
      "own fetch returned, never something a caller of this function supplied directly -- there is no " +
      "parameter here for payment requirements at all, only a URL to independently fetch",
    async () => {
      const { authorization, evidence, instruments, instrumentId } = await setup();

      // Two fetchers, same resourceUrl requested, different content -- simulating
      // what an attacker-controlled endpoint might try to serve. The decision
      // always reflects whichever response the fetcher (Waysafe's own HTTP call,
      // faked here) actually returned; nothing about the *request* to
      // handleX402PaymentRequest can substitute a different payTo.
      const allowlisted = await handleX402PaymentRequest(
        { authorization, evidence, instruments },
        adapter,
        fetcherFor(buildRequirement({ payTo: PAY_TO })),
        { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
        NOW,
      );
      const notAllowlisted = await handleX402PaymentRequest(
        { authorization, evidence, instruments },
        adapter,
        fetcherFor(buildRequirement({ payTo: "0xnotallowlisted00000000000000000000" })),
        { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
        new Date(NOW.getTime() + 1000),
      );

      expect(allowlisted.response.decision).toBe(Decision.ALLOW);
      expect(notAllowlisted.response.decision).not.toBe(Decision.ALLOW);
    },
  );

  it("enforces the per-transaction limit", async () => {
    const { authorization, evidence, instruments, instrumentId } = await setup();
    const decision = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fetcherFor(buildRequirement({ amountUsd: 300 })),
      { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
      NOW,
    );

    expect(decision.response.decision).toBe(Decision.DENY);
    expect(decision.response.reason_codes).toContain(ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED);
  });

  it("enforces the monthly cumulative limit across two payments that individually pass the per-transaction cap", async () => {
    const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    const evidence = new InMemoryEvidenceRepository(new FakeEd25519Signer());
    const instruments = new InMemoryInstrumentRepository();
    const { mandateId } = authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom({ per_transaction_max: toMinorUnits(400, "USD") }),
      policyHash: "hash",
    });
    const instrument = await provisionX402InstrumentForMandate(
      { instruments },
      fakeSafeDeployer(),
      { organizationId: ORG, mandateId, sessionKeyAddress: SESSION_KEY_ADDRESS, cosignerAddress: COSIGNER_ADDRESS },
      NOW,
    );

    const first = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fetcherFor(buildRequirement({ amountUsd: 300 })),
      { instrumentRef: instrument.id, resourceUrl: RESOURCE_URL },
      NOW,
    );
    const second = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fetcherFor(buildRequirement({ amountUsd: 300 })),
      { instrumentRef: instrument.id, resourceUrl: RESOURCE_URL },
      new Date(NOW.getTime() + 1000),
    );

    expect(first.response.decision).toBe(Decision.ALLOW);
    expect(second.response.decision).toBe(Decision.DENY);
    expect(second.response.reason_codes).toContain(ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED);
  });

  it("declines when no instrument is registered for the reference presented, with no evidence to attach it to", async () => {
    const { authorization, evidence, instruments } = await setup();
    const decision = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fetcherFor(buildRequirement()),
      { instrumentRef: "inst_does_not_exist", resourceUrl: RESOURCE_URL },
      NOW,
    );

    expect(decision.response.decision).toBe(Decision.DENY);
    expect(decision.mandateId).toBeNull();
    expect(await evidence.listForOrganization(ORG)).toEqual([]);
  });

  it("declines a mandate that has expired, even for an otherwise-allowlisted payee", async () => {
    const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
    const evidence = new InMemoryEvidenceRepository(new FakeEd25519Signer());
    const instruments = new InMemoryInstrumentRepository();
    const { mandateId } = authorization.seedMandate({
      organizationId: ORG,
      principalId: PRINCIPAL,
      agentId: AGENT,
      policy: policyFrom(),
      policyHash: "hash",
      status: "EXPIRED",
    });
    const instrument = await provisionX402InstrumentForMandate(
      { instruments },
      fakeSafeDeployer(),
      { organizationId: ORG, mandateId, sessionKeyAddress: SESSION_KEY_ADDRESS, cosignerAddress: COSIGNER_ADDRESS },
      NOW,
    );

    const decision = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fetcherFor(buildRequirement()),
      { instrumentRef: instrument.id, resourceUrl: RESOURCE_URL },
      NOW,
    );

    expect(decision.response.decision).toBe(Decision.DENY);
    expect(decision.response.reason_codes).toContain(ReasonCode.DENY_MANDATE_EXPIRED);
  });

  it("declines, with a real evidenced receipt, when the 402 response names no accepted payment method", async () => {
    const { authorization, evidence, instruments, instrumentId } = await setup();
    const decision = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fakeFetcher({ x402Version: 1, accepts: [] }),
      { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
      NOW,
    );

    expect(decision.response.decision).toBe(Decision.DENY);
    expect(decision.response.co_signature).toBeNull();
    const events = await evidence.listForOrganization(ORG);
    expect(events.find((e) => e.type === "enforcement.x402.decision")).toBeDefined();
    const [auth] = await authorization.listAuthorizations(ORG, 10);
    expect(auth).toBeDefined();
    expect(auth!.decision).toBe(Decision.DENY);
  });
});

describe("provisionX402InstrumentForMandate", () => {
  it("creates an Instrument row on the x402 rail, one per mandate, with the deployer's real Safe address (D-41)", async () => {
    const instruments = new InMemoryInstrumentRepository();
    const deployedAddress = "0x4444444444444444444444444444444444dddd";
    let calledWith: { sessionKeyAddress: string; cosignerAddress: string } | null = null;
    const deployer = {
      async deploySafe(owners: { sessionKeyAddress: string; cosignerAddress: string }) {
        calledWith = owners;
        return { safeAddress: deployedAddress };
      },
    };

    const instrument = await provisionX402InstrumentForMandate(
      { instruments },
      deployer,
      { organizationId: ORG, mandateId: "mdt_test_1", sessionKeyAddress: SESSION_KEY_ADDRESS, cosignerAddress: COSIGNER_ADDRESS },
      NOW,
    );

    expect(instrument.rail).toBe("x402");
    expect(instrument.mandate_id).toBe("mdt_test_1");
    expect(instrument.organization_id).toBe(ORG);
    // D-40's placeholder ("pending-2of2-account:<mandateId>") is gone --
    // external_ref is now exactly whatever the deployer says the real Safe
    // address is, never a string this file invents itself.
    expect(instrument.external_ref).toBe(deployedAddress);
    expect(calledWith).toEqual({ sessionKeyAddress: SESSION_KEY_ADDRESS, cosignerAddress: COSIGNER_ADDRESS });
  });
});

describe("coSignaturePayloadHash", () => {
  it("is a function of the payload's content, not key order in the caller's object literal", () => {
    const a = coSignaturePayloadHash({
      pay_to: PAY_TO,
      asset: "usdc-test",
      network: "base-sepolia",
      amount_atomic: "1000000",
      resource: RESOURCE_URL,
      expires_at: "2026-09-09T12:01:00.000Z",
    });
    const b = coSignaturePayloadHash({
      expires_at: "2026-09-09T12:01:00.000Z",
      resource: RESOURCE_URL,
      amount_atomic: "1000000",
      network: "base-sepolia",
      asset: "usdc-test",
      pay_to: PAY_TO,
    });
    expect(a).toBe(b);
  });
});
