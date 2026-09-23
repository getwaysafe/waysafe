/**
 * One-off operational helper (D-41 follow-up, Sep 2026): move a slice of
 * Amoy POL from the Waysafe Safe co-signer EOA to the test session-key EOA.
 *
 * Why this exists: the Polygon faucet rate-limits per verified identity, not
 * per address, so after `deploy-x402-safe.ts` generates a fresh session key
 * there is no way to fund it from the faucet in the same 24 hours. Both
 * keys already live in `.env`; this just splits gas between them.
 *
 * Gas only -- never send USDC to either EOA. Prints addresses, balances and
 * the current gas price; never prints a private key.
 *
 *   npx tsx --env-file-if-exists=.env apps/api/src/enforcement/fund-session-key.ts
 */
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { polygonAmoy } from "viem/chains";
import { EnvSecp256k1Signer } from "../signing/env-signer.js";
import { viemAccountFor } from "../signing/evm-account.js";

const rpcUrl = process.env.POLYGON_AMOY_RPC_URL;
const cosignerKey = process.env.WAYSAFE_SAFE_COSIGNER_KEY;
const sessionKey = process.env.WAYSAFE_X402_TEST_SESSION_KEY;

if (!rpcUrl || !cosignerKey || !sessionKey) {
  console.error("Need POLYGON_AMOY_RPC_URL, WAYSAFE_SAFE_COSIGNER_KEY and WAYSAFE_X402_TEST_SESSION_KEY in .env");
  process.exit(1);
}

const amount = parseEther(process.env.FUND_AMOUNT_POL ?? "0.03");

// D-63: both keys go through a Signer. The co-signer actually signs the
// transfer below; the session key is only ever the *recipient* here, so
// all this needs from it is an address -- it never signs in this script.
const cosignerSigner = EnvSecp256k1Signer.fromHex(cosignerKey);
const cosigner = await viemAccountFor(cosignerSigner);
const session = { address: await EnvSecp256k1Signer.fromHex(sessionKey).address() };

const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account: cosigner, chain: polygonAmoy, transport: http(rpcUrl) });

const [beforeCosigner, beforeSession, gasPrice] = await Promise.all([
  publicClient.getBalance({ address: cosigner.address }),
  publicClient.getBalance({ address: session.address }),
  publicClient.getGasPrice(),
]);

console.log(`co-signer ${cosigner.address}  ${formatEther(beforeCosigner)} POL`);
console.log(`session   ${session.address}  ${formatEther(beforeSession)} POL`);
console.log(`gas price ${Number(gasPrice) / 1e9} gwei`);

if (beforeSession > 0n) {
  console.log("session key already funded -- nothing to do.");
  process.exit(0);
}
if (beforeCosigner <= amount) {
  console.error(`co-signer balance too low to send ${formatEther(amount)} POL.`);
  process.exit(1);
}

const hash = await walletClient.sendTransaction({ to: session.address, value: amount });
console.log(`sent ${formatEther(amount)} POL -- tx ${hash}`);
await publicClient.waitForTransactionReceipt({ hash });

const [afterCosigner, afterSession] = await Promise.all([
  publicClient.getBalance({ address: cosigner.address }),
  publicClient.getBalance({ address: session.address }),
]);
console.log(`co-signer now ${formatEther(afterCosigner)} POL`);
console.log(`session   now ${formatEther(afterSession)} POL`);
