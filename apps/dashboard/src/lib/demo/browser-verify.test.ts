/**
 * Proves the browser-side (WebCrypto) reimplementation agrees with
 * `@waysafe/core`'s own Node-side hashing and signing -- if the two ever
 * drifted, every real chain would fail to verify in the demo's own
 * browser scene. Built directly from `@waysafe/core`'s exported primitives
 * (`computeEventHash`, `signEventHash`, `exportPublicKeyBase64`) rather than
 * a whole `EvidenceRepository`, so this test has no dependency on
 * `@waysafe/api`.
 */

import { describe, expect, it } from "vitest";
import {
  computeEventHash,
  exportPublicKeyBase64,
  generateEvidenceSigningKeyPair,
  signEventHash,
} from "@waysafe/core";
import { verifyEvidenceChainInBrowser, type BrowserEvidenceEvent } from "./browser-verify";

function buildChain(): { events: BrowserEvidenceEvent[]; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateEvidenceSigningKeyPair();

  function sign(content: {
    organization_id: string;
    sequence: number;
    type: string;
    subject_type: string;
    subject_id: string;
    payload: Record<string, unknown>;
    previous_hash: string | null;
    created_at: string;
  }): BrowserEvidenceEvent {
    const hash = computeEventHash(content);
    return { ...content, hash, signature: signEventHash(privateKey, hash) };
  }

  const event1 = sign({
    organization_id: "org_demo",
    sequence: 0,
    type: "mandate.authenticated",
    subject_type: "mandate_version",
    subject_id: "mdtv_1",
    payload: { credential_id: "cred_1" },
    previous_hash: null,
    created_at: "2026-09-10T00:00:00.000Z",
  });
  const event2 = sign({
    organization_id: "org_demo",
    sequence: 1,
    type: "enforcement.x402.decision",
    subject_type: "authorization",
    subject_id: "auth_1",
    payload: { decision: "ALLOW", amount: 50 },
    previous_hash: event1.hash,
    created_at: "2026-09-10T00:01:00.000Z",
  });

  return { events: [event1, event2], publicKeyBase64: exportPublicKeyBase64(publicKey) };
}

describe("verifyEvidenceChainInBrowser (D-42)", () => {
  it("verifies a genuine chain signed by @waysafe/core's own Node-side signing", async () => {
    const { events, publicKeyBase64 } = buildChain();
    const result = await verifyEvidenceChainInBrowser(events, publicKeyBase64);
    expect(result).toEqual({ ok: true, signed: true });
  });

  it("fails closed when a single byte of a payload is flipped after signing", async () => {
    const { events, publicKeyBase64 } = buildChain();
    const tampered = events.map((e, i) =>
      i === 1 ? { ...e, payload: { ...e.payload, amount: 999999 } } : e,
    );
    const result = await verifyEvidenceChainInBrowser(tampered, publicKeyBase64);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
    expect(result.brokenAtSequence).toBe(1);
  });

  it("fails closed when checked against the wrong public key", async () => {
    const { events } = buildChain();
    const { publicKey: wrongKey } = generateEvidenceSigningKeyPair();
    const { exportPublicKeyBase64: exportKey } = await import("@waysafe/core");
    const result = await verifyEvidenceChainInBrowser(events, exportKey(wrongKey));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("detects a broken hash chain (previous_hash tampering)", async () => {
    const { events, publicKeyBase64 } = buildChain();
    const tampered = events.map((e, i) => (i === 1 ? { ...e, previous_hash: "0".repeat(64) } : e));
    const result = await verifyEvidenceChainInBrowser(tampered, publicKeyBase64);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("previous_hash_mismatch");
  });

  it("passes trivially on an empty chain", async () => {
    const { publicKeyBase64 } = buildChain();
    const result = await verifyEvidenceChainInBrowser([], publicKeyBase64);
    expect(result).toEqual({ ok: true, signed: true });
  });
});
