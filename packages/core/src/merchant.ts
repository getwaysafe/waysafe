/**
 * Merchant identity.
 *
 * This is the load-bearing decision the PRD left open. The MVP demo turns on
 * "Staples is approved, Best Buy is not" — but if `merchant` is a free-text
 * string supplied by the agent, the allowlist is decorative: a misbehaving or
 * compromised agent simply types "Staples". The policy engine would be theater.
 *
 * The rule Waysafe enforces instead:
 *
 *   A merchant assertion that cannot be verified can never produce ALLOW.
 *
 * Merchant references carry an explicit identity *scheme*, and each scheme has a
 * trust level. Only VERIFIED references can satisfy an allowlist outright.
 * ASSERTED references (a name the agent typed, a domain it claimed but we could
 * not corroborate) degrade the best possible outcome to STEP_UP — a human
 * confirms who the counterparty actually is.
 */

import { z } from "zod";

/**
 * How a merchant is identified.
 *
 * - `domain`         registrable domain of the merchant, e.g. "staples.com".
 *                    Primary scheme for the MVP.
 * - `psp_account`    the payment provider's own merchant identifier, e.g. a
 *                    Stripe connected-account id. Strongest signal we have,
 *                    because the money actually goes there.
 * - `network_mid`    card-network merchant ID (acquirer-assigned).
 * - `mcc`            ISO-18245 merchant category code. Categorical, not
 *                    identity — usable for category rules, never for allowlists.
 * - `name`           free text. Never sufficient on its own.
 */
export const MerchantScheme = {
  DOMAIN: "domain",
  PSP_ACCOUNT: "psp_account",
  NETWORK_MID: "network_mid",
  MCC: "mcc",
  NAME: "name",
} as const;

export type MerchantScheme =
  (typeof MerchantScheme)[keyof typeof MerchantScheme];

export const MerchantSchemeSchema = z.nativeEnum(MerchantScheme);

/**
 * Trust in a merchant identity at evaluation time.
 *
 * - VERIFIED  corroborated by something outside the agent's control — the PSP
 *             told us, or the domain was validated against the merchant
 *             directory.
 * - ASSERTED  the agent claimed it and nothing has confirmed it.
 * - UNKNOWN   we could not parse or resolve it at all.
 */
export const MerchantTrust = {
  VERIFIED: "VERIFIED",
  ASSERTED: "ASSERTED",
  UNKNOWN: "UNKNOWN",
} as const;

export type MerchantTrust = (typeof MerchantTrust)[keyof typeof MerchantTrust];

/** A merchant reference as it appears inside a policy (allowlist / denylist). */
export const MerchantRefSchema = z.object({
  scheme: MerchantSchemeSchema,
  /** Normalized value. Domains are lowercase registrable domains, no scheme, no path. */
  value: z.string().min(1),
  /** Optional display label, e.g. "Staples". Never used for matching. */
  label: z.string().optional(),
});

export type MerchantRef = z.infer<typeof MerchantRefSchema>;

/** A merchant as asserted by the agent on a proposed action. */
export const MerchantAssertionSchema = z.object({
  /** What the agent calls the merchant. Display and audit only. */
  name: z.string().min(1).optional(),
  /** Registrable domain, if the agent knows it. */
  domain: z.string().min(1).optional(),
  /** PSP-side account identifier, if the action was initiated through a PSP. */
  psp_account: z.string().min(1).optional(),
  network_mid: z.string().min(1).optional(),
  mcc: z.string().regex(/^\d{4}$/, "MCC must be four digits").optional(),
});

export type MerchantAssertion = z.infer<typeof MerchantAssertionSchema>;

/** The engine's view of a merchant after resolution. */
export interface ResolvedMerchant {
  trust: MerchantTrust;
  /** All identity references we could establish, strongest first. */
  refs: MerchantRef[];
  /** MCC if known, for category rules. */
  mcc?: string;
  /**
   * Where `mcc` came from. Unlike merchant *identity*, an MCC is never
   * upgraded to VERIFIED trust just because it was agent-asserted: `deny_mcc`
   * fires on an asserted MCC exactly as a merchant denylist fires on an
   * asserted name (D-14) — a mere claim of a blocked category is
   * disqualifying — but this field records provenance so a receipt can show
   * whether the code came from the agent's claim or a corroborated source.
   */
  mcc_source?: "psp" | "directory" | "assertion" | "network";
  /** Display name for receipts. */
  display_name?: string;
  /** How resolution happened, for the evidence record. */
  resolution_source: "psp" | "directory" | "assertion" | "network" | "none";
}

/** Schemes that can, on their own, satisfy an allowlist entry. */
const IDENTITY_SCHEMES: MerchantScheme[] = [
  MerchantScheme.PSP_ACCOUNT,
  MerchantScheme.NETWORK_MID,
  MerchantScheme.DOMAIN,
];

export function isIdentityScheme(scheme: MerchantScheme): boolean {
  return IDENTITY_SCHEMES.includes(scheme);
}

/**
 * Normalize a domain to its comparable form: lowercase, no scheme, no port, no
 * path, no leading "www.". Returns null if it does not look like a domain.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split("/")[0] ?? "";
  value = value.split("?")[0] ?? "";
  value = value.split("@").pop() ?? "";
  value = value.split(":")[0] ?? "";
  value = value.replace(/^www\./, "");
  value = value.replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return null;
  return value;
}

/** True if `candidate` is the same registrable domain or a subdomain of `ref`. */
export function domainMatches(ref: string, candidate: string): boolean {
  const a = normalizeDomain(ref);
  const b = normalizeDomain(candidate);
  if (!a || !b) return false;
  return b === a || b.endsWith(`.${a}`);
}

/**
 * Stable string key for a merchant ref, for set membership (e.g. "has this
 * mandate transacted with this merchant before?"). Domains are normalized so
 * "staples.com" and "www.staples.com" collide.
 */
export function merchantRefKey(ref: MerchantRef): string {
  const value =
    ref.scheme === MerchantScheme.DOMAIN
      ? (normalizeDomain(ref.value) ?? ref.value.toLowerCase())
      : ref.value.toLowerCase();
  return `${ref.scheme}:${value}`;
}

export function merchantRefMatches(
  ref: MerchantRef,
  resolved: ResolvedMerchant,
): boolean {
  return resolved.refs.some((candidate) => {
    if (candidate.scheme !== ref.scheme) return false;
    if (ref.scheme === MerchantScheme.DOMAIN) {
      return domainMatches(ref.value, candidate.value);
    }
    return candidate.value.toLowerCase() === ref.value.toLowerCase();
  });
}

/**
 * Does this resolved merchant satisfy an allowlist entry *with enough trust to
 * allow*? Matching on a `name` ref, or matching while the overall assertion is
 * unverified, is deliberately not enough.
 */
export function satisfiesAllowlist(
  allowlist: MerchantRef[],
  resolved: ResolvedMerchant,
): { matched: boolean; verified: boolean; via?: MerchantRef } {
  for (const ref of allowlist) {
    if (!merchantRefMatches(ref, resolved)) continue;
    const verified =
      resolved.trust === MerchantTrust.VERIFIED && isIdentityScheme(ref.scheme);
    return { matched: true, verified, via: ref };
  }
  return { matched: false, verified: false };
}

/** A denylist match needs no verification — a mere claim of a blocked merchant is disqualifying. */
export function matchesDenylist(
  denylist: MerchantRef[],
  resolved: ResolvedMerchant,
): { matched: boolean; via?: MerchantRef } {
  for (const ref of denylist) {
    if (merchantRefMatches(ref, resolved)) return { matched: true, via: ref };
  }
  return { matched: false };
}

/**
 * Resolve an agent's merchant assertion.
 *
 * MVP resolution order:
 *   1. PSP account id  -> VERIFIED (Week 4 wires the real Stripe lookup)
 *   2. Network merchant id (network_mid) -> VERIFIED (D-33: acquirer/network-
 *      assigned, same corroboration class as a PSP account id -- never
 *      something the agent itself could have typed. This is what makes a
 *      card-network merchant identifier on a rail's own callback, e.g.
 *      Stripe Issuing's `merchant_data.network_id`, actually able to satisfy
 *      an allowlist per D-3's table, instead of forever capping at STEP_UP.)
 *   3. Known-merchant directory hit on domain -> VERIFIED
 *   4. Domain present but unknown -> ASSERTED
 *   5. Name only -> ASSERTED, with no identity ref at all
 *   6. Nothing usable -> UNKNOWN
 */
export function resolveMerchant(
  assertion: MerchantAssertion,
  directory: MerchantDirectory = EMPTY_DIRECTORY,
): ResolvedMerchant {
  const refs: MerchantRef[] = [];
  let trust: MerchantTrust = MerchantTrust.UNKNOWN;
  let source: ResolvedMerchant["resolution_source"] = "none";
  let mcc = assertion.mcc;
  let mccSource: ResolvedMerchant["mcc_source"] = mcc ? "assertion" : undefined;

  if (assertion.psp_account) {
    refs.push({
      scheme: MerchantScheme.PSP_ACCOUNT,
      value: assertion.psp_account,
    });
    trust = MerchantTrust.VERIFIED;
    source = "psp";
  }

  if (assertion.network_mid) {
    refs.push({
      scheme: MerchantScheme.NETWORK_MID,
      value: assertion.network_mid,
    });
    // D-33: a network_mid is assigned by the card network/acquirer, not
    // typed by the agent -- the same corroboration class as psp_account,
    // per D-3's table ("network_mid — yes, acquirer-assigned", no directory
    // caveat the way domain has one). Previously this branch only pushed a
    // ref and never touched `trust`, so a bare network_mid assertion (no
    // domain, no psp_account) left trust at UNKNOWN/ASSERTED and could never
    // satisfy an allowlist -- silently defeating the one rail (card-network
    // enforcement, D-32) whose merchant identity is *always* network_mid +
    // MCC, never a domain.
    if (trust !== MerchantTrust.VERIFIED) {
      trust = MerchantTrust.VERIFIED;
      source = "network";
    }
    if (mcc && mccSource === "assertion") {
      mccSource = "network";
    }
  }

  const domain = assertion.domain ? normalizeDomain(assertion.domain) : null;
  if (domain) {
    refs.push({ scheme: MerchantScheme.DOMAIN, value: domain });
    const entry = directory.lookupDomain(domain);
    if (entry) {
      if (trust !== MerchantTrust.VERIFIED) {
        trust = MerchantTrust.VERIFIED;
        source = "directory";
      }
      if (!mcc && entry.mcc) {
        mcc = entry.mcc;
        mccSource = "directory";
      }
    } else if (trust === MerchantTrust.UNKNOWN) {
      trust = MerchantTrust.ASSERTED;
      source = "assertion";
    }
  }

  if (assertion.name) {
    refs.push({ scheme: MerchantScheme.NAME, value: assertion.name });
    if (trust === MerchantTrust.UNKNOWN) {
      trust = MerchantTrust.ASSERTED;
      source = "assertion";
    }
  }

  if (mcc) refs.push({ scheme: MerchantScheme.MCC, value: mcc });

  return {
    trust,
    refs,
    mcc,
    mcc_source: mccSource,
    display_name: assertion.name ?? domain ?? undefined,
    resolution_source: source,
  };
}

// --- Directory --------------------------------------------------------------

export interface MerchantDirectoryEntry {
  domain: string;
  display_name: string;
  mcc?: string;
}

export interface MerchantDirectory {
  lookupDomain(domain: string): MerchantDirectoryEntry | undefined;
}

export const EMPTY_DIRECTORY: MerchantDirectory = {
  lookupDomain: () => undefined,
};

/**
 * A tiny seeded directory so the MVP demo has verified merchants without
 * standing up a data pipeline. Week 2+ replaces this with a real source.
 */
export function createStaticDirectory(
  entries: MerchantDirectoryEntry[],
): MerchantDirectory {
  const byDomain = new Map<string, MerchantDirectoryEntry>();
  for (const entry of entries) {
    const normalized = normalizeDomain(entry.domain);
    if (normalized) byDomain.set(normalized, { ...entry, domain: normalized });
  }
  return {
    lookupDomain(domain) {
      const normalized = normalizeDomain(domain);
      if (!normalized) return undefined;
      const direct = byDomain.get(normalized);
      if (direct) return direct;
      for (const [known, entry] of byDomain) {
        if (domainMatches(known, normalized)) return entry;
      }
      return undefined;
    },
  };
}
