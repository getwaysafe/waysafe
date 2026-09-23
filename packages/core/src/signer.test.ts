import { describe, expect, it } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import { assertDistinctSigners, type Secp256k1Signer, type Signer, type SignerSet } from "./signer.js";
import { FakeEd25519Signer } from "./test-support/fake-signer.js";
import { computeKeyId, exportPublicKeyBase64 } from "./evidence-signing.js";

/** A secp256k1 stand-in for the distinctness tests only -- those compare
 * public keys and never touch the curve. Signing/address behavior for the
 * real secp256k1 signer is tested in apps/api, where viem is available. */
function fakeSecp256k1(publicKeyByte: number, keyId: string): Secp256k1Signer {
  return {
    keyId,
    algorithm: "secp256k1",
    async sign() {
      return new Uint8Array([publicKeyByte]);
    },
    async publicKey() {
      return new Uint8Array([publicKeyByte, publicKeyByte, publicKeyByte]);
    },
    async address() {
      return `0x${publicKeyByte.toString(16).padStart(40, "0")}`;
    },
  };
}

describe("Signer contract (D-63)", () => {
  it("produces a real, verifiable signature -- the interface does not weaken the crypto", async () => {
    const signer = new FakeEd25519Signer("contract-test");
    const payload = new TextEncoder().encode("the exact bytes handed to sign()");

    const signature = await signer.sign(payload);

    // Verified with node:crypto directly, against the signer's own public
    // key -- nothing in this assertion goes back through the Signer.
    const ok = verify(null, Buffer.from(payload), signer.publicKeyObject(), Buffer.from(signature));
    expect(ok).toBe(true);
  });

  it("signs the payload exactly as given -- no hashing or framing inside sign()", async () => {
    const signer = new FakeEd25519Signer("no-framing");
    const payload = new Uint8Array([1, 2, 3, 4]);

    const viaSigner = await signer.sign(payload);
    // The same bytes signed the old way, with the raw KeyObject. If sign()
    // hashed or wrapped its input, these would differ.
    const viaRawKey = verify(null, Buffer.from(payload), signer.publicKeyObject(), Buffer.from(viaSigner));
    expect(viaRawKey).toBe(true);
  });

  it("is deterministic: the same seed yields the same keyId, public key, and signature bytes", async () => {
    const a = new FakeEd25519Signer("same-seed");
    const b = new FakeEd25519Signer("same-seed");
    const payload = new TextEncoder().encode("determinism");

    expect(a.keyId).toBe(b.keyId);
    expect(Buffer.from(await a.publicKey())).toEqual(Buffer.from(await b.publicKey()));
    expect(Buffer.from(await a.sign(payload))).toEqual(Buffer.from(await b.sign(payload)));
  });

  it("different seeds yield different keys", async () => {
    const a = new FakeEd25519Signer("seed-a");
    const b = new FakeEd25519Signer("seed-b");
    expect(a.keyId).not.toBe(b.keyId);
    expect(Buffer.from(await a.publicKey())).not.toEqual(Buffer.from(await b.publicKey()));
  });

  it("keyId matches computeKeyId's existing derivation -- evidence key_id values are unchanged", async () => {
    const signer = new FakeEd25519Signer("key-id-compat");
    // computeKeyId is what the evidence key directory (D-53) already uses.
    expect(signer.keyId).toBe(computeKeyId(signer.publicKeyObject()));
  });

  it("publicKey() returns raw bytes, not SPKI DER -- SPKI is a wire format callers wrap themselves", async () => {
    const signer = new FakeEd25519Signer("raw-bytes");
    const raw = await signer.publicKey();
    expect(raw.length).toBe(32); // Ed25519 raw public key

    // The SPKI DER the published key directory uses is strictly longer, and
    // ends with exactly these raw bytes.
    const spki = Buffer.from(exportPublicKeyBase64(signer.publicKeyObject()), "base64");
    expect(spki.length).toBeGreaterThan(raw.length);
    expect(spki.subarray(spki.length - 32)).toEqual(Buffer.from(raw));
  });

  it("exposes no way to reach the private key", () => {
    const signer = new FakeEd25519Signer("no-leak");
    // Every own and inherited enumerable/named property, plus the prototype's
    // methods -- none of them is the private key or an accessor for it.
    const names = [
      ...Object.getOwnPropertyNames(signer),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(signer)),
    ];
    expect(names).not.toContain("privateKey");
    expect(names).not.toContain("#privateKey");
    for (const name of names) {
      const value = (signer as unknown as Record<string, unknown>)[name];
      if (value && typeof value === "object" && "type" in (value as object)) {
        expect((value as { type: unknown }).type).not.toBe("private");
      }
    }
  });
});

describe("assertDistinctSigners (D-63)", () => {
  function setWith(evidence: Signer, x402Attestation: Signer, safeCosigner: Secp256k1Signer): SignerSet {
    return { evidence, x402Attestation, safeCosigner };
  }

  it("accepts three genuinely distinct signers", async () => {
    await expect(
      assertDistinctSigners(
        setWith(new FakeEd25519Signer("evidence"), new FakeEd25519Signer("x402"), fakeSecp256k1(0x11, "safe")),
      ),
    ).resolves.toBeUndefined();
  });

  it("THE MISCONFIGURATION: refuses to start when two roles share one key", async () => {
    const shared = new FakeEd25519Signer("shared-key");
    await expect(
      assertDistinctSigners(setWith(shared, shared, fakeSecp256k1(0x11, "safe"))),
    ).rejects.toThrow(/are the same key/);
  });

  it("compares public keys, not identity -- two separate objects holding the same key are still caught", async () => {
    // The realistic shape of this misconfiguration: two env vars set to the
    // same value, loaded into two different signer instances. Comparing
    // object identity, or env-var names, would miss this entirely.
    await expect(
      assertDistinctSigners(
        setWith(
          new FakeEd25519Signer("duplicated"),
          new FakeEd25519Signer("duplicated"),
          fakeSecp256k1(0x11, "safe"),
        ),
      ),
    ).rejects.toThrow(/"evidence" and "x402Attestation" are the same key/);
  });

  it("catches a duplicate in any position, not just the first pair", async () => {
    const shared = fakeSecp256k1(0x22, "dup");
    const alsoShared: Secp256k1Signer = { ...shared, keyId: "different-id" };
    await expect(
      assertDistinctSigners({
        evidence: new FakeEd25519Signer("evidence"),
        x402Attestation: alsoShared,
        safeCosigner: shared,
      }),
    ).rejects.toThrow(/"x402Attestation" and "safeCosigner" are the same key/);
  });

  it("refuses a missing signer rather than starting with two of three", async () => {
    await expect(
      assertDistinctSigners({
        evidence: new FakeEd25519Signer("evidence"),
        x402Attestation: undefined as unknown as Signer,
        safeCosigner: fakeSecp256k1(0x11, "safe"),
      }),
    ).rejects.toThrow(/missing the "x402Attestation" signer/);
  });
});
