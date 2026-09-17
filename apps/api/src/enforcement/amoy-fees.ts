/** Read-only: what Amoy is actually charging right now (base fee vs priority
 * fee vs viem's getGasPrice), and what a ~624k-gas Safe deployment would cost
 * at each. No keys touched, nothing sent. */
import { createPublicClient, formatEther, http } from "viem";
import { polygonAmoy } from "viem/chains";

const rpcUrl = process.env.POLYGON_AMOY_RPC_URL!;
const client = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });
const GAS = 624000n;

const block = await client.getBlock();
const gasPrice = await client.getGasPrice();
const fees = await client.estimateFeesPerGas();

const g = (v: bigint | undefined | null) => (v == null ? "n/a" : `${Number(v) / 1e9} gwei`);
console.log(`block            ${block.number}`);
console.log(`baseFeePerGas    ${g(block.baseFeePerGas)}`);
console.log(`getGasPrice      ${g(gasPrice)}`);
console.log(`maxFeePerGas     ${g(fees.maxFeePerGas)}`);
console.log(`maxPriorityFee   ${g(fees.maxPriorityFeePerGas)}`);
console.log(`--- 624k gas deployment would cost ---`);
console.log(`at getGasPrice   ${formatEther(gasPrice * GAS)} POL`);
if (fees.maxFeePerGas) console.log(`at maxFeePerGas  ${formatEther(fees.maxFeePerGas * GAS)} POL`);
if (block.baseFeePerGas) console.log(`at base+30gwei   ${formatEther((block.baseFeePerGas + 30_000_000_000n) * GAS)} POL`);
