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
 *
 * D-34: trust is a function of *who* attested a value, not merely *which*
 * scheme it arrived on. `psp_account` and `network_mid` were originally
 * treated as inherently VERIFIED by field alone -- but `ProposedAction.merchant`
 * on `POST /v1/authorizations` is supplied by the agent, and an agent typing
 * `psp_account: "acct_realStaples"` is exactly the "Staples" attack the rest
 * of this file exists to stop, just moved to a different field. See
 * `MerchantAttestationSource` below and DECISIONS.md D-34.
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

/**
 * Who supplied a merchant identifier on a `MerchantAssertion` -- D-34.
 *
 * `resolveMerchant`'s trust decision was, until D-34, a function of which
 * *field* an assertion carried: `psp_account` or `network_mid` present meant
 * VERIFIED, full stop. That's non-negotiable #3 read too literally --
 * `POST /v1/authorizations`' `ProposedAction.merchant` is supplied by the
 * agent, the exact same untrusted party a bare `name` claim already can't
 * come from. An agent that types `psp_account: "acct_realStaples"` or
 * `network_mid: "visa_mid_staples"` is doing precisely what D-3 exists to
 * stop a `name` claim from doing, and the field-based rule let it through.
 * Trust has to be a function of *who* supplied the identifier, not merely
 * *which* field it landed in.
 *
 * - `agent`  the caller of authorize() asserted it directly on the request
 *            (`ProposedAction.merchant`). Every field here is exactly as
 *            untrustworthy as a `name` claim would be -- an agent can type
 *            any string into `psp_account` or `network_mid` as easily as
 *            into `name`. Caps at ASSERTED, same ceiling D-3 already
 *            applies to a bare name.
 * - `rail`   a payment rail's own callback supplied it -- e.g. Stripe
 *            Issuing's `merchant_data.network_id` (D-32) -- assigned by the
 *            card network/acquirer/PSP, not something the party requesting
 *            money movement could fabricate. This is the only source that
 *            can still verify a `psp_account`/`network_mid` field directly.
 *
 * Directory-corroborated `domain` is unaffected either way: that
 * corroboration comes from Waysafe's own directory recognizing the domain
 * value, independent of who supplied the string, so there is nothing here
 * for attestation source to change.
 */
export const MerchantAttestationSource = {
  AGENT: "agent",
  RAIL: "rail",
} as const;

export type MerchantAttestationSource =
  (typeof MerchantAttestationSource)[keyof typeof MerchantAttestationSource];

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
 * Resolve a merchant assertion against who supplied it (D-34).
 *
 * MVP resolution order:
 *   1. PSP account id, rail-attested  -> VERIFIED (Week 4 wires the real
 *      Stripe lookup). Agent-attested -> ASSERTED at most (D-34): the field
 *      alone proves nothing about who put the value there.
 *   2. Network merchant id (network_mid), rail-attested -> VERIFIED (D-33:
 *      acquirer/network-assigned, same corroboration class as a PSP account
 *      id -- this is what makes a card-network merchant identifier on a
 *      rail's own callback, e.g. Stripe Issuing's `merchant_data.network_id`,
 *      actually able to satisfy an allowlist per D-3's table, instead of
 *      forever capping at STEP_UP). Agent-attested -> ASSERTED at most
 *      (D-34), same reasoning as psp_account above.
 *   3. Known-merchant directory hit on domain -> VERIFIED, regardless of
 *      attestation source (the corroboration is Waysafe's own directory
 *      lookup, not a claim about who supplied the domain string).
 *   4. Domain present but unknown -> ASSERTED
 *   5. Name only -> ASSERTED, with no identity ref at all
 *   6. Nothing usable -> UNKNOWN
 */
export function resolveMerchant(
  assertion: MerchantAssertion,
  directory: MerchantDirectory,
  source: MerchantAttestationSource,
): ResolvedMerchant {
  const refs: MerchantRef[] = [];
  let trust: MerchantTrust = MerchantTrust.UNKNOWN;
  let resolutionSource: ResolvedMerchant["resolution_source"] = "none";
  let mcc = assertion.mcc;
  let mccSource: ResolvedMerchant["mcc_source"] = mcc ? "assertion" : undefined;

  // D-34: only a rail's own callback can make a psp_account/network_mid
  // field VERIFIED by itself -- an agent asserting either on
  // POST /v1/authorizations is exactly as untrustworthy as it asserting a
  // bare name, since it can type any string into any of these fields.
  const attestedByRail = source === MerchantAttestationSource.RAIL;

  if (assertion.psp_account) {
    refs.push({
      scheme: MerchantScheme.PSP_ACCOUNT,
      value: assertion.psp_account,
    });
    if (attestedByRail) {
      trust = MerchantTrust.VERIFIED;
      resolutionSource = "psp";
    } else if (trust === MerchantTrust.UNKNOWN) {
      trust = MerchantTrust.ASSERTED;
      resolutionSource = "assertion";
    }
  }

  if (assertion.network_mid) {
    refs.push({
      scheme: MerchantScheme.NETWORK_MID,
      value: assertion.network_mid,
    });
    if (attestedByRail) {
      // D-33: a network_mid is assigned by the card network/acquirer, not
      // typed by the agent -- the same corroboration class as psp_account,
      // per D-3's table ("network_mid — yes, acquirer-assigned", no directory
      // caveat the way domain has one). But that reasoning only holds when
      // the rail itself is the one asserting it (D-34) -- an agent typing
      // the same string proves nothing.
      if (trust !== MerchantTrust.VERIFIED) {
        trust = MerchantTrust.VERIFIED;
        resolutionSource = "network";
      }
      if (mcc && mccSource === "assertion") {
        mccSource = "network";
      }
    } else if (trust === MerchantTrust.UNKNOWN) {
      trust = MerchantTrust.ASSERTED;
      resolutionSource = "assertion";
    }
  }

  const domain = assertion.domain ? normalizeDomain(assertion.domain) : null;
  if (domain) {
    refs.push({ scheme: MerchantScheme.DOMAIN, value: domain });
    const entry = directory.lookupDomain(domain);
    if (entry) {
      // Unaffected by attestation source: the corroboration is Waysafe's own
      // directory recognizing this domain, not a claim about who supplied it.
      if (trust !== MerchantTrust.VERIFIED) {
        trust = MerchantTrust.VERIFIED;
        resolutionSource = "directory";
      }
      if (!mcc && entry.mcc) {
        mcc = entry.mcc;
        mccSource = "directory";
      }
    } else if (trust === MerchantTrust.UNKNOWN) {
      trust = MerchantTrust.ASSERTED;
      resolutionSource = "assertion";
    }
  }

  if (assertion.name) {
    refs.push({ scheme: MerchantScheme.NAME, value: assertion.name });
    if (trust === MerchantTrust.UNKNOWN) {
      trust = MerchantTrust.ASSERTED;
      resolutionSource = "assertion";
    }
  }

  if (mcc) refs.push({ scheme: MerchantScheme.MCC, value: mcc });

  return {
    trust,
    refs,
    mcc,
    mcc_source: mccSource,
    display_name: assertion.name ?? domain ?? undefined,
    resolution_source: resolutionSource,
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
