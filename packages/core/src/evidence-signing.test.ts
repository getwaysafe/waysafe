import { describe, expect, it } from "vitest";
import {
  exportPrivateKeyBase64,
  exportPublicKeyBase64,
  generateEvidenceSigningKeyPair,
  loadEvidencePublicKey,
  loadEvidenceSigningKey,
  signEventHash,
  verifyEventSignature,
} from "./evidence-signing.js";
import { computeEventHash } from "./evidence.js";

const HASH = computeEventHash({
  organization_id: "org_test",
  sequence: 1,
  type: "test.event",
  subject_type: "test",
  subject_id: "subject_1",
  payload: { note: "hello" },
  previous_hash: null,
  created_at: "2026-08-26T00:00:00.000Z",
});

describe("signing and verifying", () => {
  it("a signature made with the private key verifies against its public key", () => {
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    const signature = signEventHash(privateKey, HASH);
    expect(verifyEventSignature(publicKey, HASH, signature)).toBe(true);
  });

  it("THE ATTACK: a signature does not verify against a different keypair's public key", () => {
    const { privateKey } = generateEvidenceSigningKeyPair();
    const { publicKey: otherPublicKey } = generateEvidenceSigningKeyPair();
    const signature = signEventHash(privateKey, HASH);
    expect(verifyEventSignature(otherPublicKey, HASH, signature)).toBe(false);
  });

  it("THE ATTACK: a signature does not verify against a different hash than the one signed", () => {
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    const signature = signEventHash(privateKey, HASH);
    const differentHash = computeEventHash({
      organization_id: "org_test",
      sequence: 1,
      type: "test.event",
      subject_type: "test",
      subject_id: "subject_1",
      payload: { note: "forged" },
      previous_hash: null,
      created_at: "2026-08-26T00:00:00.000Z",
    });
    expect(verifyEventSignature(publicKey, differentHash, signature)).toBe(false);
  });

  it("THE ATTACK: a tampered signature (single byte flipped) fails to verify", () => {
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    const signature = signEventHash(privateKey, HASH);
    const bytes = Buffer.from(signature, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(verifyEventSignature(publicKey, HASH, bytes.toString("base64"))).toBe(false);
  });

  it("THE ATTACK: garbage signature input fails closed, not with a thrown exception", () => {
    const { publicKey } = generateEvidenceSigningKeyPair();
    expect(verifyEventSignature(publicKey, HASH, "not-a-real-signature")).toBe(false);
    expect(verifyEventSignature(publicKey, HASH, "")).toBe(false);
  });
});

describe("key export/import round-trips", () => {
  it("a private key survives base64 PKCS8 export and reload, and still signs verifiably", () => {
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    const reloaded = loadEvidenceSigningKey(exportPrivateKeyBase64(privateKey));
    const signature = signEventHash(reloaded, HASH);
    expect(verifyEventSignature(publicKey, HASH, signature)).toBe(true);
  });

  it("a public key survives base64 SPKI export and reload, and still verifies", () => {
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    const signature = signEventHash(privateKey, HASH);
    const reloaded = loadEvidencePublicKey(exportPublicKeyBase64(publicKey));
    expect(verifyEventSignature(reloaded, HASH, signature)).toBe(true);
  });

  it("exportPublicKeyBase64 accepts either a private or a public KeyObject and derives the same public key", () => {
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    expect(exportPublicKeyBase64(privateKey)).toBe(exportPublicKeyBase64(publicKey));
  });
});
