/**
 * Turning a `Signer` into something viem and `@safe-global/protocol-kit`
 * can use, without either of them ever seeing key material (D-63
 * completion).
 *
 * Two layers, because the two libraries want different things:
 *
 * 1. `viemAccountFor(signer)` -- a viem `LocalAccount` built with
 *    `toAccount`, whose `signMessage`/`signTypedData`/`signTransaction`
 *    delegate to the signer's own three operations. viem accepts this
 *    directly (`createWalletClient({ account })`).
 *
 * 2. `eip1193ProviderFor(rpcUrl, account)` -- for protocol-kit, which does
 *    NOT accept a viem Account. Its `signer` option is typed
 *    `HexAddress | PrivateKey | PasskeyArgType | PasskeyClient`, and at
 *    runtime `SafeProvider.getExternalSigner()` branches on
 *    `isPrivateKey(signer) = typeof signer === "string" && !isAddress(signer)`.
 *    So passing an **address** takes the branch that builds
 *    `createWalletClient({ account: <address>, transport: custom(provider) })`
 *    -- a client with no local key, which delegates every signing operation
 *    to the provider over JSON-RPC. This shim is that provider: it answers
 *    the signing methods locally from the account above, and forwards
 *    everything else to the real HTTP transport.
 *
 * That combination is what lets the Safe cosigner key stay inside its
 * `Signer` -- the key THREAT-MODEL.md §7 names as the one with no kill
 * switch, so the one where "who can reach this key" matters most.
 */

import {
  createWalletClient,
  custom,
  http,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { toAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import type { EnvSecp256k1Signer } from "./env-signer.js";

/** The secp256k1 signing surface the EVM path needs. Declared here rather
 * than on `@waysafe/core`'s `Secp256k1Signer` because these are viem-shaped
 * (EIP-712 typed data, transaction envelopes) and `@waysafe/core` has no
 * viem dependency -- same reasoning as `EvidenceSigner` in ./types.ts. */
export type EvmSigner = Pick<
  EnvSecp256k1Signer,
  "address" | "signMessage" | "signTypedData" | "signTransaction"
>;

/**
 * A viem `LocalAccount` backed by a `Signer`. Deliberately built with
 * `toAccount` over the signer's own operations rather than handing out the
 * signer's internal account: the delegation is what makes the boundary
 * visible, and what a KMS-backed signer would slot into unchanged.
 */
export async function viemAccountFor(signer: EvmSigner): Promise<LocalAccount> {
  const address = (await signer.address()) as Address;
  return toAccount({
    address,
    signMessage: (args) => signer.signMessage(args),
    signTypedData: (args) => signer.signTypedData(args as never),
    signTransaction: (args) => signer.signTransaction(args as never),
  }) as LocalAccount;
}

/**
 * An EIP-1193 provider that signs locally and reads remotely.
 *
 * Signing methods are answered from `account`; everything else (chain id,
 * gas, nonces, receipts, `eth_call`) is forwarded verbatim to `rpcUrl`.
 * `eth_sendTransaction` is the interesting one: a JSON-RPC node cannot sign
 * for an account it does not hold, so this signs the transaction locally
 * and forwards it as `eth_sendRawTransaction` -- which is precisely what
 * the old code got by handing protocol-kit the raw key, just with the
 * signing step moved inside the `Signer`.
 */
export interface SigningEip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export function eip1193ProviderFor(rpcUrl: string, account: LocalAccount): SigningEip1193Provider {
  const transport = http(rpcUrl)({ chain: polygonAmoy });
  const wallet = createWalletClient({ account, chain: polygonAmoy, transport: http(rpcUrl) });

  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const args = (params ?? []) as unknown[];

    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];

      // viem's wallet client emits `personal_sign` with [data, address].
      case "personal_sign": {
        const [data] = args as [Hex, Address];
        return account.signMessage({ message: { raw: data } });
      }

      // `eth_sign` reverses the argument order ([address, data]).
      case "eth_sign": {
        const [, data] = args as [Address, Hex];
        return account.signMessage({ message: { raw: data } });
      }

      // What protocol-kit actually uses for a SafeTx owner signature.
      case "eth_signTypedData_v4":
      case "eth_signTypedData": {
        const [, typedData] = args as [Address, string | Record<string, unknown>];
        const parsed = typeof typedData === "string" ? JSON.parse(typedData) : typedData;
        return account.signTypedData(parsed as never);
      }

      case "eth_sendTransaction": {
        const [tx] = args as [Record<string, unknown>];
        return wallet.sendTransaction({
          to: tx.to as Address,
          data: tx.data as Hex | undefined,
          value: tx.value ? BigInt(tx.value as string) : undefined,
          gas: tx.gas ? BigInt(tx.gas as string) : undefined,
        } as never);
      }

      default:
        return transport.request({ method, params } as never);
    }
  };

  return { request };
}
