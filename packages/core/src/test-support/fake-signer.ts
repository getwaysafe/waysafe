/**
 * A deterministic, in-memory `Signer` for tests (D-63).
 *
 * Exists so a test that merely needs *a* signer no longer has to read a
 * real key env var (or generate a throwaway keypair and thread it through
 * three constructors). Seeded, so the same seed always yields the same key,
 * the same `key_id`, and byte-identical signatures across runs and across
 * processes -- a test can assert on a signature value, not just on
 * "something was signed".
 *
 * These are **real** Ed25519 keys and **real** signatures, not stubs: a
 * test that verifies a signature produced here must genuinely pass
 * verification, because the whole point of most of these tests is that
 * verification works. "Fake" here means "the key is a fixed test value",
 * never "the crypto is faked".
 *
 * The secp256k1 counterpart lives in apps/api's own test-support: it needs
 * `viem` to derive an address, and `@waysafe/core` does not depend on viem.
 */

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import type { Signer } from "../signer.js";

/** The fixed 16-byte PKCS8 DER prefix for a raw Ed25519 private key, so a
 * 32-byte seed can be turned into a real `KeyObject` without generating
 * one (which would not be deterministic). Standard encoding, not a
 * Waysafe-specific format. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519KeyFromSeed(seed: string): KeyObject {
  const seedBytes = createHash("sha256").update(seed).digest();
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seedBytes]),
    format: "der",
    type: "pkcs8",
  });
}

/** Ed25519 raw public key bytes: the last 32 bytes of the SPKI DER, after
 * the fixed 12-byte header. Matches what `EnvSigner.publicKey()` returns,
 * so the two are interchangeable in a test. */
function rawPublicKeyBytes(privateKey: KeyObject): Uint8Array {
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  return new Uint8Array(spki.subarray(spki.length - 32));
}

function keyIdFor(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export class FakeEd25519Signer implements Signer {
  readonly algorithm = "ed25519" as const;
  readonly keyId: string;

  // Private, same as EnvSigner: nothing outside this class reaches the key.
  readonly #privateKey: KeyObject;

  constructor(seed = "waysafe-test-signer") {
    this.#privateKey = ed25519KeyFromSeed(seed);
    this.keyId = keyIdFor(this.#privateKey);
  }

  async sign(payload: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(sign(null, Buffer.from(payload), this.#privateKey));
  }

  async publicKey(): Promise<Uint8Array> {
    return rawPublicKeyBytes(this.#privateKey);
  }

  /** Test-only escape hatch for the handful of assertions that need to
   * verify against this key with the existing `KeyObject`-shaped helpers
   * (`verifyEventSignature`). Returns the **public** half only -- there is
   * deliberately no accessor for the private half, here or on EnvSigner. */
  publicKeyObject(): KeyObject {
    return createPublicKey(this.#privateKey);
  }
}
