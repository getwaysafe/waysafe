/**
 * D-41: the 2-of-2 payer Safe D-40 specified but declined to deploy, and
 * the direct-transfer settlement fallback its own custody comment
 * anticipated needing.
 *
 * D-40 built the co-signature half of x402 enforcement and stopped there,
 * deliberately: "the smallest payer-account design that would close the
 * gap, not built here... a 2-of-2 smart account per mandate... one owner
 * slot a session key scoped to the mandate and held by the agent's
 * runtime... the other owner slot this adapter's signing key." This file
 * builds that account, using the Safe protocol (`@safe-global/
 * protocol-kit`) on Polygon Amoy (chain id 80002) rather than a hand-rolled
 * ERC-4337 account -- Safe's `execTransaction` threshold check is exactly
 * the "neither half alone satisfies the validator" property D-40 asked
 * for, and it is a live, audited, canonical-address contract on Amoy
 * already (`@safe-global/safe-deployments`), so nothing about the
 * account's own validation logic is this codebase's to get right or wrong.
 *
 * **Two co-signer keys now exist, and they are not interchangeable.**
 * `WAYSAFE_X402_COSIGNER_KEY` (x402-signing-key.ts, D-40) is Ed25519 --
 * fine for signing an off-chain attestation over a payment intent
 * (`X402CoSignature`), but Safe owners are secp256k1 EVM addresses derived
 * from ECDSA keys, and Ed25519 has no such address at all. There is no
 * value of that key that could ever be added as a Safe owner. So this file
 * introduces `WAYSAFE_SAFE_COSIGNER_KEY`, a genuinely separate secp256k1
 * key (`.env`, testnet only, never committed -- same secrecy discipline as
 * every other key in this file's family): the key that is actually one of
 * the Safe's two owners, and the one whose signature is actually necessary
 * on-chain to move the Safe's funds. `WAYSAFE_X402_COSIGNER_KEY` still
 * exists and still means what D-40 said it means -- an off-chain
 * decision-attestation signature, evidence-grade, never spendable by
 * itself -- but it is not, and structurally cannot be, this account's
 * second owner. Two keys, two trust boundaries, same reasoning
 * x402-signing-key.ts already gives for keeping *that* key separate from
 * the evidence-signing key: conflating them would blur what each one
 * actually attests.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
// `@safe-global/protocol-kit`'s shipped type declarations resolve as a CJS
// module under this project's NodeNext moduleResolution, so a plain
// `import Safe from "..."` default import type-checks as the whole module
// namespace instead of the class -- confirmed a real runtime/type mismatch,
// not a project misconfiguration, by checking the resolved .d.ts directly.
// Importing the namespace and reading `.default` sidesteps the interop
// quirk; `Safe.init(...)` below is the same call either way.
import * as SafeModule from "@safe-global/protocol-kit";
import { EthSafeSignature } from "@safe-global/protocol-kit";
import type {
  ConnectSafeConfig,
  CreateTransactionProps,
  SafeConfig,
} from "@safe-global/protocol-kit";
import type {
  MetaTransactionData,
  SafeTransaction,
  SafeTransactionData,
  Transaction,
  TransactionOptions,
  TransactionResult,
} from "@safe-global/types-kit";

/** The subset of `Safe`'s real instance API this file calls -- typed by
 * hand against the real named types (`SafeConfig`, `CreateTransactionProps`,
 * etc., which resolve correctly; only the default *class* export is
 * affected by the interop quirk above) because the class type itself
 * cannot be named directly here. */
interface SafeKit {
  connect(config: ConnectSafeConfig): Promise<SafeKit>;
  getAddress(): Promise<string>;
  isSafeDeployed(): Promise<boolean>;
  createSafeDeploymentTransaction(): Promise<Transaction>;
  createTransaction(props: CreateTransactionProps): Promise<SafeTransaction>;
  signTransaction(tx: SafeTransaction): Promise<SafeTransaction>;
  executeTransaction(tx: SafeTransaction, options?: TransactionOptions): Promise<TransactionResult>;
}
interface SafeStatic {
  init(config: SafeConfig): Promise<SafeKit>;
}
const Safe = SafeModule.default as unknown as SafeStatic;

export const AMOY_CHAIN_ID = 80002;

/**
 * Hard runtime guard against exactly the failure this session already hit
 * once: `POLYGON_AMOY_RPC_URL` silently pointing at Polygon mainnet (chain
 * 137) instead of Amoy. `viem`'s `polygonAmoy` chain object is a static
 * label this codebase supplies -- it asserts nothing about what
 * `POLYGON_AMOY_RPC_URL` actually points at, so every function in this file
 * that deploys a contract or broadcasts a transaction calls this first,
 * against a real `eth_chainId` round trip to the configured RPC, never
 * against the chain object alone. Throws, never returns false -- there is
 * no caller in this file for which "wrong chain" is a value worth
 * continuing past.
 */
export async function assertAmoyChainId(rpcUrl: string): Promise<void> {
  const client = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== AMOY_CHAIN_ID) {
    throw new Error(
      `Refusing to proceed: POLYGON_AMOY_RPC_URL (${rpcUrl}) reports chainId ${chainId}, not Amoy's ` +
        `${AMOY_CHAIN_ID}. This check exists because a misconfigured RPC URL pointing at mainnet would ` +
        "otherwise deploy real contracts and move real funds under the illusion of a testnet.",
    );
  }
}

/**
 * Circle's own official testnet USDC on Polygon Amoy
 * (https://developers.circle.com/stablecoins/usdc-contract-addresses,
 * fetched directly rather than assumed from memory -- testnet addresses
 * are not guessable and this codebase's own testing posture forbids it).
 * Verified independently against `POLYGON_AMOY_RPC_URL` before this
 * constant was written: `eth_getCode` shows a deployed contract,
 * `symbol()`/`name()` return `"USDC"`, `decimals()` returns `6`. See
 * `X402_SAFE_SETTLEMENT_MODE` for the further on-chain check this address
 * was used for.
 */
export const AMOY_USDC_ADDRESS: Address = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";

/**
 * The task's own instruction was "determine whether Amoy's test USDC
 * supports EIP-1271 for transferWithAuthorization... do not guess; check
 * on-chain" -- so this value is the answer, checked, not assumed:
 * `"erc20_transfer_fallback"`.
 *
 * What was actually checked: `AMOY_USDC_ADDRESS` is a proxy (its
 * implementation lives behind the legacy `org.zeppelinos.proxy.
 * implementation` storage slot, not EIP-1967 -- this proxy predates that
 * standard) whose implementation, at the time of this check, was
 * `0xc8a087ac4bab015261dfc3469201f1169b8a5e00`. That implementation's
 * bytecode contains the 4-byte selectors for `transferWithAuthorization`
 * and `receiveWithAuthorization` (EIP-3009 is present) but contains no
 * reference anywhere to `0x1626ba7e` -- the EIP-1271
 * `isValidSignature(bytes32,bytes)` selector, which is also EIP-1271's own
 * "magic value," so a contract that calls it via OpenZeppelin's
 * `SignatureChecker` (the only mechanism that would let a smart-contract
 * signer like a Safe satisfy an EIP-3009 authorization) would necessarily
 * embed that exact 4-byte constant as a literal comparison somewhere in
 * its bytecode. Its total absence means this token's authorization
 * signature check is plain-ECDSA-recover only: it can never accept a
 * signature from an account, like a Safe, that has no private key of its
 * own.
 *
 * Consequence: the Safe this file deploys cannot pay by having
 * `transferWithAuthorization` "just work" the way it would for a plain
 * EOA payer -- there is no signature the Safe could produce that this
 * token would accept for that function, full stop, regardless of how many
 * owners sign. This also means this adapter cannot participate in a
 * standard x402 "exact" scheme facilitator flow (which expects an
 * EIP-3009-authorized X-PAYMENT header) on this asset today -- that
 * remains explicitly deferred, exactly as D-40 already deferred the rest
 * of the facilitator integration.
 *
 * The fallback this file builds instead: the Safe calls its own
 * `execTransaction` (2-of-2 signed, the actual security property D-40
 * wanted) to invoke the token's plain `transfer(to, amount)`. That is a
 * real, correct, on-chain USDC payment to `payTo` -- it just is not the
 * specific settlement mechanism the x402 spec's own "exact" scheme
 * defines, so a resource server's facilitator expecting to verify an
 * EIP-3009 authorization would not recognize it as one. Documented here,
 * not silently papered over.
 */
export const X402_SAFE_SETTLEMENT_MODE = "erc20_transfer_fallback" as const;

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Minimal, hand-written ABI fragment for Safe v1.4.1's `execTransaction`
 * -- confirmed against `@safe-global/safe-deployments`'s own
 * `v1.4.1/safe_l2.json` artifact rather than assumed, since this is the
 * one call this file needs to construct by hand for the bypass test's
 * negative-path proofs (see `simulateExecTransaction` below). Safe's
 * public interface here has been stable since v1.3.0 and is one of the
 * most heavily depended-upon signatures in the ecosystem. */
export const SAFE_EXEC_TRANSACTION_ABI = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

/**
 * Loads `WAYSAFE_SAFE_COSIGNER_KEY` (a secp256k1 private key, `0x`-prefixed
 * hex) if set; otherwise generates a fresh one for this process only,
 * mirroring x402-signing-key.ts's ephemeral dev fallback exactly. An
 * ephemeral key here is strictly worse than there: this key must also be
 * one of a real, deployed Safe's two owners, so a fresh one every restart
 * means every previously deployed Safe becomes permanently unspendable
 * (its second owner no longer corresponds to any key anyone holds). Never
 * rely on the fallback outside a throwaway local check.
 */
export function loadOrGenerateSafeCosignerKey(warn?: (message: string) => void): Hex {
  const configured = process.env.WAYSAFE_SAFE_COSIGNER_KEY;
  if (configured) return configured as Hex;

  (warn ?? console.warn)(
    "WAYSAFE_SAFE_COSIGNER_KEY not set -- generated an ephemeral secp256k1 co-signer key for this " +
      "process only. This key must be a permanent owner of every mandate's deployed Safe, so an " +
      "ephemeral one makes every such Safe unspendable the moment this process exits. Generate a " +
      "real one with `npm run keygen -w @waysafe/api` and put it in .env before deploying anything.",
  );
  return generatePrivateKey();
}

/** True only when every prerequisite the live bypass test needs is
 * present: the real secp256k1 co-signer key, an Amoy RPC endpoint, a
 * deployed Safe to test against, and the test's own stand-in for "the
 * agent's runtime" session key. Checked eagerly and cheaply (env
 * presence only, no network call) so the gate itself never needs a live
 * RPC round trip just to decide whether to run. */
export function probeX402SafeAccount(): boolean {
  return Boolean(
    process.env.WAYSAFE_SAFE_COSIGNER_KEY &&
      process.env.POLYGON_AMOY_RPC_URL &&
      process.env.WAYSAFE_X402_LIVE_PAYER_ACCOUNT &&
      process.env.WAYSAFE_X402_TEST_SESSION_KEY,
  );
}

export interface SafeOwners {
  sessionKeyAddress: Address;
  cosignerAddress: Address;
}

/** The account config every mandate's Safe shares: exactly the two owners
 * D-40's custody comment named, threshold 2 -- neither owner alone can
 * ever satisfy it. */
function safeAccountConfig(owners: SafeOwners) {
  return { owners: [owners.sessionKeyAddress, owners.cosignerAddress], threshold: 2 };
}

/** The Safe's counterfactual address before it's deployed -- Safe accounts
 * are CREATE2 addresses, deterministic from the owner set alone, so this
 * is safe to compute (and safe to store as an Instrument's `externalRef`)
 * before `deploySafeTwoOfTwo` ever sends a transaction. */
export async function predictSafeAddress(rpcUrl: string, owners: SafeOwners): Promise<Address> {
  const protocolKit = await Safe.init({
    provider: rpcUrl,
    predictedSafe: { safeAccountConfig: safeAccountConfig(owners) },
  });
  return (await protocolKit.getAddress()) as Address;
}

export interface SafeDeploymentResult {
  safeAddress: Address;
  alreadyDeployed: boolean;
  txHash?: Hex;
}

/**
 * Deploys the 2-of-2 Safe for one mandate's x402 instrument. Idempotent:
 * if a Safe already sits at the predicted CREATE2 address (this function
 * was already run for these exact owners), it returns that address
 * without sending a second transaction. `deployerPrivateKey` pays gas --
 * either owner can be the deployer; nothing about Safe deployment requires
 * it to be a particular one.
 */
export async function deploySafeTwoOfTwo(params: {
  rpcUrl: string;
  deployerPrivateKey: Hex;
  owners: SafeOwners;
}): Promise<SafeDeploymentResult> {
  await assertAmoyChainId(params.rpcUrl);

  const protocolKit = await Safe.init({
    provider: params.rpcUrl,
    signer: params.deployerPrivateKey,
    predictedSafe: { safeAccountConfig: safeAccountConfig(params.owners) },
  });
  const safeAddress = (await protocolKit.getAddress()) as Address;

  if (await protocolKit.isSafeDeployed()) {
    return { safeAddress, alreadyDeployed: true };
  }

  const deploymentTransaction = await protocolKit.createSafeDeploymentTransaction();
  const account = privateKeyToAccount(params.deployerPrivateKey);
  const walletClient = createWalletClient({ account, chain: polygonAmoy, transport: http(params.rpcUrl) });
  const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(params.rpcUrl) });

  const txRequest = {
    to: deploymentTransaction.to as Address,
    data: deploymentTransaction.data as Hex,
    value: BigInt(deploymentTransaction.value),
  };

  // Checked empirically against this RPC, not assumed: its own
  // `eth_estimateGas` for the Safe factory's `createProxyWithNonce`
  // undershoots the gas the internal CREATE2 call actually needs (a
  // documented class of issue with this call shape on some providers --
  // the 63/64ths forwarding rule for an internal `create2` inside a
  // sub-call isn't accounted for by every estimator). Confirmed by
  // simulating the exact reverting request at 2x the RPC's own estimate
  // and watching it succeed. Padding here rather than trusting the
  // estimate outright avoids a broadcast transaction reverting on-chain
  // (and burning real gas) purely from an estimation shortfall.
  const estimated = await publicClient.estimateGas({ account: account.address, ...txRequest });
  const gas = estimated * 2n;

  const txHash = await walletClient.sendTransaction({ ...txRequest, gas });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { safeAddress, alreadyDeployed: false, txHash };
}

/** The real `X402SafeDeployer` (x402.ts) -- wraps `deploySafeTwoOfTwo` so
 * `provisionX402InstrumentForMandate` doesn't need to know this file's
 * shape, the same injectable-dependency pattern `X402Fetcher` already uses
 * for the same reason: the offline test suite substitutes a fake here,
 * never a real RPC call. */
export function createOnChainSafeDeployer(params: { rpcUrl: string; cosignerPrivateKey: Hex }): {
  deploySafe(owners: SafeOwners): Promise<{ safeAddress: string }>;
} {
  return {
    async deploySafe(owners: SafeOwners) {
      const deployment = await deploySafeTwoOfTwo({
        rpcUrl: params.rpcUrl,
        deployerPrivateKey: params.cosignerPrivateKey,
        owners,
      });
      return { safeAddress: deployment.safeAddress };
    },
  };
}

/** The settlement fallback `X402_SAFE_SETTLEMENT_MODE` documents: a plain
 * ERC-20 `transfer(to, amount)` on Amoy's test USDC, to be wrapped in a
 * Safe transaction rather than sent directly (a Safe has no private key of
 * its own to send anything directly -- every one of its actions is an
 * `execTransaction` call). */
export function buildUsdcTransfer(to: Address, amountAtomic: bigint): MetaTransactionData {
  return {
    to: AMOY_USDC_ADDRESS,
    value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amountAtomic] }),
  };
}

/**
 * Builds and genuinely signs a Safe transaction with both real owner keys
 * -- the "genuine 2-of-2 transfer" path. Returns the fully-signed
 * transaction; `executeSafeTransaction` below actually broadcasts it.
 * Kept as two steps (build+sign, then execute) rather than one so the
 * bypass test's negative cases can reuse the *build* half while
 * substituting a forged or missing signature for the *sign* half.
 */
export async function signTwoOfTwoTransfer(params: {
  rpcUrl: string;
  safeAddress: Address;
  sessionKeyPrivateKey: Hex;
  cosignerPrivateKey: Hex;
  transaction: MetaTransactionData;
}): Promise<SafeTransaction> {
  const sessionKit = await Safe.init({
    provider: params.rpcUrl,
    signer: params.sessionKeyPrivateKey,
    safeAddress: params.safeAddress,
  });
  const safeTransaction = await sessionKit.createTransaction({ transactions: [params.transaction] });
  const signedBySession = await sessionKit.signTransaction(safeTransaction);

  const cosignerKit = await sessionKit.connect({ signer: params.cosignerPrivateKey });
  return cosignerKit.signTransaction(signedBySession);
}

/** Builds the same transaction as `signTwoOfTwoTransfer` but signs with
 * only one owner key -- the "session key alone" / "no Waysafe signature"
 * bypass case. Never sufficient to execute; see `simulateExecTransaction`.
 */
export async function signWithOneOwnerOnly(params: {
  rpcUrl: string;
  safeAddress: Address;
  signerPrivateKey: Hex;
  transaction: MetaTransactionData;
}): Promise<SafeTransaction> {
  const kit = await Safe.init({
    provider: params.rpcUrl,
    signer: params.signerPrivateKey,
    safeAddress: params.safeAddress,
  });
  const safeTransaction = await kit.createTransaction({ transactions: [params.transaction] });
  return kit.signTransaction(safeTransaction);
}

/** Takes a transaction genuinely signed by one real owner and attaches a
 * *fabricated* signature claiming to be the other owner's -- the "forged
 * envelope" bypass case. `fabricatedSignerAddress` is the address the
 * forged signature claims to be from (the real session key's address, if
 * this is simulating an attacker who has a genuine Waysafe co-signature
 * but no real session key); the signature bytes themselves are random
 * garbage, never produced by any real private key. */
export function attachForgedSignature(
  safeTransaction: SafeTransaction,
  fabricatedSignerAddress: Address,
): SafeTransaction {
  const garbage = ("0x" + "ab".repeat(65)) as Hex; // 65 bytes: not a real (r,s,v) from any key
  safeTransaction.addSignature(new EthSafeSignature(fabricatedSignerAddress, garbage, false));
  return safeTransaction;
}

/** Actually broadcasts a fully-signed Safe transaction. `executorPrivateKey`
 * pays gas -- must be a real owner key (Safe requires the caller to be an
 * owner or hold a valid signature set; either owner can execute once the
 * signature threshold is met). */
export async function executeSafeTransaction(params: {
  rpcUrl: string;
  safeAddress: Address;
  executorPrivateKey: Hex;
  safeTransaction: SafeTransaction;
}): Promise<Hex> {
  await assertAmoyChainId(params.rpcUrl);

  const kit = await Safe.init({
    provider: params.rpcUrl,
    signer: params.executorPrivateKey,
    safeAddress: params.safeAddress,
  });

  // Same empirically-confirmed underestimation risk as
  // `deploySafeTwoOfTwo` -- `execTransaction`'s own internal call to the
  // target contract is exactly the kind of nested-call gas accounting an
  // estimator can undershoot. Pad from a real estimate of the same call
  // this file's own `simulateExecTransaction` builds, rather than letting
  // protocol-kit's default estimation risk an on-chain revert.
  const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(params.rpcUrl) });
  const executor = privateKeyToAccount(params.executorPrivateKey);
  const estimated = await publicClient.estimateContractGas({
    account: executor.address,
    address: params.safeAddress,
    abi: SAFE_EXEC_TRANSACTION_ABI,
    functionName: "execTransaction",
    args: execTransactionArgs(params.safeTransaction),
  });

  const result = await kit.executeTransaction(params.safeTransaction, { gasLimit: estimated * 2n });
  return result.hash as Hex;
}

/**
 * Simulates (never broadcasts -- `eth_call`, no gas spent) a call to the
 * Safe's own `execTransaction` with whatever signature bytes the caller
 * hands it, genuine or forged. This is what makes the bypass test's
 * negative cases a real on-chain proof rather than a client-side SDK
 * guard: it hits the deployed Safe contract's actual `checkNSignatures`
 * logic on Amoy and reports exactly what the chain itself decides,
 * because `execTransaction`'s ABI, args, and the target contract are
 * identical whether this call is simulated or broadcast -- only whether
 * the result is persisted differs. Returns `{ok: false}` on any revert;
 * never throws, so a caller can assert rejection without a try/catch.
 */
/** The `execTransaction` positional args for a given (possibly
 * signature-overridden) `SafeTransaction` -- shared by
 * `simulateExecTransaction` and `executeSafeTransaction`'s gas estimate so
 * the two never drift into simulating/estimating a subtly different call
 * than the one actually executed. */
function execTransactionArgs(
  safeTransaction: SafeTransaction,
  signatures?: Hex,
): readonly [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex] {
  const data: SafeTransactionData = safeTransaction.data;
  return [
    data.to as Address,
    BigInt(data.value),
    data.data as Hex,
    data.operation,
    BigInt(data.safeTxGas),
    BigInt(data.baseGas),
    BigInt(data.gasPrice),
    (data.gasToken as Address) || ZERO_ADDRESS,
    (data.refundReceiver as Address) || ZERO_ADDRESS,
    signatures ?? (safeTransaction.encodedSignatures() as Hex),
  ];
}

export async function simulateExecTransaction(params: {
  publicClient: PublicClient;
  safeAddress: Address;
  safeTransaction: SafeTransaction;
  /** Overrides the transaction's own encoded signatures -- lets a caller
   * pass a set the SDK itself wouldn't build (e.g. a single signature
   * against a threshold-2 Safe), which `SafeTransaction.encodedSignatures`
   * would still happily produce, so this override exists only for
   * clarity at call sites, not because the default is wrong. */
  signatures?: Hex;
}): Promise<{ ok: boolean; revertReason?: string }> {
  try {
    await params.publicClient.simulateContract({
      address: params.safeAddress,
      abi: SAFE_EXEC_TRANSACTION_ABI,
      functionName: "execTransaction",
      args: execTransactionArgs(params.safeTransaction, params.signatures),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, revertReason: err instanceof Error ? err.message : String(err) };
  }
}

/** Async, deliberately: asserts the live chain id (`assertAmoyChainId`)
 * before handing back a client any caller might use to read balances, run
 * simulations, or (via the other functions in this file) broadcast
 * transactions. A synchronous version of this function would tempt a
 * caller into skipping the check by construction. */
export async function createAmoyPublicClient(rpcUrl: string): Promise<PublicClient> {
  await assertAmoyChainId(rpcUrl);
  return createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) }) as PublicClient;
}

export function addressFromPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}
