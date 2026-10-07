/**
 * The asset registry (D-68): the one place that says what a token's
 * decimals are.
 *
 * The counterparty never supplies the units. The adversarial review of
 * `387958a` found `x402.ts` taking an asset's decimal scale from
 * `requirement.extra.decimals` -- a field the *merchant* writes -- and then
 * settling the raw atomic amount against a hardcoded token address. A
 * merchant declaring `decimals: 18` on real 6-decimal USDC had a 5,000 USDC
 * transfer evaluated as $0.00, ALLOWed under a $50 ceiling, recorded in the
 * signed evidence chain as a $0.00 payment, and settled for real.
 *
 * This is non-negotiable #3's principle applied to assets rather than
 * merchants: an identifier Waysafe cannot independently resolve never
 * produces ALLOW. The same reasoning as D-34, for the same reason -- trust
 * follows who attested a value, not which field it arrived in. A merchant
 * asserting `decimals` is exactly as untrustworthy as an agent asserting a
 * `psp_account`.
 *
 * Matching is by `(chainId, lowercased contract address)` and nothing else.
 * Never by symbol: "USDC" is a string a hostile merchant types, and two
 * different contracts can both claim it. The address is the asset's
 * identity; the symbol is a label for humans.
 *
 * One entry today, which is honest rather than embarrassing -- Amoy test
 * USDC is the only asset this codebase has ever settled. Adding a second is
 * a deliberate act with a test that notices (`assets.test.ts` asserts the
 * registry's exact contents, so a future "helpful" addition shows up as a
 * diff rather than silently widening what can be spent).
 */

/** A token this deployment can evaluate and settle. */
export interface RegisteredAsset {
  /** EIP-155 chain id. The pair (chainId, address) is the key. */
  chainId: number;
  /** Lowercased contract address -- the canonical form for comparison. */
  address: string;
  /** For humans and receipts only. **Never** matched on. */
  symbol: string;
  /** The authoritative decimal scale. This, not the merchant's claim. */
  decimals: number;
  /**
   * x402 `network` strings that denote this asset's chain. A requirement
   * carries a name (`"polygon-amoy"`), not a chain id, so the name has to
   * map to one -- and the mapping lives here rather than being inferred.
   */
  networkNames: readonly string[];
}

export const POLYGON_AMOY_CHAIN_ID = 80002;

/**
 * Amoy test USDC: the asset D-41's deployed 2-of-2 Safe actually holds and
 * the only one `settleTwoOfTwoTransfer` has ever moved. Six decimals,
 * verified against the real contract, not assumed.
 */
export const AMOY_USDC: RegisteredAsset = {
  chainId: POLYGON_AMOY_CHAIN_ID,
  address: "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
  symbol: "USDC",
  decimals: 6,
  networkNames: ["polygon-amoy", "amoy", "matic-amoy", "polygon-amoy-testnet"],
};

/** Every asset this deployment will evaluate or settle. Exported so a test
 * can assert its exact contents. */
export const ASSET_REGISTRY: readonly RegisteredAsset[] = [AMOY_USDC];

/** The chains `settleTwoOfTwoTransfer` can actually broadcast to. An asset
 * on any other chain is a DENY at evaluation time rather than a failure
 * discovered after a decision has already been made (D-68 requirement 3). */
export const SETTLEABLE_CHAIN_IDS: readonly number[] = [POLYGON_AMOY_CHAIN_ID];

function chainIdForNetworkName(network: string): number | null {
  const normalized = network.trim().toLowerCase();
  for (const asset of ASSET_REGISTRY) {
    if (asset.networkNames.includes(normalized)) return asset.chainId;
  }
  return null;
}

/**
 * Resolves `(network, address)` to a known asset, or `null`.
 *
 * `null` means "Waysafe cannot say what this token is," and every caller
 * must treat that as a DENY -- never as a reason to fall back on anything
 * the counterparty said. Deliberately total and side-effect free: no
 * network call, no on-chain lookup, no guessing decimals from a symbol.
 *
 * `network` may be an x402 network name (`"polygon-amoy"`) or a decimal
 * chain id as a string (`"80002"`); both resolve through the same table.
 */
export function resolveAsset(network: string, address: string): RegisteredAsset | null {
  if (typeof network !== "string" || typeof address !== "string") return null;

  const normalizedAddress = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalizedAddress)) return null;

  const numeric = Number(network.trim());
  const chainId = Number.isInteger(numeric) && numeric > 0 ? numeric : chainIdForNetworkName(network);
  if (chainId === null) return null;

  return (
    ASSET_REGISTRY.find((a) => a.chainId === chainId && a.address === normalizedAddress) ?? null
  );
}

/** Whether this deployment's settlement path can broadcast for this asset. */
export function isSettleableAsset(asset: RegisteredAsset): boolean {
  return SETTLEABLE_CHAIN_IDS.includes(asset.chainId);
}

/**
 * Atomic units of `asset` -> USD cents, using the registry's decimals,
 * **rounded up**.
 *
 * Moved here from x402.ts so there is exactly one implementation and it
 * cannot be called with a merchant-supplied scale. All-integer (BigInt)
 * arithmetic: D-2 forbids `parseFloat` on an amount, and that rule applies
 * to a second decimal scale (asset decimals) just as much as to currency
 * minor units.
 *
 * D-88: rounds up, not half-up. USDC has six decimals and a cent is ten
 * thousand atomic units, so round-half-up sent every transfer under half a
 * cent to zero. The second independent review co-signed 14,997 atomic units
 * across three requests and the ledger recorded $0.00 — a real transfer that
 * the cumulative limits (D-4) never saw, on a receipt that said nothing
 * moved. A nonzero atomic amount now always costs at least one cent, and an
 * exact number of cents is never inflated.
 *
 * Rounding up rather than down is the conservative direction: the budget is
 * charged at least what moved. The *transfer* is still the exact atomic
 * amount — rounding is the budget's unit, never the payment's — so the
 * receipt carries both figures (see `enforcement.x402.decision`).
 */
export function assetAtomicToCents(atomicAmount: string, asset: RegisteredAsset): number | null {
  if (!/^\d+$/.test(atomicAmount)) return null;
  if (asset.decimals < 2) return null;

  const scale = 10n ** BigInt(asset.decimals - 2);
  const atomic = BigInt(atomicAmount);
  // Ceiling division on non-negative integers. No floats.
  const cents = (atomic + scale - 1n) / scale;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

/**
 * Whether `atomicAmount` is an exact whole number of cents for this asset,
 * i.e. whether `assetAtomicToCents` rounded it up.
 *
 * D-88: a receipt that says `amount: 1` for 4,999 atomic units has to be able
 * to say that the cent was rounding rather than the amount.
 */
export function isExactCents(atomicAmount: string, asset: RegisteredAsset): boolean {
  if (!/^\d+$/.test(atomicAmount)) return false;
  if (asset.decimals < 2) return false;
  const scale = 10n ** BigInt(asset.decimals - 2);
  return BigInt(atomicAmount) % scale === 0n;
}
