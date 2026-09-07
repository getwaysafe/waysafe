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
  it("treats a PSP account as verified", () => {
    const resolved = resolveMerchant({ psp_account: "acct_123" }, directory);
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    expect(resolved.resolution_source).toBe("psp");
  });

  it("treats a known domain as verified and picks up its MCC", () => {
    const resolved = resolveMerchant(
      { name: "Staples", domain: "staples.com" },
      directory,
    );
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    expect(resolved.mcc).toBe("5943");
  });

  it("treats an unknown domain as merely asserted", () => {
    const resolved = resolveMerchant({ domain: "some-shop.example" }, directory);
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
  });

  it("treats a bare name as asserted with no identity reference", () => {
    const resolved = resolveMerchant({ name: "Staples" }, directory);
    expect(resolved.trust).toBe(MerchantTrust.ASSERTED);
    expect(resolved.refs.every((r) => r.scheme === "name")).toBe(true);
  });

  it("returns UNKNOWN when nothing usable is supplied", () => {
    expect(resolveMerchant({}, directory).trust).toBe(MerchantTrust.UNKNOWN);
  });

  it("D-33: treats a network merchant id as verified, same class as a PSP account", () => {
    const resolved = resolveMerchant({ network_mid: "visa_mid_123" }, directory);
    expect(resolved.trust).toBe(MerchantTrust.VERIFIED);
    expect(resolved.resolution_source).toBe("network");
  });

  it("D-33: an MCC alongside a network_mid is tagged network-sourced, not a bare assertion", () => {
    const resolved = resolveMerchant({ network_mid: "visa_mid_123", mcc: "5943" }, directory);
    expect(resolved.mcc).toBe("5943");
    expect(resolved.mcc_source).toBe("network");
  });
});

describe("allowlist enforcement", () => {
  it("verifies a real allowlisted merchant", () => {
    const resolved = resolveMerchant({ domain: "staples.com" }, directory);
    const result = satisfiesAllowlist(allowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("THE ATTACK: an agent that merely types the merchant name cannot get a verified match", () => {
    const resolved = resolveMerchant({ name: "Staples" }, directory);
    const result = satisfiesAllowlist(allowlist, resolved);
    expect(result.matched).toBe(false);
    expect(result.verified).toBe(false);
  });

  it("THE ATTACK: a lookalike domain does not match the allowlist", () => {
    const resolved = resolveMerchant(
      { name: "Staples", domain: "staples.com.checkout-secure.io" },
      directory,
    );
    expect(satisfiesAllowlist(allowlist, resolved).matched).toBe(false);
  });

  it("matches an allowlisted domain but does not call it verified when unknown to the directory", () => {
    const emptyDirectory = createStaticDirectory([]);
    const resolved = resolveMerchant({ domain: "staples.com" }, emptyDirectory);
    const result = satisfiesAllowlist(allowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false);
  });

  it("matches a subdomain of an allowlisted merchant", () => {
    const resolved = resolveMerchant({ domain: "shop.staples.com" }, directory);
    expect(satisfiesAllowlist(allowlist, resolved).matched).toBe(true);
  });

  it("D-33: a verified network_mid can satisfy an allowlist entry of the same scheme", () => {
    const networkAllowlist: MerchantRef[] = [{ scheme: "network_mid", value: "visa_mid_staples" }];
    const resolved = resolveMerchant({ network_mid: "visa_mid_staples" }, directory);
    const result = satisfiesAllowlist(networkAllowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("THE ATTACK: a network_mid match does not launder an accompanying merchant name claim", () => {
    // D-3 still applies per-scheme: matching on network_mid must not make an
    // *unrelated* name-only allowlist entry verified.
    const nameAllowlist: MerchantRef[] = [{ scheme: "name", value: "Staples" }];
    const resolved = resolveMerchant({ network_mid: "visa_mid_staples", name: "Staples" }, directory);
    const result = satisfiesAllowlist(nameAllowlist, resolved);
    expect(result.matched).toBe(true);
    expect(result.verified).toBe(false);
  });
});

describe("denylist enforcement", () => {
  it("blocks on a mere claim, with no verification required", () => {
    const denylist: MerchantRef[] = [{ scheme: "name", value: "LuckySlots" }];
    const resolved = resolveMerchant({ name: "LuckySlots" }, directory);
    expect(matchesDenylist(denylist, resolved).matched).toBe(true);
  });
});
