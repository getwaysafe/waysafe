/**
 * D-41 deployment/status script for the x402 2-of-2 payer Safe.
 *
 * Idempotent and safe to re-run at any point -- it always reports exactly
 * what state the deployment is in and what to do next, rather than assuming
 * progress from a previous run. Three states, in order:
 *
 *   1. Owner EOAs unfunded -- prints both addresses and stops. Fund both
 *      with a small amount of Amoy POL (gas only, never USDC).
 *   2. Owner EOAs funded, Safe not yet deployed (or deployed but empty) --
 *      deploys the Safe if needed (a no-op if it already exists at the
 *      predicted CREATE2 address -- see `deploySafeTwoOfTwo`), then prints
 *      the Safe's own address and stops if it holds no test USDC yet. Fund
 *      the *Safe address*, never the EOAs, with test USDC.
 *   3. Safe deployed and funded -- prints a ready summary. At this point
 *      `WAYSAFE_REQUIRE_X402_LIVE=1 npx vitest run
 *      apps/api/src/enforcement/x402.bypass.test.ts` exercises the real
 *      on-chain proofs.
 *
 *   npm run deploy-x402-safe -w @waysafe/api
 *
 * This script's own output is a chat transcript in this project's usual
 * mode of operation, not just a terminal only the operator sees -- so it
 * must never print a raw private key. `WAYSAFE_X402_TEST_SESSION_KEY` (the
 * bypass test's own stand-in for "the agent's runtime" session key) is
 * generated and written directly into `.env` by this script itself, in
 * place, the first time it's missing; only the resulting *address* --
 * public by design, useless to an attacker on its own -- is ever logged.
 * Contrast `keygen.ts`, which does print raw keys: that script's keys are
 * meant to be copied into a real deployment's secret store by a human who
 * controls where its own output goes, which is a different threat model
 * than this script's, and does not license this file to follow the same
 * pattern.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { erc20Abi } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  AMOY_USDC_ADDRESS,
  assertAmoyChainId,
  createAmoyPublicClient,
  deploySafeTwoOfTwo,
  loadOrGenerateSafeCosignerKey,
} from "./x402-safe.js";
import { EnvSecp256k1Signer } from "../signing/env-signer.js";

const ENV_PATH = fileURLToPath(new URL("../../../../.env", import.meta.url));

/** Writes (or overwrites) one `KEY="value"` line in `.env` in place,
 * touching nothing else in the file. Never logs `value`. */
function setEnvVar(key: string, value: string): void {
  const contents = readFileSync(ENV_PATH, "utf8");
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
  writeFileSync(ENV_PATH, next);
  process.env[key] = value;
}

const rpcUrl = process.env.POLYGON_AMOY_RPC_URL;
if (!rpcUrl) {
  console.error("POLYGON_AMOY_RPC_URL is not set -- add it to .env before running this script.");
  process.exit(1);
}

const cosignerKey = loadOrGenerateSafeCosignerKey();
if (!process.env.WAYSAFE_SAFE_COSIGNER_KEY) {
  console.error("WAYSAFE_SAFE_COSIGNER_KEY is not set -- run `npm run keygen -w @waysafe/api` and add it to .env first.");
  process.exit(1);
}

async function main() {
  // First thing, always -- see assertAmoyChainId's doc comment. Every
  // function below this point that deploys or broadcasts asserts this
  // again itself; this call exists so a misconfigured RPC fails loudly
  // before this script does anything at all, not partway through.
  await assertAmoyChainId(rpcUrl!);

  if (!process.env.WAYSAFE_X402_TEST_SESSION_KEY) {
    const generated = generatePrivateKey();
    setEnvVar("WAYSAFE_X402_TEST_SESSION_KEY", generated);
    console.log(
      `WAYSAFE_X402_TEST_SESSION_KEY was unset -- generated a new one and wrote it to ${ENV_PATH} directly. ` +
        "Its private key is never printed; only its address appears below.",
    );
    console.log();
  }
  const sessionKey = process.env.WAYSAFE_X402_TEST_SESSION_KEY as `0x${string}`;

  const cosignerAddress = await EnvSecp256k1Signer.fromHex(cosignerKey).address();
  const sessionKeyAddress = await EnvSecp256k1Signer.fromHex(sessionKey).address();

  const publicClient = await createAmoyPublicClient(rpcUrl!);

  const [cosignerBalance, sessionKeyBalance] = await Promise.all([
    publicClient.getBalance({ address: cosignerAddress }),
    publicClient.getBalance({ address: sessionKeyAddress }),
  ]);

  console.log("--- x402 2-of-2 Safe (D-41), Polygon Amoy (chain 80002) ---");
  console.log(`Waysafe Safe co-signer EOA: ${cosignerAddress}  (balance: ${cosignerBalance} wei POL)`);
  console.log(`Test session-key EOA:       ${sessionKeyAddress}  (balance: ${sessionKeyBalance} wei POL)`);
  console.log();

  if (cosignerBalance === 0n || sessionKeyBalance === 0n) {
    console.log("STOP: fund both EOAs above with a small amount of Amoy POL (gas only -- never send");
    console.log("USDC here). Re-run this script once both show a nonzero balance.");
    return;
  }

  const deployment = await deploySafeTwoOfTwo({
    rpcUrl: rpcUrl!,
    // D-63: the cosigner key goes in as a Signer; the raw key never
    // reaches viem or protocol-kit.
    deployer: EnvSecp256k1Signer.fromHex(cosignerKey),
    owners: { sessionKeyAddress, cosignerAddress },
  });

  console.log(`Safe address: ${deployment.safeAddress}`);
  console.log(deployment.alreadyDeployed ? "(already deployed)" : `(deployed just now, tx ${deployment.txHash})`);
  console.log();

  if (process.env.WAYSAFE_X402_LIVE_PAYER_ACCOUNT !== deployment.safeAddress) {
    setEnvVar("WAYSAFE_X402_LIVE_PAYER_ACCOUNT", deployment.safeAddress);
    console.log(`Wrote WAYSAFE_X402_LIVE_PAYER_ACCOUNT=${deployment.safeAddress} to .env.`);
    console.log();
  }

  const usdcBalance = (await publicClient.readContract({
    address: AMOY_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [deployment.safeAddress as `0x${string}`],
  })) as bigint;

  console.log(`Safe's test USDC balance: ${usdcBalance} (atomic units, 6 decimals)`);

  if (usdcBalance === 0n) {
    console.log();
    console.log(`STOP: send test USDC to the SAFE address (${deployment.safeAddress}) -- never to either`);
    console.log("EOA above. Re-run this script once the balance above is nonzero.");
    return;
  }

  console.log();
  console.log("READY: run the live bypass test with:");
  console.log("  WAYSAFE_REQUIRE_X402_LIVE=1 npx vitest run apps/api/src/enforcement/x402.bypass.test.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
