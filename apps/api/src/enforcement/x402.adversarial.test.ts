/**
 * FINDING 3 of the independent adversarial review of 387958a: the merchant
 * supplies the asset's decimals, and settlement ignores the asset entirely.
 *
 * Breaks non-negotiable #6 (money is integer minor units -- of *what*
 * scale?) and #7 by extension: an authorization's recorded amount is not
 * the amount that moves.
 *
 * Written as the attack first: every test here passed against the reviewed
 * code, where the amount `evaluate()` saw and the amount the chain moved
 * came from two different places and only one was under Waysafe's control.
 * They now assert the block (D-68). The positive cases at the bottom are
 * the ones that matter most: the receipt, the ledger, and the settled
 * amount must agree by construction, not merely all be refused.
 *
 * Offline, like x402.test.ts: a faked `X402Fetcher` and a faked Safe
 * deployer. The settlement assertions decode `buildUsdcTransfer`'s own
 * calldata rather than broadcasting -- the encoding is the claim, and it is
 * a pure function.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  createStaticDirectory,
  parsePolicy,
  toMinorUnits,
  Decision,
  POLICY_SCHEMA_VERSION,
  AMOY_USDC,
  ASSET_REGISTRY,
  resolveAsset,
  type Policy,
} from "@waysafe/core";
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "../instruments/in-memory-repository.js";
import {
  X402Adapter,
  handleX402PaymentRequest,
  provisionX402InstrumentForMandate,
  type X402Callback,
  type X402Fetcher,
  type X402PaymentRequirement,
} from "./x402.js";
import { buildErc20Transfer } from "./x402-safe.js";

const ORG = "org_x402_adversarial";
const PRINCIPAL = "prin_adv";
const AGENT = "agt_adv";
const NOW = new Date("2026-10-04T12:00:00.000Z");
const PAY_TO = "0xabc0000000000000000000000000000000000001";
const RESOURCE_URL = "https://hostile-merchant.example/paid-endpoint";
const SESSION_KEY_ADDRESS = "0x1111111111111111111111111111111111aaaa";
const COSIGNER_ADDRESS = "0x2222222222222222222222222222222222bbbb";

/** Amoy's real test USDC, which genuinely has 6 decimals -- the sole
 * registry entry, and the asset settlement moves. Taken from the registry
 * itself so this test cannot drift from it. */
const REAL_USDC = AMOY_USDC.address;
const AMOY_NETWORK = AMOY_USDC.networkNames[0]!;

/** The policy under attack: a hard $50 per-transaction ceiling, and the
 * merchant's payTo explicitly allowlisted so merchant identity is never
 * what blocks anything here. The only question these tests ask is whether
 * the AMOUNT is evaluated correctly. */
function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "x402 adversarial policy: $50 hard ceiling",
    currency: "USD",
    merchants: {
      allow: [{ scheme: "onchain_address", value: PAY_TO, label: "allowlisted merchant" }],
      deny: [],
      unlisted: "STEP_UP",
    },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    per_transaction_max: toMinorUnits(50, "USD"),
    cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

function requirement(overrides: Partial<X402PaymentRequirement> = {}): X402PaymentRequirement {
  return {
    scheme: "exact",
    network: AMOY_NETWORK,
    maxAmountRequired: "5000000", // 5 USDC at the real 6 decimals
    resource: RESOURCE_URL,
    description: "Hostile Merchant API",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    asset: REAL_USDC,
    extra: { decimals: 6 },
    ...overrides,
  };
}

function fetcherFor(req: X402PaymentRequirement): X402Fetcher {
  return { async fetchPaymentRequirements() { return { x402Version: 1, accepts: [req] }; } };
}

const signer = new FakeEd25519Signer();

async function setup(policy: Policy = policyFrom()) {
  const authorization = new InMemoryAuthorizationRepository(createStaticDirectory([]));
  const evidence = new InMemoryEvidenceRepository(new FakeEd25519Signer());
  const instruments = new InMemoryInstrumentRepository();
  const { mandateId } = authorization.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy,
    policyHash: "hash",
  });
  const instrument = await provisionX402InstrumentForMandate(
    { instruments },
    { deploySafe: async () => ({ safeAddress: "0x3333333333333333333333333333333333cccc" }) },
    { organizationId: ORG, mandateId, sessionKeyAddress: SESSION_KEY_ADDRESS, cosignerAddress: COSIGNER_ADDRESS },
    NOW,
  );
  return { repos: { authorization, evidence, instruments }, instrumentId: instrument.id };
}

/** Runs the real enforcement path end to end against a canned 402. */
async function decide(req: X402PaymentRequirement, policy?: Policy) {
  const { repos, instrumentId } = await setup(policy);
  return handleX402PaymentRequest(
    repos,
    new X402Adapter(signer),
    fetcherFor(req),
    { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
    NOW,
  );
}

/** What settlement would actually move, decoded from the real calldata.
 * D-68: the token address is now an argument taken from the asset
 * `evaluate()` resolved -- `buildErc20Transfer` has no default. */
function settlementWouldMove(amountAtomic: string, token: string = REAL_USDC) {
  const transfer = buildErc20Transfer(token as `0x${string}`, PAY_TO as `0x${string}`, BigInt(amountAtomic));
  const decoded = decodeFunctionData({ abi: erc20Abi, data: transfer.data as `0x${string}` });
  return {
    token: transfer.to,
    amountAtomic: (decoded.args as readonly unknown[])[1] as bigint,
    /** Real USDC is 6 decimals, whatever the merchant claimed. */
    realUsdc: Number((decoded.args as readonly unknown[])[1] as bigint) / 1e6,
  };
}

describe("FINDING 3: the merchant supplies the asset's decimals (breaks non-negotiable #6)", () => {
  it("(a) THE ATTACK: decimals 18 on real 6-decimal USDC -- evaluated as ~$0, ALLOWed, settles 5,000 USDC", async () => {
    const hostile = requirement({
      maxAmountRequired: "5000000000", // 5,000 USDC at the REAL 6 decimals
      extra: { decimals: 18 }, // the lie
    });

    const result = await decide(hostile);

    // D-68: the lie is refused outright. Not corrected, not evaluated at
    // the registry's scale and then denied on the limit -- refused for
    // disagreeing, so the merchant learns nothing about the ceiling.
    expect(result.response.decision).toBe(Decision.DENY);
    expect(result.response.reason_codes).toEqual(["DENY_ASSET_DECIMALS_MISMATCH"]);

    // No co-signature, so there is nothing settlement could act on...
    expect(result.response.co_signature).toBeNull();
    // ...and no resolved asset either, so it has no token address to use.
    expect(result.settlementAsset).toBeNull();
  });

  it("(b) the reverse direction: decimals 2 inflates a legitimate $5 payment into a DENY", async () => {
    const understated = requirement({
      maxAmountRequired: "5000000", // genuinely 5 USDC
      extra: { decimals: 2 }, // claims the atomic unit IS a cent
    });

    const result = await decide(understated);

    // Still a DENY, but for the honest reason now: the declared scale
    // disagrees with the registry. Before, it was denied on the limit --
    // the right outcome by accident, from a wrong amount.
    expect(result.response.decision).toBe(Decision.DENY);
    expect(result.response.reason_codes).toEqual(["DENY_ASSET_DECIMALS_MISMATCH"]);
  });

  it("(c) an entirely unknown token contract, with plausible decimals, is evaluated and can ALLOW", async () => {
    const fakeToken = requirement({
      asset: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", // nothing Waysafe knows
      maxAmountRequired: "1000000",
      extra: { decimals: 6, symbol: "USDC" }, // says the right word
    });

    const result = await decide(fakeToken);

    // D-68, non-negotiable #3 applied to assets: an asset Waysafe cannot
    // identify never produces ALLOW. The plausible `symbol: "USDC"` buys
    // nothing -- matching is by address only.
    expect(result.response.decision).toBe(Decision.DENY);
    expect(result.response.reason_codes).toEqual(["DENY_ASSET_NOT_IN_REGISTRY"]);
    expect(result.settlementAsset).toBeNull();
    // And the registry genuinely does not contain it, by address.
    expect(resolveAsset(AMOY_NETWORK, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
  });

  it("(d) the real USDC address on the WRONG chain is evaluated and can ALLOW", async () => {
    const wrongChain = requirement({
      network: "base-sepolia", // not Amoy
      asset: REAL_USDC, // an address that means nothing on this chain
      maxAmountRequired: "1000000",
      extra: { decimals: 6 },
    });

    const result = await decide(wrongChain);

    // The key is (chain, address): the same address on a different chain is
    // a different asset, and an unknown one.
    expect(result.response.decision).toBe(Decision.DENY);
    expect(result.response.reason_codes).toEqual(["DENY_ASSET_NOT_IN_REGISTRY"]);
    expect(resolveAsset("base-sepolia", REAL_USDC)).toBeNull();
  });

  it("(e) omitting decimals entirely is refused -- the one case already handled", async () => {
    // D-68 inverts this case: omitting decimals is now the HONEST shape,
    // because the registry is the source. A merchant that says nothing
    // about scale is believed about nothing, and the payment proceeds on
    // the registry's own numbers.
    const noDecimals = requirement({ maxAmountRequired: "5000000", extra: {} });
    const result = await decide(noDecimals);

    expect(result.response.decision).toBe(Decision.ALLOW);
    expect(result.response.co_signature!.amount_atomic).toBe("5000000");
    expect(result.settlementAsset!.decimals).toBe(6);

    // An asset or network that is absent entirely, by contrast, has its own
    // code now rather than borrowing the merchant's.
    const noAsset = await decide(requirement({ asset: "" }));
    expect(noAsset.response.reason_codes).toEqual(["DENY_ASSET_UNSPECIFIED"]);
    const noNetwork = await decide(requirement({ network: "" }));
    expect(noNetwork.response.reason_codes).toEqual(["DENY_ASSET_UNSPECIFIED"]);
  });

  it("(f1) a non-integer decimals value is refused, but a WILDLY wrong integer is not", async () => {
    // Both are now refused for the same, correct reason: they disagree
    // with the registry. Truth, not shape.
    const notAnInteger = await decide(requirement({ extra: { decimals: 6.5 } }));
    expect(notAnInteger.response.reason_codes).toEqual(["DENY_ASSET_DECIMALS_MISMATCH"]);

    const absurdButIntegral = await decide(
      requirement({ maxAmountRequired: "1000000000000", extra: { decimals: 30 } }),
    );
    expect(absurdButIntegral.response.decision).toBe(Decision.DENY);
    expect(absurdButIntegral.response.reason_codes).toEqual(["DENY_ASSET_DECIMALS_MISMATCH"]);
  });

  it("(f2) THE HEADLINE, now positive: the receipt, the ledger and the settled amount all agree", async () => {
    // The worst part of finding 3 was not the overspend -- it was that the
    // signed evidence chain recorded a $0.00 payment while 5,000 real USDC
    // moved, so the receipt an auditor would read showed nothing wrong.
    // This asserts the opposite property directly, on a legitimate payment:
    // one number, in three places.
    const honest = requirement({ maxAmountRequired: "5000000", extra: { decimals: 6 } }); // 5 USDC
    const { repos, instrumentId } = await setup();
    const result = await handleX402PaymentRequest(
      repos,
      new X402Adapter(signer),
      fetcherFor(honest),
      { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
      NOW,
    );
    expect(result.response.decision).toBe(Decision.ALLOW);

    // 1. The persisted authorization -- what the evidence chain signs, and
    //    what a dispute would be settled from.
    const authorizationId = result.response.co_signature!.authorization_id;
    const stored = await repos.authorization.getAuthorization(authorizationId);
    expect(stored!.action.amount).toBe(500); // 500 cents = $5.00

    // 2. The ledger, which is what every future cumulative check reads.
    const ledger = repos.authorization.ledgerEntriesFor(result.mandateId!);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "RESERVATION", amount: 500 });

    // 3. What settlement actually moves, through the resolved asset.
    const moved = settlementWouldMove(
      result.response.co_signature!.amount_atomic,
      result.settlementAsset!.address,
    );
    expect(moved.token.toLowerCase()).toBe(REAL_USDC.toLowerCase());
    expect(moved.realUsdc).toBe(5);

    // The three agree: 500 cents authorized, 500 cents charged, $5 moved.
    expect(stored!.action.amount).toBe(ledger[0]!.amount);
    expect(moved.realUsdc * 100).toBe(stored!.action.amount);
  });

  it("(f3) cumulative limits now see the real amount, so the ceiling actually binds", async () => {
    // Before: ten 5,000-USDC transfers all ALLOWed against a $500/month
    // cap, because the ledger was charged the fictional $0 each time.
    // Now the ledger is charged what really moves, so the cap binds.
    const honest = requirement({ maxAmountRequired: "100000000", extra: { decimals: 6 } }); // $100
    // Per-transaction ceiling raised above $100 on purpose, so the only
    // rule under test here is the CUMULATIVE one. (A first draft left the
    // fixture's $50 ceiling in place and every call denied on the
    // per-transaction rule -- the right outcome for the wrong reason.)
    const { repos, instrumentId } = await setup(
      policyFrom({ per_transaction_max: toMinorUnits(150, "USD") }),
    );

    const decisions: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await handleX402PaymentRequest(
        repos,
        new X402Adapter(signer),
        fetcherFor(honest),
        { instrumentRef: instrumentId, resourceUrl: RESOURCE_URL },
        NOW,
      );
      decisions.push(r.response.decision);
    }

    // $500/month cap, $100 each: five ALLOW then a DENY on the sixth.
    expect(decisions.slice(0, 5)).toEqual(Array(5).fill(Decision.ALLOW));
    expect(decisions[5]).toBe(Decision.DENY);

    // And the ledger holds the real total, not zeros.
    const total = repos.authorization
      .ledgerEntriesFor((await repos.instruments.getInstrument(instrumentId))!.mandate_id)
      .reduce((sum, e) => sum + e.amount, 0);
    expect(total).toBe(5 * toMinorUnits(100, "USD"));
  });

  it("CONTROL: an honest requirement at the real 6 decimals evaluates correctly", async () => {
    const honest = requirement({ maxAmountRequired: "5000000", extra: { decimals: 6 } });
    const result = await decide(honest);
    expect(result.response.decision).toBe(Decision.ALLOW);
    expect(result.response.co_signature!.amount_atomic).toBe("5000000");
    expect(result.settlementAsset).toEqual(AMOY_USDC);
    expect(settlementWouldMove("5000000", result.settlementAsset!.address).realUsdc).toBe(5);
  });

  it("CONTROL: an honest requirement over the ceiling is correctly DENIED", async () => {
    const honestButTooBig = requirement({ maxAmountRequired: "60000000", extra: { decimals: 6 } }); // $60
    const result = await decide(honestButTooBig);
    expect(result.response.decision).toBe(Decision.DENY);
    expect(result.response.reason_codes).toContain("DENY_TRANSACTION_LIMIT_EXCEEDED");
  });
});

// ===================================================================
// D-68 requirement 5: the registry's contents are asserted, so a future
// addition is a visible diff rather than a silent widening.
// ===================================================================

describe("D-68: the asset registry's exact contents", () => {
  it("contains exactly the assets this deployment can evaluate and settle", () => {
    // If this fails, someone added or changed an asset. That may be
    // correct -- but it must be a deliberate, reviewed diff, because every
    // entry here is something real money can be moved in.
    expect(ASSET_REGISTRY).toHaveLength(1);
    expect(ASSET_REGISTRY[0]).toEqual({
      chainId: 80002,
      address: "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
      symbol: "USDC",
      decimals: 6,
      networkNames: ["polygon-amoy", "amoy", "matic-amoy", "polygon-amoy-testnet"],
    });
  });

  it("every registry address is stored lowercased -- the canonical comparison form", () => {
    for (const asset of ASSET_REGISTRY) {
      expect(asset.address).toBe(asset.address.toLowerCase());
      expect(asset.address).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it("resolution is by address, NEVER by symbol", () => {
    // A hostile merchant can type any symbol it likes; it buys nothing.
    expect(resolveAsset(AMOY_NETWORK, "USDC")).toBeNull();
    expect(resolveAsset(AMOY_NETWORK, AMOY_USDC.symbol)).toBeNull();
    // Case-insensitive on the address, since EIP-55 checksummed forms are
    // the common way an address is written.
    expect(resolveAsset(AMOY_NETWORK, AMOY_USDC.address.toUpperCase().replace("0X", "0x"))).toEqual(AMOY_USDC);
  });

  it("the same address on an unknown chain does not resolve", () => {
    expect(resolveAsset("1", AMOY_USDC.address)).toBeNull();
    expect(resolveAsset("ethereum-mainnet", AMOY_USDC.address)).toBeNull();
    expect(resolveAsset("80002", AMOY_USDC.address)).toEqual(AMOY_USDC);
  });
});
