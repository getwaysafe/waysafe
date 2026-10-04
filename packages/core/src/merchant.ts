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
 *
 * D-69: trust is per *identifier*, not per merchant. D-34 fixed *which* field
 * confers trust but left one `trust` value covering every identifier in a
 * single assertion, so trust bled sideways between them: an agent asserting
 * `{domain: "staples.com", psp_account: "acct_attacker"}` got one VERIFIED
 * merchant (the directory corroborated the domain) whose refs included the
 * attacker's own PSP id, and `satisfiesAllowlist` consulted that merchant-
 * level value rather than the trust of the identifier that actually matched.
 * A PSP-id allowlist therefore ALLOWed an identifier nothing had verified,
 * laundered through a sibling. Every identifier now carries its own trust,
 * source and timestamp, and two conditions must both hold before a match can
 * produce ALLOW -- see `satisfiesAllowlist`.
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
 * - `onchain_address` a payee's on-chain address (D-40, x402) — the address
 *                    the payment itself actually settles to. Same trust
 *                    class as `psp_account`/`network_mid`: strong when a
 *                    rail attested it, exactly as fabricable as a `name`
 *                    claim when an agent did (D-34 applies identically).
 */
export const MerchantScheme = {
  DOMAIN: "domain",
  PSP_ACCOUNT: "psp_account",
  NETWORK_MID: "network_mid",
  MCC: "mcc",
  NAME: "name",
  ONCHAIN_ADDRESS: "onchain_address",
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
  /** On-chain payee address (D-40, x402), e.g. an EVM `payTo`. Compared
   * case-insensitively, same as every non-domain scheme. */
  onchain_address: z.string().min(1).optional(),
});

export type MerchantAssertion = z.infer<typeof MerchantAssertionSchema>;

/**
 * One resolved identifier, carrying *its own* trust -- D-69.
 *
 * Deliberately a separate type from `MerchantRef`: a `MerchantRef` is what a
 * *policy* names (authored by a principal, no trust of its own, hashed into
 * the frozen policy), and a `ResolvedMerchantRef` is what a *request* arrived
 * with. Keeping them distinct means adding per-identifier trust changes no
 * policy's shape and so no policy hash (non-negotiable #5).
 */
export interface ResolvedMerchantRef extends MerchantRef {
  /**
   * Trust in **this identifier alone**, never inherited from a sibling.
   * Only ever VERIFIED or ASSERTED -- an identifier that could not be parsed
   * never becomes a ref at all.
   */
  trust: MerchantTrust;
  /** Who supplied this identifier (D-34). */
  source: MerchantAttestationSource;
  /**
   * When this identifier was verified, ISO-8601, or `null` if it never was.
   * A new identifier starts unverified: `trust: ASSERTED`, `verified_at: null`.
   */
  verified_at: string | null;
}

/** The engine's view of a merchant after resolution. */
export interface ResolvedMerchant {
  /**
   * The **low-water mark** across identity refs -- VERIFIED only when every
   * identity ref this request arrived with is itself verified (D-69).
   *
   * It was a high-water mark until D-69, which is what let trust bleed: one
   * verified identifier made the whole merchant VERIFIED, siblings included.
   * Reading this field is now safe in the conservative direction by
   * construction, but it is a *summary* -- a decision about a specific
   * identifier must consult that identifier's own `trust`, which is why
   * `satisfiesAllowlist` checks both.
   */
  trust: MerchantTrust;
  /** All identity references we could establish, strongest first. */
  refs: ResolvedMerchantRef[];
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
  resolution_source: "psp" | "directory" | "assertion" | "network" | "onchain" | "none";
}

/** Schemes that can, on their own, satisfy an allowlist entry. */
const IDENTITY_SCHEMES: MerchantScheme[] = [
  MerchantScheme.PSP_ACCOUNT,
  MerchantScheme.NETWORK_MID,
  MerchantScheme.DOMAIN,
  MerchantScheme.ONCHAIN_ADDRESS,
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

/**
 * The resolved identifier a policy ref matches, or `undefined`.
 *
 * D-69: callers that decide anything need the matched identifier itself, not
 * merely that *something* matched -- the trust that governs the decision is
 * the matched identifier's own.
 */
export function findMatchingRef(
  ref: MerchantRef,
  resolved: ResolvedMerchant,
): ResolvedMerchantRef | undefined {
  return resolved.refs.find((candidate) => {
    if (candidate.scheme !== ref.scheme) return false;
    if (ref.scheme === MerchantScheme.DOMAIN) {
      return domainMatches(ref.value, candidate.value);
    }
    return candidate.value.toLowerCase() === ref.value.toLowerCase();
  });
}

export function merchantRefMatches(
  ref: MerchantRef,
  resolved: ResolvedMerchant,
): boolean {
  return findMatchingRef(ref, resolved) !== undefined;
}

/** Identity refs this request arrived with that nothing has verified (D-69). */
export function unverifiedIdentityRefs(
  resolved: ResolvedMerchant,
): ResolvedMerchantRef[] {
  return resolved.refs.filter(
    (ref) => isIdentityScheme(ref.scheme) && ref.trust !== MerchantTrust.VERIFIED,
  );
}

/**
 * Every identity ref and its verdict, for a receipt -- "domain staples.com
 * VERIFIED; psp_account acct_x UNVERIFIED" (D-69).
 *
 * This is what makes a laundered sibling legible on the receipt: a human
 * resolving the step-up can see that the merchant's *domain* checked out while
 * the account the money would actually reach did not, which reads very
 * differently from a merchant nothing at all is known about.
 */
export function describeMerchantIdentifiers(resolved: ResolvedMerchant): string {
  return resolved.refs
    .filter((ref) => isIdentityScheme(ref.scheme))
    .map(
      (ref) =>
        `${ref.scheme} ${ref.value} ${
          ref.trust === MerchantTrust.VERIFIED ? "VERIFIED" : "UNVERIFIED"
        }`,
    )
    .join("; ");
}

/**
 * The identifiers a settled payment should be remembered under, for
 * `step_up_on_first_use` (D-69).
 *
 * Verified identity refs only. Keying the seen set on *every* ref -- which is
 * what it did before D-69 -- let an agent poison first-use detection: an
 * unverified `psp_account` laundered through a verified domain was remembered
 * as a merchant this mandate had transacted with, so the step-up the principal
 * asked for on a genuinely new merchant never fired on its second appearance.
 *
 * A verified `domain` counts, not only the account that literally received the
 * funds: `step_up_on_first_use` means "the first time with this merchant", and
 * a directory-corroborated domain is that merchant's identity. The security
 * property is that nothing *unverified* enters the set, and that holds either
 * way.
 */
export function verifiedMerchantKeys(resolved: ResolvedMerchant): string[] {
  return resolved.refs
    .filter(
      (ref) => isIdentityScheme(ref.scheme) && ref.trust === MerchantTrust.VERIFIED,
    )
    .map((ref) => merchantRefKey(ref));
}

/**
 * Does this resolved merchant satisfy an allowlist entry *with enough trust to
 * allow*? Matching on a `name` ref is deliberately not enough, and nor is
 * matching an identifier that only a sibling's verification vouches for.
 *
 * D-69 requires **both** conditions, and each blocks a different attack:
 *
 *  1. The matched identifier is itself verified. Without this, an agent
 *     asserting `{domain: "staples.com", psp_account: "acct_attacker"}`
 *     satisfies a `psp_account` allowlist outright -- the directory verified
 *     the domain, and the merchant-level trust that verification produced was
 *     all the old check consulted.
 *
 *  2. No identity ref is unverified. Condition 1 alone still loses when the
 *     allowlist names the *domain*: the domain genuinely verifies, but the
 *     money is going to an `onchain_address` or `psp_account` nothing
 *     corroborated. An unverified identifier anywhere in the assertion is an
 *     unresolved claim about where funds land, so the ceiling is STEP_UP and a
 *     human reads `describeMerchantIdentifiers`.
 */
export function satisfiesAllowlist(
  allowlist: MerchantRef[],
  resolved: ResolvedMerchant,
): {
  matched: boolean;
  verified: boolean;
  via?: MerchantRef;
  /** The identifier that matched, with its own trust. */
  matched_ref?: ResolvedMerchantRef;
  /** Identity refs that blocked an otherwise-verified match (condition 2). */
  unverified_refs: ResolvedMerchantRef[];
} {
  const unverified = unverifiedIdentityRefs(resolved);
  for (const ref of allowlist) {
    const matchedRef = findMatchingRef(ref, resolved);
    if (!matchedRef) continue;
    const verified =
      isIdentityScheme(ref.scheme) &&
      matchedRef.trust === MerchantTrust.VERIFIED &&
      unverified.length === 0;
    return {
      matched: true,
      verified,
      via: ref,
      matched_ref: matchedRef,
      unverified_refs: unverified,
    };
  }
  return { matched: false, verified: false, unverified_refs: unverified };
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
 *   3. On-chain payee address (onchain_address), rail-attested -> VERIFIED
 *      (D-40: same corroboration class as psp_account/network_mid -- it's
 *      where the money actually settles). Agent-attested -> ASSERTED at
 *      most (D-34), identical reasoning.
 *   4. Known-merchant directory hit on domain -> VERIFIED, regardless of
 *      attestation source (the corroboration is Waysafe's own directory
 *      lookup, not a claim about who supplied the domain string).
 *   5. Domain present but unknown -> ASSERTED
 *   6. Name only -> ASSERTED, with no identity ref at all
 *   7. Nothing usable -> UNKNOWN
 *
 * D-69 applies that table **per identifier** rather than once per assertion,
 * and `ResolvedMerchant.trust` becomes the low-water mark over the identity
 * refs rather than the high-water mark. The per-scheme rules themselves are
 * unchanged from D-34/D-40 with one addition: a `domain` a *rail* attested is
 * VERIFIED even without a directory hit, by exactly the reasoning that makes a
 * rail-attested `psp_account` VERIFIED -- on x402 that host comes from a
 * resource URL Waysafe fetched itself, not from anything the agent typed.
 */
export function resolveMerchant(
  assertion: MerchantAssertion,
  directory: MerchantDirectory,
  source: MerchantAttestationSource,
  now: Date = new Date(),
): ResolvedMerchant {
  const refs: ResolvedMerchantRef[] = [];
  /**
   * The strongest corroboration anything in this assertion got, with the same
   * precedence D-34/D-40 already used (psp > network > onchain > directory).
   * Deliberately still a high-water mark, unlike `trust`: it is a display and
   * evidence field describing *how* resolution happened, and "this request's
   * domain did hit the directory" stays worth recording even when a sibling
   * identifier was never attested. The per-identifier truth now lives on each
   * ref, so this field no longer has to carry a decision.
   */
  let verifiedSource: ResolvedMerchant["resolution_source"] | null = null;
  let mcc = assertion.mcc;
  let mccSource: ResolvedMerchant["mcc_source"] = mcc ? "assertion" : undefined;

  // D-34: only a rail's own callback can make a psp_account/network_mid
  // field VERIFIED by itself -- an agent asserting either on
  // POST /v1/authorizations is exactly as untrustworthy as it asserting a
  // bare name, since it can type any string into any of these fields.
  const attestedByRail = source === MerchantAttestationSource.RAIL;
  const verifiedAt = now.toISOString();

  /** A new identifier starts unverified; `verified` is why it wouldn't. */
  const push = (scheme: MerchantScheme, value: string, verified: boolean) => {
    refs.push({
      scheme,
      value,
      trust: verified ? MerchantTrust.VERIFIED : MerchantTrust.ASSERTED,
      source,
      verified_at: verified ? verifiedAt : null,
    });
  };

  if (assertion.psp_account) {
    push(MerchantScheme.PSP_ACCOUNT, assertion.psp_account, attestedByRail);
    if (attestedByRail) verifiedSource ??= "psp";
  }

  if (assertion.network_mid) {
    // D-33: a network_mid is assigned by the card network/acquirer, not typed
    // by the agent -- the same corroboration class as psp_account, per D-3's
    // table ("network_mid — yes, acquirer-assigned", no directory caveat the
    // way domain has one). But that reasoning only holds when the rail itself
    // is the one asserting it (D-34) -- an agent typing the same string
    // proves nothing.
    push(MerchantScheme.NETWORK_MID, assertion.network_mid, attestedByRail);
    if (attestedByRail) {
      verifiedSource ??= "network";
      if (mcc && mccSource === "assertion") mccSource = "network";
    }
  }

  if (assertion.onchain_address) {
    // D-40: the same corroboration class as psp_account/network_mid -- the
    // payee address a rail's own callback reports is where the money actually
    // settles, not something the party requesting the payment could
    // fabricate. Only holds when the rail itself is the source (D-34); an
    // agent typing the same address proves nothing.
    push(MerchantScheme.ONCHAIN_ADDRESS, assertion.onchain_address, attestedByRail);
    if (attestedByRail) verifiedSource ??= "onchain";
  }

  const domain = assertion.domain ? normalizeDomain(assertion.domain) : null;
  if (domain) {
    const entry = directory.lookupDomain(domain);
    // A directory hit is unaffected by attestation source: the corroboration
    // is Waysafe's own directory recognizing this domain, not a claim about
    // who supplied the string. A rail-attested host verifies for the D-34
    // reason instead -- the rail, not the agent, is where the value came from.
    push(MerchantScheme.DOMAIN, domain, entry !== undefined || attestedByRail);
    if (entry) {
      verifiedSource ??= "directory";
      if (!mcc && entry.mcc) {
        mcc = entry.mcc;
        mccSource = "directory";
      }
    }
  }

  if (assertion.name) {
    // Never an identity scheme, so never verified and never allowlistable --
    // non-negotiable #3's original case.
    push(MerchantScheme.NAME, assertion.name, false);
  }

  if (mcc) push(MerchantScheme.MCC, mcc, false);

  return {
    trust: summarizeTrust(refs),
    refs,
    mcc,
    mcc_source: mccSource,
    display_name: assertion.name ?? domain ?? undefined,
    resolution_source: verifiedSource ?? (refs.length > 0 ? "assertion" : "none"),
  };
}

/**
 * The low-water mark over identity refs -- D-69.
 *
 * VERIFIED only when every identity ref is verified, so no sibling's
 * verification can speak for an identifier of its own. The UNKNOWN cases are
 * preserved exactly as they were before D-69: nothing usable at all, or an
 * MCC and nothing else (an MCC is a category, never an identity), both still
 * reach `DENY_MERCHANT_UNRESOLVED`. A bare `name` still resolves to ASSERTED
 * with no identity ref, and still caps at STEP_UP rather than denying.
 */
function summarizeTrust(refs: ResolvedMerchantRef[]): MerchantTrust {
  const identifying = refs.filter((ref) => ref.scheme !== MerchantScheme.MCC);
  if (identifying.length === 0) return MerchantTrust.UNKNOWN;

  const identity = identifying.filter((ref) => isIdentityScheme(ref.scheme));
  if (identity.length === 0) return MerchantTrust.ASSERTED;

  return identity.every((ref) => ref.trust === MerchantTrust.VERIFIED)
    ? MerchantTrust.VERIFIED
    : MerchantTrust.ASSERTED;
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
