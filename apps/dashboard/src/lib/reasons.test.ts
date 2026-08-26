import { describe, expect, it } from "vitest";
import { formatDetail } from "./reasons.js";

describe("formatDetail", () => {
  it("renders each key/value pair, comma-separated", () => {
    expect(formatDetail({ amount: 8700, threshold: 15000 })).toBe("amount: 8700, threshold: 15000");
  });

  it("JSON-stringifies object/array values instead of rendering [object Object]", () => {
    expect(formatDetail({ matched_via: { scheme: "domain", value: "staples.com" } })).toBe(
      'matched_via: {"scheme":"domain","value":"staples.com"}',
    );
  });

  it("returns null for undefined detail", () => {
    expect(formatDetail(undefined)).toBeNull();
  });

  it("returns null for an empty detail object, not an empty string", () => {
    expect(formatDetail({})).toBeNull();
  });
});
