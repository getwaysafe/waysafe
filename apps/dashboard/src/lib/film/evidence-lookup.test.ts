import { describe, expect, it } from "vitest";
import { findEvidenceEventForAuthorization, formatPolicyHash, truncateHash } from "./evidence-lookup";
import type { BrowserEvidenceEvent } from "../demo/browser-verify";

function event(overrides: Partial<BrowserEvidenceEvent>): BrowserEvidenceEvent {
  return {
    organization_id: "org_1",
    sequence: 0,
    type: "enforcement.stripe_issuing.decision",
    subject_type: "authorization",
    subject_id: "auth_1",
    payload: {},
    previous_hash: null,
    hash: "abcd1234",
    signature: "sig",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("findEvidenceEventForAuthorization (D-45)", () => {
  it("finds the event whose subject_type/subject_id match the authorization", () => {
    const events = [event({ subject_id: "auth_1", sequence: 0 }), event({ subject_id: "auth_2", sequence: 1 })];
    expect(findEvidenceEventForAuthorization(events, "auth_2")?.sequence).toBe(1);
  });

  it("ignores events of a different subject_type with a matching id", () => {
    const events = [event({ subject_type: "mandate_version", subject_id: "auth_1" })];
    expect(findEvidenceEventForAuthorization(events, "auth_1")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    const events = [event({ subject_id: "auth_1" })];
    expect(findEvidenceEventForAuthorization(events, "auth_missing")).toBeNull();
  });
});

describe("truncateHash / formatPolicyHash", () => {
  it("truncates a long hex string to lead…trail", () => {
    expect(truncateHash("7c1e9a2b3c4d5e6fa94f")).toBe("7c1e…a94f");
  });

  it("leaves a short string untouched", () => {
    expect(truncateHash("abcd")).toBe("abcd");
  });

  it("formats a policy hash with the sha256: prefix", () => {
    expect(formatPolicyHash("7c1e9a2b3c4d5e6fa94f")).toBe("sha256:7c1e…a94f");
  });
});
