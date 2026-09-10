/**
 * THE BYPASS TEST (D-40) -- and an explicit admission of what it cannot yet
 * prove, per the task that produced this file: "propose the smallest
 * payer-account design that does [satisfy the custody constraint], and
 * record the tension" rather than silently building a custodial version.
 *
 * Stripe Issuing's bypass test (stripe-issuing.bypass.test.ts) proves "a
 * process with no Waysafe SDK cannot get money moving" by driving a real
 * card against a real network and watching the network itself decline it --
 * the network is the thing that enforces, so the proof is external and
 * genuine. x402 has no equivalent external enforcer *yet*: per x402.ts's
 * custody comment, that role belongs to a 2-of-2 smart account whose
 * validator requires Waysafe's co-signature, and this codebase deliberately
 * does not deploy one -- doing so would mean either Waysafe holding the
 * payer's key (custodial, forbidden by non-negotiable #9) or the agent
 * holding it (advisory, the exact OQ-10 hole D-32 closes for every other
 * rail). So this file proves what genuinely can be proven without that
 * account existing, and is explicit about the one thing it cannot.
 *
 * PROVEN, offline, always runs (no network, no key required beyond what
 * this process generates for itself):
 *
 *   1. Forging a co-signature that verifies against Waysafe's public key
 *      requires Waysafe's actual private key -- a process holding only the
 *      public 402 payment requirements and Waysafe's *public* co-signer key
 *      cannot produce a signature `verifyCoSignature` accepts. This is the
 *      cryptographic core of "necessary": nothing stands in for Waysafe's
 *      decision.
 *   2. Even a *genuine* Waysafe co-signature, obtained from a real ALLOW,
 *      is not by itself a complete, spendable payment authorization: it
 *      carries no field that is a signed transfer over the asset contract
 *      (no EIP-3009-shaped authorization, no `v`/`r`/`s`). This is the
 *      cryptographic core of "not sufficient" -- see x402.ts's custody
 *      comment for why that's true by design, not by omission.
 *
 * NOT YET PROVEN, and self-skipped rather than faked (test-support/
 * x402-gate.ts): that a process holding a *complete* forged payment
 * envelope -- Waysafe's genuine co-signature plus an attacker's own
 * fabricated session-key signature, with no real session key -- is
 * actually rejected on-chain. That proof needs the 2-of-2 account deployed
 * and reachable at WAYSAFE_X402_LIVE_PAYER_ACCOUNT. Nothing in this
 * codebase deploys one; this gap is the tension D-40 records rather than
 * resolves.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateEvidenceSigningKeyPair, toMinorUnits, Decision } from "@waysafe/core";
import { createStaticDirectory, parsePolicy, POLICY_SCHEMA_VERSION, type Policy } from "@waysafe/core";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "../instruments/in-memory-repository.js";
import {
  X402Adapter,
  coSignaturePayloadHash,
  handleX402PaymentRequest,
  provisionX402InstrumentForMandate,
  signCoSignaturePayload,
  verifyCoSignature,
  type X402CoSignaturePayload,
  type X402Fetcher,
  type X402PaymentRequirement,
} from "./x402.js";
import { requireX402LiveOrExplainSkip } from "./test-support/x402-gate.js";

const LIVE_PAYER_ACCOUNT_REACHABLE = Boolean(process.env.WAYSAFE_X402_LIVE_PAYER_ACCOUNT);
requireX402LiveOrExplainSkip(
  "x402 on-chain rejection of a forged (no-real-key) payment envelope (D-40)",
  LIVE_PAYER_ACCOUNT_REACHABLE,
);

const ORG = "org_x402_bypass_test";
const PRINCIPAL = "prin_bypass_test";
const AGENT = "agt_bypass_test";
const NOW = new Date("2026-09-09T12:00:00.000Z");
const PAY_TO = "0xabc0000000000000000000000000000000def1";
const RESOURCE_URL = "https://api.example.com/paid-endpoint";

function policyFrom(): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "x402 bypass test policy",
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
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

function requirement(): X402PaymentRequirement {
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: String(60 * 1_000_000),
    resource: RESOURCE_URL,
    description: "Totally Legit API",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    asset: "usdc-test",
    extra: { decimals: 6 },
  };
}

function fetcherFor(req: X402PaymentRequirement): X402Fetcher {
  return {
    async fetchPaymentRequirements() {
      return { x402Version: 1, accepts: [req] };
    },
  };
}

describe("THE BYPASS TEST, part 1: forging a co-signature requires Waysafe's real private key", () => {
  it("a signature produced with any key other than Waysafe's own never verifies against Waysafe's public key", () => {
    const waysafeKey = generateEvidenceSigningKeyPair();
    // Simulates an attacker with no access to Waysafe's process: its own,
    // entirely unrelated Ed25519 keypair -- not derived from, stolen from,
    // or related to Waysafe's key in any way.
    const attackerKey = generateKeyPairSync("ed25519");

    const payload: X402CoSignaturePayload = {
      pay_to: PAY_TO,
      asset: "usdc-test",
      network: "base-sepolia",
      amount_atomic: String(60 * 1_000_000),
      resource: RESOURCE_URL,
      expires_at: "2026-09-09T12:01:00.000Z",
    };

    const forgedSignature = signCoSignaturePayload(attackerKey.privateKey, payload);
    const forged = { ...payload, authorization_id: "auth_forged", signature: forgedSignature };

    // Checked against Waysafe's real public key -- the one a payer account
    // would actually be configured to trust -- the forged signature fails.
    expect(verifyCoSignature(waysafeKey.publicKey, forged)).toBe(false);

    // Sanity: the same forged signature does verify against the attacker's
    // own key, proving the failure above is specifically about which key
    // signed it, not a bug in the hashing/verification path itself.
    expect(verifyCoSignature(attackerKey.publicKey, forged)).toBe(true);
  });

  it("mutating any signed field of a genuine co-signature breaks its own verification", () => {
    const waysafeKey = generateEvidenceSigningKeyPair();
    const payload: X402CoSignaturePayload = {
      pay_to: PAY_TO,
      asset: "usdc-test",
      network: "base-sepolia",
      amount_atomic: String(60 * 1_000_000),
      resource: RESOURCE_URL,
      expires_at: "2026-09-09T12:01:00.000Z",
    };
    const genuine = {
      ...payload,
      authorization_id: "auth_real",
      signature: signCoSignaturePayload(waysafeKey.privateKey, payload),
    };
    expect(verifyCoSignature(waysafeKey.publicKey, genuine)).toBe(true);

    // An attacker who intercepts a real co-signature and tries to redirect
    // it to a different payTo (or amount, network, asset, resource) breaks
    // the signature -- the hash it was signed over no longer matches.
    for (const mutation of [
      { pay_to: "0xattacker000000000000000000000000000000" },
      { amount_atomic: String(6000 * 1_000_000) },
      { network: "ethereum-mainnet" },
      { asset: "different-asset" },
    ] as const) {
      expect(verifyCoSignature(waysafeKey.publicKey, { ...genuine, ...mutation })).toBe(false);
    }
  });
});

describe("THE BYPASS TEST, part 2: a genuine co-signature is necessary but not sufficient to pay", () => {
  it("Waysafe's own ALLOW response carries no signed transfer authorization -- only a co-signature over the payment intent", async () => {
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
    const instrument = await provisionX402InstrumentForMandate(
      { instruments },
      { organizationId: ORG, mandateId },
      NOW,
    );

    const signingKey = generateEvidenceSigningKeyPair().privateKey;
    const adapter = new X402Adapter(signingKey);
    const decision = await handleX402PaymentRequest(
      { authorization, evidence, instruments },
      adapter,
      fetcherFor(requirement()),
      { instrumentRef: instrument.id, resourceUrl: RESOURCE_URL },
      NOW,
    );

    expect(decision.response.decision).toBe(Decision.ALLOW);
    const coSignature = decision.response.co_signature!;
    expect(coSignature).not.toBeNull();

    // Structural proof, not a heuristic: enumerate every field this codebase
    // actually puts on a co-signature, and confirm none of them is (or
    // could be mistaken for) a signed EIP-3009 `transferWithAuthorization`
    // or a raw `(v, r, s)` ECDSA transfer signature -- the shape x402's
    // standard flow actually needs to move funds. There is no field here
    // an on-chain token contract's `transferWithAuthorization` would accept.
    const fields = Object.keys(coSignature).sort();
    expect(fields).toEqual(
      ["amount_atomic", "asset", "authorization_id", "expires_at", "network", "pay_to", "resource", "signature"].sort(),
    );
    expect(coSignature).not.toHaveProperty("v");
    expect(coSignature).not.toHaveProperty("r");
    expect(coSignature).not.toHaveProperty("s");
    expect(coSignature).not.toHaveProperty("transferAuthorization");
    expect(coSignature).not.toHaveProperty("eip3009Signature");

    // The signature itself is over a hash of the payment *intent* fields
    // only -- reconstructible and checkable by anyone with the public
    // payment requirements, never a capability to move the asset.
    const { signature: _sig, authorization_id: _id, ...payload } = coSignature;
    expect(coSignaturePayloadHash(payload)).toHaveLength(64); // sha256 hex
  });
});

// See the file-level comment: this gap is real, self-skipped honestly, and
// recorded as the open half of D-40's custody tension rather than faked.
describe.skipIf(!LIVE_PAYER_ACCOUNT_REACHABLE)(
  "THE BYPASS TEST, part 3 (not built): on-chain rejection of a forged envelope",
  () => {
    it("a payment envelope combining Waysafe's genuine co-signature with an attacker's fabricated session-key signature is rejected by the payer account's own validator", () => {
      throw new Error(
        "not implemented -- requires a deployed 2-of-2 payer smart account (D-40's custody comment); " +
          "see WAYSAFE_X402_LIVE_PAYER_ACCOUNT in test-support/x402-gate.ts",
      );
    });
  },
);
