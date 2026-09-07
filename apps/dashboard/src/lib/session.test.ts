import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSession, encryptSession } from "./session.js";

const ORIGINAL_SECRET = process.env.WAYSAFE_DASHBOARD_SESSION_SECRET;

beforeEach(() => {
  // A real (if test-only) 32-byte key -- not the app's actual secret.
  process.env.WAYSAFE_DASHBOARD_SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  process.env.WAYSAFE_DASHBOARD_SESSION_SECRET = ORIGINAL_SECRET;
});

describe("session cookie encryption", () => {
  it("round-trips an org credential", () => {
    const token = encryptSession("wsf_live_realorgcredential123");
    expect(decryptSession(token)).toBe("wsf_live_realorgcredential123");
  });

  it("never contains the raw credential in its encoded form", () => {
    const token = encryptSession("wsf_live_realorgcredential123");
    expect(token).not.toContain("wsf_live_realorgcredential123");
  });

  it("THE ATTACK: a tampered cookie fails to decrypt rather than returning wrong data", () => {
    const token = encryptSession("wsf_live_realorgcredential123");
    const tampered = token.slice(0, -4) + (token.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(decryptSession(tampered)).toBeNull();
  });

  it("THE ATTACK: garbage input decrypts to null, not a thrown exception", () => {
    expect(decryptSession("not-a-real-token")).toBeNull();
    expect(decryptSession("")).toBeNull();
  });

  it("THE ATTACK: a cookie encrypted under a different secret does not decrypt under this one", () => {
    const token = encryptSession("wsf_live_realorgcredential123");
    process.env.WAYSAFE_DASHBOARD_SESSION_SECRET = Buffer.alloc(32, 9).toString("base64");
    expect(decryptSession(token)).toBeNull();
  });

  it("throws a clear error when the secret is missing", () => {
    delete process.env.WAYSAFE_DASHBOARD_SESSION_SECRET;
    expect(() => encryptSession("wsf_live_x")).toThrow(/WAYSAFE_DASHBOARD_SESSION_SECRET/);
  });

  it("throws a clear error when the secret isn't 32 bytes", () => {
    process.env.WAYSAFE_DASHBOARD_SESSION_SECRET = Buffer.alloc(16, 1).toString("base64");
    expect(() => encryptSession("wsf_live_x")).toThrow(/32 bytes/);
  });
});
