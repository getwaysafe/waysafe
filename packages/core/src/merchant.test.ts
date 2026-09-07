import { describe, expect, it } from "vitest";
import {
  createStaticDirectory,
  domainMatches,
  MerchantTrust,
  normalizeDomain,
  resolveMerchant,
  satisfiesAllowlist,
  matchesDenylist,
  type MerchantRef,
} from "./merchant.js";

const directory = createStaticDirectory([
  { domain: "staples.com", display_name: "Staples", mcc: "5943" },
  { domain: "amazon.com", display_name: "Amazon", mcc: "5942" },
]);

const allowlist: MerchantRef[] = [
  { scheme: "domain", value: "staples.com", label: "Staples" },
  { scheme: "domain", value: "amazon.com", label: "Amazon" },
];

describe("domain normalization", () => {
  it("strips scheme, www, port, path and case", () => {
    expect(normalizeDomain("HTTPS://WWW.Staples.com:443/office/pens?a=1")).toBe(
      "staples.com",
    );
  });

  it("rejects things that are not domains", () => {
    expect(normalizeDomain("Staples")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });

  it("matches subdomains but not lookalikes", () => {
    expect(domainMatches("staples.com", "shop.staples.com")).toBe(true);
    expect(domainMatches("staples.com", "staples.com.evil.co")).toBe(false);
    expect(domainMatches("staples.com", "staples-shop.com")).toBe(false);
    expect(domainMatches("staples.com", "notstaples.com")).toBe(false);
  });
});

describe("merchant resolution", () => {
  it("treats a rail-attested PSP account as verified", () => {
    const resolved = resolveMerchant({ psp_account: "acct_123" }, directory, "rail");
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    expect(resolved.resolution_source).toBe("psp");
  });

  it("THE ATTACK: D-34 -- an agent-attested PSP account id is only asserted, not verified", () => {
    // D-34: an agent can type `psp_account` on POST /v1/authorizations just
    // as freely as it can type `name` -- the field alone proves nothing.
    const resolved = resolveMerchant({ psp_account: "acct_123" }, directory, "agent");
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
    expect(resolved.resolution_source).toBe("assertion");
  });

  it("treats a known domain as verified and picks up its MCC", () => {
    const resolved = resolveMerchant(
      { name: "Staples", domain: "staples.com" },
      directory,
      "agent",
    );
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    expect(resolved.mcc).toBe("5943");
  });

  it("treats an unknown domain as merely asserted", () => {
    const resolved = resolveMerchant({ domain: "some-shop.example" }, directory, "agent");
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
  });

  it("treats a bare name as asserted with no identity reference", () => {
    const resolved = resolveMerchant({ name: "Staples" }, directory, "agent");
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
    expect(resolved.refs.every((r) => r.scheme === "name")).toBe(true);
  });

  it("returns UNKNOWN when nothing usable is supplied", () => {
    expect(resolveMerchant({}, directory, "agent").trust).toBe(MerchantTrust.UNKNOWN);
  });

  it("D-33: treats a rail-attested network merchant id as verified, same class as a PSP account", () => {
    const resolved = resolveMerchant({ network_mid: "visa_mid_123" }, directory, "rail");
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    expect(resolved.resolution_source).toBe("network");
  });

  it("THE ATTACK: D-34 -- an agent-attested network merchant id is only asserted, not verified", () => {
    // The exact gap D-34 closes: D-33 made network_mid VERIFIED-eligible
    // without asking who supplied it, so an agent asserting a real
    // network_mid on the authorize() path got the same free ALLOW a bare
    // psp_account claim already could.
    const resolved = resolveMerchant({ network_mid: "visa_mid_123" }, directory, "agent");
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
    expect(resolved.resolution_source).toBe("assertion");
  });

  it("D-33: an MCC alongside a rail-attested network_mid is tagged network-sourced, not a bare assertion", () => {
    const resolved = resolveMerchant(
      { network_mid: "visa_mid_123", mcc: "5943" },
      directory,
      "rail",
    );
    expect(resolved.mcc).toBe("5943");
    expect(resolved.mcc_source).toBe("network");
  });

  it("D-34: an MCC alongside an agent-attested network_mid is tagged a bare assertion", () => {
    const resolved = resolveMerchant(
      { network_mid: "visa_mid_123", mcc: "5943" },
      directory,
      "agent",
    );
    expect(resolved.mcc).toBe("5943");
    expect(resolved.mcc_source).toBe("assertion");
  });
});

describe("allowlist enforcement", () => {
  it("verifies a real allowlisted merchant", () => {
    const resolved = resolveMerchant({ domain: "staples.com" }, directory, "agent");
    const result = satisfiesAllowlist(allowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("THE ATTACK: an agent that merely types the merchant name cannot get a verified match", () => {
    const resolved = resolveMerchant({ name: "Staples" }, directory, "agent");
    const result = satisfiesAllowlist(allowlist, resolved);
    expect(result.matched).toBe(false);
    expect(result.verified).toBe(false);
  });

  it("THE ATTACK: a lookalike domain does not match the allowlist", () => {
    const resolved = resolveMerchant(
      { name: "Staples", domain: "staples.com.checkout-secure.io" },
      directory,
      "agent",
    );
    expect(satisfiesAllowlist(allowlist, resolved).matched).toBe(false);
  });

  it("matches an allowlisted domain but does not call it verified when unknown to the directory", () => {
    const emptyDirectory = createStaticDirectory([]);
    const resolved = resolveMerchant({ domain: "staples.com" }, emptyDirectory, "agent");
    const result = satisfiesAllowlist(allowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false);
  });

  it("matches a subdomain of an allowlisted merchant", () => {
    const resolved = resolveMerchant({ domain: "shop.staples.com" }, directory, "agent");
    expect(satisfiesAllowlist(allowlist, resolved).matched).toBe(true);
  });

  it("D-33/D-34: a rail-attested network_mid can satisfy an allowlist entry of the same scheme", () => {
    const networkAllowlist: MerchantRef[] = [{ scheme: "network_mid", value: "visa_mid_staples" }];
    const resolved = resolveMerchant({ network_mid: "visa_mid_staples" }, directory, "rail");
    const result = satisfiesAllowlist(networkAllowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("THE ATTACK: D-34 -- an agent-attested network_mid matches the allowlist by value but is never verified", () => {
    // Same identifier, same allowlist entry, only the attestation source
    // differs from the test above -- matched stays true (the value really is
    // on the allowlist), but verified flips to false, which is what caps the
    // engine's decision at STEP_UP instead of ALLOW (see evaluate.test.ts).
    const networkAllowlist: MerchantRef[] = [{ scheme: "network_mid", value: "visa_mid_staples" }];
    const resolved = resolveMerchant({ network_mid: "visa_mid_staples" }, directory, "agent");
    const result = satisfiesAllowlist(networkAllowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false);
  });

  it("THE ATTACK: a network_mid match does not launder an accompanying merchant name claim", () => {
    // D-3 still applies per-scheme: matching on network_mid must not make an
    // *unrelated* name-only allowlist entry verified. Rail-attested here so
    // the network_mid itself genuinely does verify -- the point is that even
    // then, a *different* scheme's allow entry doesn't inherit that trust.
    const nameAllowlist: MerchantRef[] = [{ scheme: "name", value: "Staples" }];
    const resolved = resolveMerchant(
      { network_mid: "visa_mid_staples", name: "Staples" },
      directory,
      "rail",
    );
    const result = satisfiesAllowlist(nameAllowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false);
  });
});

describe("denylist enforcement", () => {
  it("blocks on a mere claim, with no verification required", () => {
    const denylist: MerchantRef[] = [{ scheme: "name", value: "LuckySlots" }];
    const resolved = resolveMerchant({ name: "LuckySlots" }, directory, "agent");
    expect(matchesDenylist(denylist, resolved).matched).toBe(true);
  });
});
