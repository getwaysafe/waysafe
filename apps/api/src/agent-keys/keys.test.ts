import { describe, expect, it } from "vitest";
import { API_KEY_MARKER, extractKeyPrefix, generateAgentApiKey, hashApiKey } from "./keys.js";

describe("generateAgentApiKey", () => {
  it("produces a key starting with the marker, a matching prefix, and a hash of the full key", () => {
    const generated = generateAgentApiKey();

    expect(generated.fullKey.startsWith(API_KEY_MARKER)).toBe(true);
    expect(generated.prefix.startsWith(API_KEY_MARKER)).toBe(true);
    expect(generated.fullKey.startsWith(generated.prefix)).toBe(true);
    expect(generated.secretHash).toBe(hashApiKey(generated.fullKey));
    // sha256 hex digest.
    expect(generated.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats across calls", () => {
    const a = generateAgentApiKey();
    const b = generateAgentApiKey();

    expect(a.fullKey).not.toBe(b.fullKey);
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.secretHash).not.toBe(b.secretHash);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", () => {
    const { fullKey } = generateAgentApiKey();
    expect(hashApiKey(fullKey)).toBe(hashApiKey(fullKey));
  });

  it("differs for different keys", () => {
    const a = generateAgentApiKey();
    const b = generateAgentApiKey();
    expect(hashApiKey(a.fullKey)).not.toBe(hashApiKey(b.fullKey));
  });
});

describe("extractKeyPrefix", () => {
  it("round-trips the prefix generateAgentApiKey produced", () => {
    const generated = generateAgentApiKey();
    expect(extractKeyPrefix(generated.fullKey)).toBe(generated.prefix);
  });

  it("returns null for a key missing the marker", () => {
    expect(extractKeyPrefix("sk_live_notanagentkey")).toBeNull();
  });

  it("returns null for a key too short to contain a full prefix", () => {
    expect(extractKeyPrefix("wsf_live_a")).toBeNull();
  });

  it("returns null for an empty or garbage string", () => {
    expect(extractKeyPrefix("")).toBeNull();
    expect(extractKeyPrefix("not a key at all")).toBeNull();
  });
});
