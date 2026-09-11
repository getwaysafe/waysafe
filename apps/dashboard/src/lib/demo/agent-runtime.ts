import "server-only";

/**
 * D-42: "the agent's own runtime" -- the code the demo's simulated AI agent
 * runs. Deliberately written from scratch, not imported from
 * `apps/api/src/enforcement/x402-safe.ts`: a real agent's runtime would
 * never import Waysafe's server internals, and a demo that did would quietly
 * undermine its own story ("the agent holds its own key, and Waysafe never
 * touches it"). This file holds `WAYSAFE_DEMO_AGENT_SESSION_KEY` and nothing
 * else Waysafe-related; it never imports anything from `@waysafe/api`.
 *
 * It uses `@safe-global/protocol-kit` -- the same open-source library
 * Waysafe's own server happens to use, because it's the standard way to
 * build and sign a Safe transaction, not because this file has any
 * relationship to Waysafe's copy of it.
 */

import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import * as SafeModule from "@safe-global/protocol-kit";
import type { ConnectSafeConfig, CreateTransactionProps, SafeConfig } from "@safe-global/protocol-kit";
import type { SafeTransaction } from "@safe-global/types-kit";
import { AMOY_USDC_ADDRESS } from "./constants";

// Same CJS/ESM interop quirk x402-safe.ts documents -- protocol-kit's
// shipped types resolve the default export as the module namespace under
// this project's moduleResolution, not the class itself.
interface SafeKit {
  getNonce(): Promise<number>;
  createTransaction(props: CreateTransactionProps): Promise<SafeTransaction>;
  signTransaction(tx: SafeTransaction): Promise<SafeTransaction>;
}
interface SafeStatic {
  init(config: SafeConfig): Promise<SafeKit>;
}
const Safe = SafeModule.default as unknown as SafeStatic;

export interface AgentPaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  extra?: Record<string, unknown>;
}

/** Fetches a 402 the same way any x402 client would -- a plain GET,
 * expecting HTTP 402 with the spec's own JSON shape. This is what lets the
 * agent know what it's about to try to pay; Waysafe never trusts this
 * copy, and independently fetches the same URL itself (D-40). */
export async function fetchPaymentRequirement(resourceUrl: string): Promise<AgentPaymentRequirement> {
  const response = await fetch(resourceUrl);
  if (response.status !== 402) {
    throw new Error(`expected 402 from ${resourceUrl}, got ${response.status}`);
  }
  const body = (await response.json()) as { accepts: AgentPaymentRequirement[] };
  const requirement = body.accepts[0];
  if (!requirement) throw new Error(`no payment requirement in 402 response from ${resourceUrl}`);
  return requirement;
}

export function agentSessionKeyAddress(sessionKeyPrivateKey: Hex): Address {
  return privateKeyToAddress(sessionKeyPrivateKey);
}

export interface SessionSignature {
  nonce: number;
  signer: Address;
  data: Hex;
}

/**
 * The agent signs -- with its own key, which never leaves this function --
 * a transfer of the requirement's exact amount to the requirement's exact
 * `payTo`. This is a partial signature: alone, against a threshold-2 Safe,
 * it cannot move anything (see the bypass scene). Only Waysafe's own
 * signature, added only after a genuine `evaluate()` ALLOW, completes it.
 */
export async function signSessionTransfer(params: {
  rpcUrl: string;
  safeAddress: Address;
  sessionKeyPrivateKey: Hex;
  payTo: Address;
  amountAtomic: bigint;
}): Promise<SessionSignature> {
  const kit = await Safe.init({
    provider: params.rpcUrl,
    signer: params.sessionKeyPrivateKey,
    safeAddress: params.safeAddress,
  });
  const nonce = await kit.getNonce();
  const transfer = {
    to: AMOY_USDC_ADDRESS,
    value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [params.payTo, params.amountAtomic] }),
  };
  const safeTransaction = await kit.createTransaction({ transactions: [transfer], options: { nonce } });
  const signed = await kit.signTransaction(safeTransaction);

  const signerAddress = agentSessionKeyAddress(params.sessionKeyPrivateKey);
  const signature = signed.getSignature(signerAddress);
  if (!signature) throw new Error("protocol-kit did not produce a signature for the session key");

  return { nonce, signer: signerAddress, data: signature.data as Hex };
}
