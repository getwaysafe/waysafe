import { describe, expect, it } from "vitest";
import {
  computeKeyId,
  exportPrivateKeyBase64,
  exportPublicKeyBase64,
  generateEvidenceSigningKeyPair,
  loadEvidenceKeyDirectory,
  loadEvidencePublicKey,
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
  // The private-key *reload* half of this round-trip moved to
  // apps/api's env-signer.test.ts with D-63: @waysafe/core no longer
  // decodes a private key at all, so the test for decoding lives where
  // the decoding does.

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

describe("computeKeyId (D-53)", () => {
  it("is deterministic: the same key produces the same key_id every time", () => {
    const { publicKey } = generateEvidenceSigningKeyPair();
    expect(computeKeyId(publicKey)).toBe(computeKeyId(publicKey));
  });

  it("is the same whether derived from the private key or its own public half", () => {
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    expect(computeKeyId(privateKey)).toBe(computeKeyId(publicKey));
  });

  it("differs between two different keypairs", () => {
    const a = generateEvidenceSigningKeyPair();
    const b = generateEvidenceSigningKeyPair();
    expect(computeKeyId(a.publicKey)).not.toBe(computeKeyId(b.publicKey));
  });

  it("survives a base64 SPKI export/reload round-trip -- a key_id computed by a fresh process matches one computed before serialization", () => {
    const { publicKey } = generateEvidenceSigningKeyPair();
    const reloaded = loadEvidencePublicKey(exportPublicKeyBase64(publicKey));
    expect(computeKeyId(reloaded)).toBe(computeKeyId(publicKey));
  });
});

describe("loadEvidenceKeyDirectory (D-53)", () => {
  it("builds a key_id -> KeyObject map that verifies a signature made under the matching entry", () => {
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    const keyId = computeKeyId(publicKey);
    const signature = signEventHash(privateKey, HASH);

    const directory = loadEvidenceKeyDirectory([
      { key_id: keyId, public_key: exportPublicKeyBase64(publicKey), valid_from: null },
    ]);

    expect(directory.size).toBe(1);
    expect(verifyEventSignature(directory.get(keyId)!, HASH, signature)).toBe(true);
  });

  it("keeps multiple keys addressable by their own key_id, so a rotated-out key is still resolvable", () => {
    const older = generateEvidenceSigningKeyPair();
    const newer = generateEvidenceSigningKeyPair();
    const olderId = computeKeyId(older.publicKey);
    const newerId = computeKeyId(newer.publicKey);

    const directory = loadEvidenceKeyDirectory([
      { key_id: olderId, public_key: exportPublicKeyBase64(older.publicKey), valid_from: null },
      { key_id: newerId, public_key: exportPublicKeyBase64(newer.publicKey), valid_from: "2026-09-17T00:00:00.000Z" },
    ]);

    const olderSignature = signEventHash(older.privateKey, HASH);
    const newerSignature = signEventHash(newer.privateKey, HASH);
    expect(verifyEventSignature(directory.get(olderId)!, HASH, olderSignature)).toBe(true);
    expect(verifyEventSignature(directory.get(newerId)!, HASH, newerSignature)).toBe(true);
    // THE ATTACK: the older signature must not verify under the newer key.
    expect(verifyEventSignature(directory.get(newerId)!, HASH, olderSignature)).toBe(false);
  });
});
