/**
 * FINDING 4 of the adversarial review of 387958a: merchant trust is stored
 * once for the whole resolved merchant, not per identifier.
 *
 * Breaks non-negotiable #3 -- "an unverified merchant can never produce
 * ALLOW" -- by letting a verified identifier launder an unverified one that
 * arrived in the same breath.
 *
 * NOTE ON THE FINDING'S FRAMING. The review describes attaching an
 * identifier to a stored merchant record, detaching it, and two records
 * colliding on one identifier. **No such store exists.** There is no
 * `Merchant` model in `packages/db/prisma/schema.prisma`, no merchant
 * repository anywhere in `apps/api`, and `resolveMerchant` is a pure
 * function over a single request's `MerchantAssertion` plus a read-only
 * domain directory. So there is nothing to attach to, nothing to detach
 * from, and no two records to collide.
 *
 * The underlying defect is real and worse than the framing suggests,
 * because it needs no persistence at all: trust bleeds between identifiers
 * **within one request**. Every case below is therefore written against the
 * mechanism that actually exists, and each says which of the review's
 * lettered cases it stands in for.
 *
 * Written as the attack first: every test here passed against 37749c6, with
 * the laundering asserted as the observed behavior. D-69 flipped each one to
 * assert the block, and each case still records what it used to do.
 */

import { describe, expect, it } from "vitest";
import { evaluate } from "./engine/evaluate.js";
import { emptySpendSnapshot } from "./engine/types.js";
import { toMinorUnits } from "./money.js";
import { parsePolicy, POLICY_SCHEMA_VERSION, type Policy } from "./policy.js";
import { Decision, ReasonCode } from "./reason-codes.js";
import type { ProposedAction } from "./domain.js";
import {
  MerchantAttestationSource,
  MerchantScheme,
  MerchantTrust,
  createStaticDirectory,
  describeMerchantIdentifiers,
  domainMatches,
  merchantRefKey,
  normalizeDomain,
  resolveMerchant,
  satisfiesAllowlist,
  unverifiedIdentityRefs,
  verifiedMerchantKeys,
  type MerchantRef,
} from "./merchant.js";

/** The real merchant, in Waysafe's own directory -- the only thing that can
 * make a domain VERIFIED without a rail attesting it. */
const DIRECTORY = createStaticDirectory([
  { domain: "staples.com", display_name: "Staples", mcc: "5943" },
  { domain: "amazon.com", display_name: "Amazon" },
]);

/** An identifier the attacker made up. Nothing attests it. */
const ATTACKER_PSP = "acct_attacker_controlled";
const ATTACKER_MID = "999999999999999";
const ATTACKER_ADDRESS = "0xattacker00000000000000000000000000000001";


function policyFrom(overrides: Record<string, unknown>): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "finding 4",
    currency: "USD",
    per_transaction_max: toMinorUnits(500, "USD"),
    merchants: { allow: [], deny: [], unlisted: "DENY" },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(`test policy failed to parse: ${JSON.stringify(result.issues)}`);
  return result.policy;
}

/** One real `evaluate()` call over a real resolved merchant. */
function run(
  policy: Policy,
  assertion: Parameters<typeof resolveMerchant>[0],
  opts: {
    spend?: ReturnType<typeof emptySpendSnapshot>;
    source?: MerchantAttestationSource;
  } = {},
) {
  const action = {
    amount: toMinorUnits(80, "USD"),
    currency: "USD",
    merchant: assertion,
    attestations: {},
  } as unknown as ProposedAction;
  return evaluate({
    policy,
    action,
    merchant: resolveMerchant(
      assertion,
      DIRECTORY,
      opts.source ?? MerchantAttestationSource.AGENT,
    ),
    spend: opts.spend ?? emptySpendSnapshot(),
    now: new Date("2026-10-04T12:00:00.000Z"),
  });
}

describe("FINDING 4: trust is per-merchant, not per-identifier (breaks non-negotiable #3)", () => {
  it("(a) THE ATTACK: a directory-verified domain launders an agent-asserted PSP account in the same request", () => {
    // The agent supplies both: a real domain it does not control, and a PSP
    // account id it does. Only the domain is corroborated -- by Waysafe's
    // own directory, which says nothing whatsoever about the PSP id.
    const resolved = resolveMerchant(
      { domain: "staples.com", psp_account: ATTACKER_PSP },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );

    // Before D-69: one trust value for the whole merchant, set VERIFIED by
    // the domain. Now the low-water mark over identity refs, so the
    // unattested PSP id drags the summary down to ASSERTED.
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
    // Still records that the domain genuinely hit the directory -- that is a
    // true fact about resolution, and the per-ref trust carries the rest.
    expect(resolved.resolution_source).toBe("directory");

    // Each identifier now answers for itself.
    const byScheme = (scheme: string) => resolved.refs.find((r) => r.scheme === scheme)!;
    expect(byScheme(MerchantScheme.DOMAIN).trust).toBe(MerchantTrust.VERIFIED);
    expect(byScheme(MerchantScheme.DOMAIN).verified_at).not.toBeNull();
    expect(byScheme(MerchantScheme.PSP_ACCOUNT).trust).toBe(MerchantTrust.ASSERTED);
    expect(byScheme(MerchantScheme.PSP_ACCOUNT).verified_at).toBeNull();

    // An allowlist that names ONLY the attacker's PSP account -- the kind a
    // principal would write to pin payouts to one settlement account.
    const allowlist: MerchantRef[] = [
      { scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP },
    ];

    const result = satisfiesAllowlist(allowlist, resolved);

    // Still matches by value -- the allowlist does name this string -- but no
    // longer verified, so the ceiling is STEP_UP and never ALLOW.
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.via).toEqual({ scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP });
    expect(result.matched_ref?.trust).toBe(MerchantTrust.ASSERTED);

    // And the receipt names WHICH identifier failed, so a human resolving the
    // step-up can see a laundered sibling for what it is.
    expect(describeMerchantIdentifiers(resolved)).toBe(
      `psp_account ${ATTACKER_PSP} UNVERIFIED; domain staples.com VERIFIED`,
    );
  });

  it("(b) card rail: the same laundering with a network_mid, which is what an Issuing allowlist pins", () => {
    const resolved = resolveMerchant(
      { domain: "staples.com", network_mid: ATTACKER_MID },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED); // was VERIFIED

    const allowlist: MerchantRef[] = [
      { scheme: MerchantScheme.NETWORK_MID, value: ATTACKER_MID },
    ];
    const result = satisfiesAllowlist(allowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false); // was true
  });

  it("(b2) and on-chain: an agent-asserted payee address inherits the domain's verification", () => {
    const resolved = resolveMerchant(
      { domain: "amazon.com", onchain_address: ATTACKER_ADDRESS },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED); // was VERIFIED

    const result = satisfiesAllowlist(
      [{ scheme: MerchantScheme.ONCHAIN_ADDRESS, value: ATTACKER_ADDRESS }],
      resolved,
    );
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false); // was true
  });

  it("(c) the reverse: an allowlist pinned to a verified DOMAIN is satisfied by a request carrying a laundered sibling", () => {
    // The principal allowlisted staples.com. The agent sends staples.com
    // (so it matches) plus its own PSP id -- and the resolved merchant now
    // carries BOTH refs, so a downstream consumer reading `refs` sees the
    // attacker's account as part of a verified merchant.
    const resolved = resolveMerchant(
      { domain: "staples.com", psp_account: ATTACKER_PSP },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );

    const result = satisfiesAllowlist(
      [{ scheme: MerchantScheme.DOMAIN, value: "staples.com" }],
      resolved,
    );
    // The matched identifier -- the domain -- IS verified, so condition 1 of
    // satisfiesAllowlist holds on its own. This case is why condition 2
    // exists: the money is going to a psp_account nothing corroborated, and
    // matching a verified domain says nothing about that.
    expect(result.matched).toBe(true);
    expect(result.matched_ref?.trust).toBe(MerchantTrust.VERIFIED);
    expect(result.verified).toBe(false); // was true
    expect(result.unverified_refs.map((r) => r.value)).toEqual([ATTACKER_PSP]);

    // The attacker's PSP id is still recorded -- it is what the request
    // carried -- but it now carries its own verdict rather than riding on the
    // merchant's. Before D-69 the ref had no trust field at all to consult.
    const pspRef = resolved.refs.find((r) => r.scheme === MerchantScheme.PSP_ACCOUNT)!;
    expect(pspRef.trust).toBe(MerchantTrust.ASSERTED);
    expect(pspRef.source).toBe(MerchantAttestationSource.AGENT);
    expect(pspRef.verified_at).toBeNull();
    expect(Object.keys(pspRef).sort()).toEqual([
      "scheme",
      "source",
      "trust",
      "value",
      "verified_at",
    ]);
  });

  it("(d) direction matters, and only one direction is safe: an unverified-only assertion stays unverified", () => {
    // Stands in for the review's "identifier moved between records": with
    // no store, the equivalent question is whether an unattested identifier
    // can reach VERIFIED on its own. It cannot -- D-34 holds.
    const aloneAndUnattested = resolveMerchant(
      { psp_account: ATTACKER_PSP },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(aloneAndUnattested.trust).toBe(MerchantTrust.ASSERTED);
    expect(
      satisfiesAllowlist([{ scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP }], aloneAndUnattested)
        .verified,
    ).toBe(false);

    // Pairing it with a verified sibling used to launder it. The identifier
    // now resolves identically whether or not a verified sibling is present,
    // which is the whole point of per-identifier trust.
    const paired = resolveMerchant(
      { psp_account: ATTACKER_PSP, domain: "staples.com" },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(
      satisfiesAllowlist([{ scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP }], paired).verified,
    ).toBe(false); // was true
    const alonePsp = aloneAndUnattested.refs.find((r) => r.scheme === MerchantScheme.PSP_ACCOUNT)!;
    const pairedPsp = paired.refs.find((r) => r.scheme === MerchantScheme.PSP_ACCOUNT)!;
    expect(pairedPsp.trust).toBe(alonePsp.trust);
  });

  it("(d2) a rail-attested identifier launders an unknown domain in the other direction too", () => {
    // Not just domain -> psp. A rail-attested PSP account sets VERIFIED, and
    // a domain nobody has ever heard of then matches as verified.
    const resolved = resolveMerchant(
      { psp_account: "acct_real_merchant", domain: "totally-unknown-domain.example" },
      DIRECTORY,
      MerchantAttestationSource.RAIL,
    );
    expect(resolved.resolution_source).toBe("psp");

    const result = satisfiesAllowlist(
      [{ scheme: MerchantScheme.DOMAIN, value: "totally-unknown-domain.example" }],
      resolved,
    );
    expect(result.matched).toBe(true);
    // A rail attested this host, so the domain identifier verifies for the
    // D-34 reason -- the rail, not the agent, is where the value came from.
    // That is the x402 case: the host comes from a resource URL Waysafe
    // fetched itself. What D-69 removes is the *inheritance*: it verifies
    // because the rail said it, not because a sibling did.
    expect(result.matched_ref?.source).toBe(MerchantAttestationSource.RAIL);
    expect(result.verified).toBe(true);
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);

    // The same domain, asserted by an AGENT instead, does not verify -- which
    // is what the pre-D-69 code got wrong whenever a verified sibling was
    // present alongside it.
    const byAgent = resolveMerchant(
      { psp_account: "acct_real_merchant", domain: "totally-unknown-domain.example" },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(
      satisfiesAllowlist(
        [{ scheme: MerchantScheme.DOMAIN, value: "totally-unknown-domain.example" }],
        byAgent,
      ).verified,
    ).toBe(false);
  });

  it("(e) collision has no meaning here -- there are no merchant records to collide", () => {
    // The review's case (e) presumes two stored records claiming one
    // identifier. With resolution pure and per-request, the nearest real
    // question is: does the ORDER of fields change the outcome? It did not
    // before D-69 (a high-water mark, so whichever identifier verified first
    // won and the rest inherited it) and it does not after (a low-water mark
    // over per-identifier verdicts). Order-independent either way -- what
    // changed is which way it collapses.
    const domainFirst = resolveMerchant(
      { domain: "staples.com", psp_account: ATTACKER_PSP },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    const pspFirst = resolveMerchant(
      { psp_account: ATTACKER_PSP, domain: "staples.com" },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(domainFirst.trust).toBe(pspFirst.trust);
    expect(domainFirst.trust).toBe(MerchantTrust.ASSERTED); // was VERIFIED
    expect(unverifiedIdentityRefs(domainFirst).map((r) => r.scheme)).toEqual(
      unverifiedIdentityRefs(pspFirst).map((r) => r.scheme),
    );
  });

  it("(f) normalization: differently-written forms of a domain are the SAME identifier, which is correct", () => {
    // These genuinely are one domain, so inheriting the directory's
    // verification is right, not a bug. Asserted so a fix does not break it.
    for (const written of ["staples.com", "Staples.COM", "www.staples.com", "staples.com.", "https://staples.com/cart?x=1"]) {
      expect(normalizeDomain(written)).toBe("staples.com");
      const resolved = resolveMerchant({ domain: written }, DIRECTORY, MerchantAttestationSource.AGENT);
      expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    }
  });

  it("(f2) a non-ASCII homograph is rejected outright -- it produces no domain ref at all", () => {
    // Cyrillic "а" in "stаples.com". normalizeDomain's own character class
    // is ASCII-only, so this is not a near-miss that inherits trust: there
    // is no domain identifier, and the merchant falls back to whatever else
    // was supplied.
    const homograph = "stаples.com";
    expect(normalizeDomain(homograph)).toBeNull();

    const resolved = resolveMerchant({ domain: homograph }, DIRECTORY, MerchantAttestationSource.AGENT);
    expect(resolved.refs.some((r) => r.scheme === MerchantScheme.DOMAIN)).toBe(false);
    expect(resolved.trust).toBe(MerchantTrust.UNKNOWN);
  });

  it("(f3) a punycode homograph is a DIFFERENT identifier and does not inherit anything", () => {
    // xn-- forms pass the ASCII character class, so they resolve as a
    // domain -- but as their own, unknown one. Correct behavior; pinned.
    const puny = "xn--staples-5we.com";
    expect(normalizeDomain(puny)).toBe(puny);
    const resolved = resolveMerchant({ domain: puny }, DIRECTORY, MerchantAttestationSource.AGENT);
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
  });

  it("(f4) THE AMPLIFIER, closed by D-70: an asserted subdomain of a listed merchant is no longer VERIFIED", () => {
    // I expected ASSERTED here originally and was wrong --
    // `createStaticDirectory`'s `lookupDomain` fell back to
    // `domainMatches(known, normalized)`, so a subdomain hit the directory
    // entry for its parent. Nothing anywhere verified that the party
    // asserting "checkout.staples.com" controlled it; an agent simply typed
    // the string. So an agent could MINT verified trust for any listed
    // merchant at will, and then launder its own PSP id through it via (a) --
    // without the real staples.com being involved at all.
    //
    // D-69 closed the laundering half; D-70 closed the minting half. See the
    // D-70 block at the bottom of this file for the full case.
    const resolved = resolveMerchant(
      { domain: "checkout.staples.com" },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED); // was VERIFIED
    expect(resolved.resolution_source).toBe("assertion"); // was "directory"

    // D-69 closed the laundering half of this: the invented subdomain still
    // verifies as a DOMAIN identifier (that is D-70's job), but it can no
    // longer vouch for a psp_account sibling.
    const invented = resolveMerchant(
      { domain: "attacker-controlled.staples.com", psp_account: ATTACKER_PSP },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(
      satisfiesAllowlist([{ scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP }], invented).verified,
    ).toBe(false); // was true, pre-D-69

    // The suffix rule itself is sane in the other direction -- a lookalike
    // parent does not match.
    expect(domainMatches("staples.com", "staples.com.evil.example")).toBe(false);
    expect(
      resolveMerchant({ domain: "staples.com.evil.example" }, DIRECTORY, MerchantAttestationSource.AGENT)
        .trust,
    ).toBe(MerchantTrust.ASSERTED);
  });

  it("(g1) a NAME cannot be laundered -- isIdentityScheme already excludes it, and that holds", () => {
    // The one place per-ref reasoning already exists. #3's original clause.
    const resolved = resolveMerchant(
      { domain: "staples.com", name: "Totally Not Staples" },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    const result = satisfiesAllowlist(
      [{ scheme: MerchantScheme.NAME, value: "Totally Not Staples" }],
      resolved,
    );
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false); // name is not an identity scheme
  });

  it("(g2) an MCC cannot be laundered either", () => {
    const resolved = resolveMerchant(
      { domain: "staples.com", mcc: "7995" }, // gambling MCC on a verified office-supply domain
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    const result = satisfiesAllowlist([{ scheme: MerchantScheme.MCC, value: "7995" }], resolved);
    expect(result.verified).toBe(false);
  });

  it("(g3) first-use detection is no longer poisoned: an unattested identifier never enters the seen set", () => {
    // step_up_on_first_use asks "have we transacted with this merchant
    // before?". Before D-69 that question was asked against merchantRefKey
    // over EVERY ref, so a laundered PSP id rode along into the seen-merchant
    // set on the first payment, and a later payment naming only that id
    // looked familiar rather than new -- suppressing the step-up the
    // principal asked for. The set is now keyed on verified identifiers only.
    const resolved = resolveMerchant(
      { domain: "staples.com", psp_account: ATTACKER_PSP },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    const pspKey = merchantRefKey({ scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP });

    // The old, poisoned key set -- every ref -- still contains it.
    expect(resolved.refs.map(merchantRefKey)).toContain(pspKey);
    // The one the engine and both repositories actually use does not.
    expect(verifiedMerchantKeys(resolved)).not.toContain(pspKey);
    expect(verifiedMerchantKeys(resolved)).toEqual(["domain:staples.com"]);
  });

  // --- Through the real engine ---------------------------------------------
  //
  // Everything above tests the resolver. These two go through `evaluate()`,
  // because the two things D-69 owes a principal are decisions and receipts,
  // not resolver internals.

  it("the receipt names WHICH identifier was unverified, and a laundered sibling reads differently from an unknown merchant", () => {
    const policy = policyFrom({
      merchants: {
        allow: [{ scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP }],
        deny: [],
        unlisted: "DENY",
      },
    });

    // The laundering attempt: a real domain, the attacker's own account.
    const laundered = run(policy, { domain: "staples.com", psp_account: ATTACKER_PSP });
    expect(laundered.decision).toBe(Decision.STEP_UP);
    const reason = laundered.reasons.find(
      (r) => r.code === ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
    )!;
    expect(reason).toBeDefined();
    expect(reason.detail?.summary).toBe(
      `psp_account ${ATTACKER_PSP} UNVERIFIED; domain staples.com VERIFIED`,
    );
    expect(reason.detail?.unverified_identifiers).toEqual([`psp_account:${ATTACKER_PSP}`]);
    expect(reason.detail?.identifiers).toEqual([
      {
        scheme: MerchantScheme.PSP_ACCOUNT,
        value: ATTACKER_PSP,
        trust: MerchantTrust.ASSERTED,
        source: MerchantAttestationSource.AGENT,
        verified_at: null,
      },
      {
        scheme: MerchantScheme.DOMAIN,
        value: "staples.com",
        trust: MerchantTrust.VERIFIED,
        source: MerchantAttestationSource.AGENT,
        verified_at: expect.any(String),
      },
    ]);
    // The message a human actually reads carries it too, not just `detail`.
    expect(reason.message).toContain("domain staples.com VERIFIED");

    // A wholly unknown merchant produces a visibly different receipt: no
    // identifier verified, so nothing to mistake for a corroborated one.
    const unknown = run(policy, { psp_account: ATTACKER_PSP });
    const unknownReason = unknown.reasons.find(
      (r) => r.code === ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
    )!;
    expect(unknownReason.detail?.summary).toBe(`psp_account ${ATTACKER_PSP} UNVERIFIED`);
    expect(unknownReason.detail?.summary).not.toContain("VERIFIED;");
  });

  it("(g3) end to end: a laundered PSP id does not suppress step_up_on_first_use on its next appearance", () => {
    const policy = policyFrom({
      merchants: {
        allow: [
          { scheme: MerchantScheme.DOMAIN, value: "staples.com" },
          { scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP },
        ],
        deny: [],
        unlisted: "DENY",
        step_up_on_first_use: true,
      },
    });

    // Payment one, at the real merchant. The attacker rides its own PSP id
    // along, hoping to register it as a merchant this mandate has seen.
    const first = resolveMerchant(
      { domain: "staples.com", psp_account: ATTACKER_PSP },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    const seen = new Set(verifiedMerchantKeys(first));
    expect(seen).toEqual(new Set(["domain:staples.com"]));

    // Payment two names only the laundered id, rail-attested this time so the
    // identifier itself verifies and the first-use rule is actually reached.
    // It is a new merchant, and the step-up fires.
    const second = run(
      policy,
      { psp_account: ATTACKER_PSP },
      { spend: { ...emptySpendSnapshot(), seenMerchants: seen }, source: MerchantAttestationSource.RAIL },
    );
    expect(second.decision).toBe(Decision.STEP_UP);
    expect(second.reasons.map((r) => r.code)).toContain(
      ReasonCode.STEP_UP_FIRST_TIME_MERCHANT,
    );

    // CONTROL: the pre-D-69 seen set -- every ref -- would have contained the
    // laundered id, and the step-up would have been suppressed.
    const poisoned = new Set(first.refs.map(merchantRefKey));
    const suppressed = run(
      policy,
      { psp_account: ATTACKER_PSP },
      { spend: { ...emptySpendSnapshot(), seenMerchants: poisoned }, source: MerchantAttestationSource.RAIL },
    );
    expect(suppressed.reasons.map((r) => r.code)).not.toContain(
      ReasonCode.STEP_UP_FIRST_TIME_MERCHANT,
    );
  });

  it("CONTROL: a genuinely rail-attested PSP account matching a PSP allowlist is verified, and must stay so", () => {
    const resolved = resolveMerchant(
      { psp_account: "acct_real_merchant" },
      DIRECTORY,
      MerchantAttestationSource.RAIL,
    );
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    const result = satisfiesAllowlist(
      [{ scheme: MerchantScheme.PSP_ACCOUNT, value: "acct_real_merchant" }],
      resolved,
    );
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("CONTROL: a directory-verified domain matching a DOMAIN allowlist is verified, and must stay so", () => {
    const resolved = resolveMerchant({ domain: "staples.com" }, DIRECTORY, MerchantAttestationSource.AGENT);
    const result = satisfiesAllowlist([{ scheme: MerchantScheme.DOMAIN, value: "staples.com" }], resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(true);
  });
});

/**
 * D-70 -- SELF-FOUND, not in the review.
 *
 * Found while writing D-69's case (f4): I expected an asserted subdomain of
 * a listed merchant to be ASSERTED, asserted that, and was wrong. The
 * directory suffix-matched, so an agent could mint VERIFIED trust for any
 * listed merchant by typing a hostname nobody had ever checked.
 *
 * Non-negotiable #3's clause -- any change to merchant matching ships with a
 * test proving the attack fails -- so these land in the same commit as the
 * fix.
 */
describe("D-70: the merchant directory is exact-match, not suffix-match (self-found)", () => {
  it("THE ATTACK: an invented subdomain of a listed merchant resolves ASSERTED, not VERIFIED", () => {
    const resolved = resolveMerchant(
      { domain: "attacker-controlled.staples.com" },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
    expect(resolved.resolution_source).toBe("assertion");
    const domainRef = resolved.refs.find((r) => r.scheme === MerchantScheme.DOMAIN)!;
    expect(domainRef.trust).toBe(MerchantTrust.ASSERTED);
    expect(domainRef.verified_at).toBeNull();

    // So it cannot satisfy even an allowlist that names the real parent --
    // it matches by value (the principal's own suffix rule, deliberately
    // kept) but is never verified, so the ceiling is STEP_UP.
    const result = satisfiesAllowlist(
      [{ scheme: MerchantScheme.DOMAIN, value: "staples.com" }],
      resolved,
    );
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false);
  });

  it("the minting + laundering chain is dead end to end", () => {
    // The full D-69 + D-70 attack: mint trust from a subdomain nobody
    // checked, then launder the agent's own payout account through it.
    const minted = resolveMerchant(
      { domain: "attacker-controlled.staples.com", psp_account: ATTACKER_PSP },
      DIRECTORY,
      MerchantAttestationSource.AGENT,
    );
    expect(minted.trust).toBe(MerchantTrust.ASSERTED);
    expect(unverifiedIdentityRefs(minted)).toHaveLength(2); // neither verifies now
    expect(
      satisfiesAllowlist([{ scheme: MerchantScheme.PSP_ACCOUNT, value: ATTACKER_PSP }], minted)
        .verified,
    ).toBe(false);
  });

  it("CONTROL: a listed checkout.<merchant> host is still VERIFIED", () => {
    // The legitimate need the suffix rule was papering over. Now it is
    // something a human wrote down, and only the host that was written down
    // matches.
    const directory = createStaticDirectory([
      {
        domain: "staples.com",
        display_name: "Staples",
        mcc: "5943",
        hosts: ["checkout.staples.com", "pay.staples.com"],
      },
    ]);

    for (const host of ["staples.com", "checkout.staples.com", "pay.staples.com"]) {
      const resolved = resolveMerchant({ domain: host }, directory, MerchantAttestationSource.AGENT);
      expect(resolved.trust, host).toBe(MerchantTrust.VERIFIED);
      expect(resolved.resolution_source, host).toBe("directory");
      // The entry's MCC comes through on a listed host too, not just the apex.
      expect(resolved.mcc, host).toBe("5943");
    }

    // Listing two hosts does not list a third.
    expect(
      resolveMerchant(
        { domain: "attacker-controlled.staples.com" },
        directory,
        MerchantAttestationSource.AGENT,
      ).trust,
    ).toBe(MerchantTrust.ASSERTED);

    // www. is not a special case -- normalizeDomain strips it before lookup,
    // so it resolves as the apex it is.
    expect(
      resolveMerchant({ domain: "www.staples.com" }, directory, MerchantAttestationSource.AGENT)
        .trust,
    ).toBe(MerchantTrust.VERIFIED);
  });

  it("CONTROL: include_subdomains still accepts a whole zone, but only when set", () => {
    // The opt-out. Off by default -- which was the defect -- and a real
    // claim about a real DNS zone when on.
    const openZone = createStaticDirectory([
      { domain: "staples.com", display_name: "Staples", include_subdomains: true },
    ]);
    expect(
      resolveMerchant({ domain: "anything.staples.com" }, openZone, MerchantAttestationSource.AGENT)
        .trust,
    ).toBe(MerchantTrust.VERIFIED);
    expect(
      resolveMerchant(
        { domain: "deeply.nested.staples.com" },
        openZone,
        MerchantAttestationSource.AGENT,
      ).trust,
    ).toBe(MerchantTrust.VERIFIED);

    // NEGATIVE CONTROL for this test: the same lookup against the same entry
    // without the flag is ASSERTED, so the flag is what is being tested and
    // not some other path.
    const closedZone = createStaticDirectory([
      { domain: "staples.com", display_name: "Staples" },
    ]);
    expect(
      resolveMerchant({ domain: "anything.staples.com" }, closedZone, MerchantAttestationSource.AGENT)
        .trust,
    ).toBe(MerchantTrust.ASSERTED);

    // And a lookalike parent is still not in the zone, flag or no flag.
    expect(
      resolveMerchant(
        { domain: "staples.com.evil.example" },
        openZone,
        MerchantAttestationSource.AGENT,
      ).trust,
    ).toBe(MerchantTrust.ASSERTED);
  });
});
