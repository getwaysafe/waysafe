/**
 * THE BYPASS TEST (D-40, closed by D-41).
 *
 * Stripe Issuing's bypass test (stripe-issuing.bypass.test.ts) proves "a
 * process with no Waysafe SDK cannot get money moving" by driving a real
 * card against a real network and watching the network itself decline it --
 * the network is the thing that enforces, so the proof is external and
 * genuine. D-40 left x402 without an equivalent external enforcer, because
 * building one meant either Waysafe holding the payer's key (custodial,
 * forbidden by non-negotiable #9) or the agent holding it (advisory, the
 * exact OQ-10 hole D-32 closes for every other rail) -- so part 3 below
 * was a documented, self-skipping gap rather than a faked pass.
 *
 * D-41 closes it: a real 2-of-2 Safe (`x402-safe.ts`), deployed and funded
 * on Polygon Amoy, is now the external enforcer. Parts 1 and 2 below are
 * unchanged from D-40 (offline, always run, no network or key beyond what
 * this process generates for itself); part 3 is now real.
 *
 * PROVEN, offline, always runs:
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
 * PROVEN, live on Amoy, gated on `probeX402SafeAccount()` (test-support/
 * x402-gate.ts), self-skipping with a labeled reason when any prerequisite
 * is missing:
 *
 *   3. A genuine 2-of-2 transfer (real session-key signature + real
 *      Waysafe co-signer signature) actually moves the Safe's test USDC,
 *      broadcast and confirmed on-chain. The session key's signature
 *      alone is rejected by the Safe contract itself (`execTransaction`
 *      reverts -- simulated via `eth_call`, so the proof is real without
 *      spending gas on an expected failure). A forged envelope -- a
 *      genuine Waysafe co-signature plus a fabricated session-key
 *      signature -- is rejected the same way. And, named separately per
 *      the task that produced this file even though the underlying
 *      mechanism is identical to the session-key-alone case: a real
 *      session-key signature with no Waysafe signature at all is
 *      rejected.
 */

import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { generateEvidenceSigningKeyPair, toMinorUnits, Decision } from "@waysafe/core";
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { createStaticDirectory, parsePolicy, POLICY_SCHEMA_VERSION, type Policy } from "@waysafe/core";
import { erc20Abi, type Address, type Hex } from "viem";
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
import {
  AMOY_USDC_ADDRESS,
  attachForgedSignature,
  buildUsdcTransfer,
  createAmoyPublicClient,
  executeSafeTransaction,
  probeX402SafeAccount,
  signTwoOfTwoTransfer,
  signWithOneOwnerOnly,
  simulateExecTransaction,
} from "./x402-safe.js";
import { EnvSecp256k1Signer } from "../signing/env-signer.js";
import { requireX402LiveOrExplainSkip } from "./test-support/x402-gate.js";

const LIVE_PAYER_ACCOUNT_REACHABLE = probeX402SafeAccount();
requireX402LiveOrExplainSkip(
  "x402 on-chain rejection of a forged (no-real-key) payment envelope (D-41)",
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
      { deploySafe: async () => ({ safeAddress: "0x5555555555555555555555555555555555eeee" }) },
      {
        organizationId: ORG,
        mandateId,
        sessionKeyAddress: "0x1111111111111111111111111111111111aaaa",
        cosignerAddress: "0x2222222222222222222222222222222222bbbb",
      },
      NOW,
    );

    const signingKey = new FakeEd25519Signer();
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

// D-41: the gap D-40 left open is real, live on Amoy, driven against the
// actual deployed Safe -- no fake fetcher, no in-memory repository, nothing
// simulated except the negative cases' broadcast (deliberately -- see
// simulateExecTransaction's own doc comment for why an eth_call proof of
// on-chain rejection is exactly as genuine as a broadcast one, without
// spending gas on an outcome that's supposed to fail).
describe.skipIf(!LIVE_PAYER_ACCOUNT_REACHABLE)(
  "THE BYPASS TEST, part 3: the real 2-of-2 Safe on Polygon Amoy (D-41)",
  () => {
    const rpcUrl = process.env.POLYGON_AMOY_RPC_URL!;
    const safeAddress = process.env.WAYSAFE_X402_LIVE_PAYER_ACCOUNT! as Address;
    const cosignerPrivateKey = process.env.WAYSAFE_SAFE_COSIGNER_KEY! as Hex;
    const sessionKeyPrivateKey = process.env.WAYSAFE_X402_TEST_SESSION_KEY! as Hex;
    // D-63: the co-signer now goes through a Signer. The session key stays
    // a raw key here on purpose -- this block plays the *agent's* runtime,
    // which holds its own key by design (D-42); that is the whole premise
    // of the bypass cases below.
    const cosignerSigner = EnvSecp256k1Signer.fromHex(cosignerPrivateKey);
    // Resolved in beforeAll rather than inline: address() is async (a KMS
    // signer would be a network call), and a describe callback is not.
    let cosignerAddress: Address;
    let sessionKeyAddress: Address;
    beforeAll(async () => {
      cosignerAddress = await cosignerSigner.address();
      sessionKeyAddress = await EnvSecp256k1Signer.fromHex(sessionKeyPrivateKey).address();
    });

    // Small and constant so repeated runs against the same funded Safe
    // don't need re-funding between them -- 0.1 test USDC per genuine
    // transfer. Sent back to the cosigner's own EOA: this test's job is to
    // prove the *authorization mechanism*, not to move value to a third
    // party, so recycling it back to an address this session already
    // controls is the honest choice, not an arbitrary one.
    const TRANSFER_AMOUNT = 100_000n; // 0.1 USDC, 6 decimals

    it("a genuine 2-of-2 transfer (real session-key signature + real Waysafe co-signer signature) actually moves the Safe's test USDC on-chain", async () => {
      const publicClient = await createAmoyPublicClient(rpcUrl);
      const balanceOf = (address: Address) =>
        publicClient.readContract({
          address: AMOY_USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }) as Promise<bigint>;

      const [safeBefore, recipientBefore] = await Promise.all([balanceOf(safeAddress), balanceOf(cosignerAddress)]);
      expect(safeBefore).toBeGreaterThanOrEqual(TRANSFER_AMOUNT); // otherwise this is a funding gap, not a code bug

      const transfer = buildUsdcTransfer(cosignerAddress, TRANSFER_AMOUNT);
      const fullySigned = await signTwoOfTwoTransfer({
        rpcUrl,
        safeAddress,
        sessionKeyPrivateKey,
        cosignerPrivateKey,
        transaction: transfer,
      });
      const txHash = await executeSafeTransaction({ rpcUrl, safeAddress, executor: cosignerSigner, safeTransaction: fullySigned });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      expect(receipt.status).toBe("success");

      const [safeAfter, recipientAfter] = await Promise.all([balanceOf(safeAddress), balanceOf(cosignerAddress)]);
      expect(safeBefore - safeAfter).toBe(TRANSFER_AMOUNT);
      expect(recipientAfter - recipientBefore).toBe(TRANSFER_AMOUNT);
    }, 60_000);

    it("the session key's signature alone is rejected by the Safe contract itself (threshold 2, only 1 signature present)", async () => {
      const publicClient = await createAmoyPublicClient(rpcUrl);
      const transfer = buildUsdcTransfer(cosignerAddress, TRANSFER_AMOUNT);
      const signedBySessionOnly = await signWithOneOwnerOnly({
        rpcUrl,
        safeAddress,
        signerPrivateKey: sessionKeyPrivateKey,
        transaction: transfer,
      });

      const result = await simulateExecTransaction({ publicClient, safeAddress, safeTransaction: signedBySessionOnly });
      expect(result.ok).toBe(false);
    }, 30_000);

    it("a forged envelope -- a genuine Waysafe co-signature plus a fabricated session-key signature -- is rejected by the Safe contract itself", async () => {
      const publicClient = await createAmoyPublicClient(rpcUrl);
      const transfer = buildUsdcTransfer(cosignerAddress, TRANSFER_AMOUNT);
      const signedByCosignerOnly = await signWithOneOwnerOnly({
        rpcUrl,
        safeAddress,
        signerPrivateKey: cosignerPrivateKey,
        transaction: transfer,
      });
      const forged = attachForgedSignature(signedByCosignerOnly, sessionKeyAddress);

      const result = await simulateExecTransaction({ publicClient, safeAddress, safeTransaction: forged });
      expect(result.ok).toBe(false);
    }, 30_000);

    it("a real session-key signature with no Waysafe signature at all is rejected by the Safe contract itself", async () => {
      // Named separately per the task that produced this file, even though
      // the underlying mechanism is the same on-chain check as "the
      // session key alone" above: this is the literal envelope an
      // attacker holding a compromised agent runtime, and nothing else,
      // would be able to construct.
      const publicClient = await createAmoyPublicClient(rpcUrl);
      const transfer = buildUsdcTransfer(cosignerAddress, TRANSFER_AMOUNT);
      const signedBySessionOnly = await signWithOneOwnerOnly({
        rpcUrl,
        safeAddress,
        signerPrivateKey: sessionKeyPrivateKey,
        transaction: transfer,
      });

      const result = await simulateExecTransaction({
        publicClient,
        safeAddress,
        safeTransaction: signedBySessionOnly,
        signatures: signedBySessionOnly.encodedSignatures() as Hex,
      });
      expect(result.ok).toBe(false);
    }, 30_000);
  },
);
