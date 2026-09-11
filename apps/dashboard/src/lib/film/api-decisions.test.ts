import { describe, expect, it } from "vitest";
import {
  normalizeCardAttempt,
  normalizeStablecoinPayResult,
  normalizeStablecoinRejection,
} from "./api-decisions";

describe("/film API decision normalizers -- the 'refuses to render' invariant (D-44)", () => {
  describe("normalizeCardAttempt", () => {
    const valid = {
      label: "$1,240.00 -- unknown merchant, card ending 4421",
      amount_cents: 124_000,
      approved: false,
      reason_codes: ["DENY_MERCHANT_NOT_ALLOWLISTED"],
    };

    it("passes a real, well-formed result through unchanged", () => {
      expect(normalizeCardAttempt(valid)).toEqual({
        label: valid.label,
        amountCents: 124_000,
        decision: "DENY",
        reasonCodes: ["DENY_MERCHANT_NOT_ALLOWLISTED"],
      });
    });

    it("maps a real approved:true to ALLOW", () => {
      expect(normalizeCardAttempt({ ...valid, approved: true, reason_codes: [] }).decision).toBe("ALLOW");
    });

    it("refuses to render when the real decision field is missing", () => {
      const { approved: _approved, ...withoutDecision } = valid;
      expect(() => normalizeCardAttempt(withoutDecision)).toThrow(/refusing to render/i);
    });

    it("refuses to render when approved is present but not a real boolean", () => {
      expect(() => normalizeCardAttempt({ ...valid, approved: "yes" })).toThrow(/refusing to render/i);
    });

    it("refuses to render a non-object payload", () => {
      expect(() => normalizeCardAttempt(null)).toThrow(/refusing to render/i);
      expect(() => normalizeCardAttempt("ALLOW")).toThrow(/refusing to render/i);
    });
  });

  describe("normalizeStablecoinPayResult", () => {
    const valid = {
      decision: "ALLOW",
      reason_codes: ["ALLOW_WITHIN_MANDATE"],
      settlement: { tx_hash: "0xabc123" },
    };

    it("passes a real, well-formed result through unchanged", () => {
      expect(normalizeStablecoinPayResult(valid)).toEqual({
        decision: "ALLOW",
        reasonCodes: ["ALLOW_WITHIN_MANDATE"],
        settlementTxHash: "0xabc123",
      });
    });

    it("accepts a real DENY with no settlement", () => {
      const denied = { decision: "DENY", reason_codes: ["DENY_MERCHANT_NOT_ALLOWLISTED"], settlement: null };
      expect(normalizeStablecoinPayResult(denied)).toEqual({
        decision: "DENY",
        reasonCodes: ["DENY_MERCHANT_NOT_ALLOWLISTED"],
        settlementTxHash: null,
      });
    });

    it("refuses to render when the decision field is missing", () => {
      const { decision: _decision, ...withoutDecision } = valid;
      expect(() => normalizeStablecoinPayResult(withoutDecision)).toThrow(/refusing to render/i);
    });

    it("refuses to render an unrecognized decision string -- never guesses one of the real three", () => {
      expect(() => normalizeStablecoinPayResult({ ...valid, decision: "MAYBE" })).toThrow(/refusing to render/i);
    });
  });

  describe("normalizeStablecoinRejection", () => {
    const valid = {
      name: "session_key_alone",
      description: "The stolen session key alone, threshold 2, only 1 signature present.",
      rejected: true,
      revert_reason: "GS020",
    };

    it("passes a real, well-formed rejection through unchanged", () => {
      expect(normalizeStablecoinRejection(valid)).toEqual({
        name: "session_key_alone",
        description: valid.description,
        rejected: true,
        revertReason: "GS020",
      });
    });

    it("refuses to render when the real rejected field is missing", () => {
      const { rejected: _rejected, ...withoutRejected } = valid;
      expect(() => normalizeStablecoinRejection(withoutRejected)).toThrow(/refusing to render/i);
    });

    it("refuses to render when rejected is present but not a real boolean", () => {
      expect(() => normalizeStablecoinRejection({ ...valid, rejected: "true" })).toThrow(/refusing to render/i);
    });
  });
});
