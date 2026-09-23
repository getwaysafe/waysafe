/**
 * `EnvSigner` -- the only production `Signer` implementation today (D-63).
 *
 * Reads the same base64/hex private key from the same environment variable
 * this codebase always has, decodes it once at construction, and holds the
 * decoded key in a `#private` class field. That last part is the entire
 * point of this file: the key material is now reachable only from inside
 * the class, so a KMS-backed `Signer` is a new class plus config rather
 * than a rewrite of every call site.
 *
 * **This is not a security improvement on its own, and this file should not
 * be read as claiming one.** The key is still a plaintext value in an
 * environment variable, decoded into ordinary process memory, for the
 * lifetime of the process. An attacker with code execution in this process
 * (docs/THREAT-MODEL.md §2.1) reaches it exactly as easily as before --
 * `#private` is a TypeScript/JS language boundary, not a memory boundary,
 * and a heap dump does not respect it. What changed is where the boundary
 * *is in the code*, not how strong it is at runtime. §5 of the threat model
 * says the same thing in the same terms; keep the two in agreement.
 *
 * Deliberately no `privateKey()` accessor, on either class. Adding one
 * removes the only property this indirection provides.
 */

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { generateEvidenceSigningKeyPair, type Secp256k1Signer, type Signer } from "@waysafe/core";
import type { Address, Hex } from "viem";

/** Ed25519 raw public key: the trailing 32 bytes of the SPKI DER, after its
 * fixed 12-byte header. `publicKey()` returns raw bytes by contract; the
 * SPKI/base64 wire format stays the caller's business (the key directory
 * builds it with `exportPublicKeyBase64`). */
function rawEd25519PublicKey(key: KeyObject): Uint8Array {
  const spki = createPublicKey(key).export({ type: "spki", format: "der" }) as Buffer;
  return new Uint8Array(spki.subarray(spki.length - 32));
}

/** Byte-identical to `computeKeyId` in @waysafe/core -- reimplemented here
 * rather than imported only because that function takes a `KeyObject`, and
 * handing it this class's private field would defeat the encapsulation this
 * file exists for. A test asserts the two agree, so a drift is caught. */
function ed25519KeyId(key: KeyObject): string {
  const der = createPublicKey(key).export({ type: "spki", format: "der" }) as Buffer;
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/**
 * Ed25519 signer over a key held in process memory. Covers both Ed25519
 * roles: the evidence chain (§1.1) and the x402 off-chain attestation
 * (§1.2's first key). Two separate instances, never one -- see
 * `assertDistinctSigners`.
 */
export class EnvEd25519Signer implements Signer {
  readonly algorithm = "ed25519" as const;
  readonly keyId: string;

  readonly #privateKey: KeyObject;

  private constructor(privateKey: KeyObject) {
    this.#privateKey = privateKey;
    this.keyId = ed25519KeyId(privateKey);
  }

  /** `base64Pkcs8` is exactly the format `WAYSAFE_EVIDENCE_SIGNING_KEY` and
   * `WAYSAFE_X402_COSIGNER_KEY` already hold -- unchanged by D-63. */
  static fromBase64Pkcs8(base64Pkcs8: string): EnvEd25519Signer {
    return new EnvEd25519Signer(
      createPrivateKey({ key: Buffer.from(base64Pkcs8, "base64"), format: "der", type: "pkcs8" }),
    );
  }

  /** The ephemeral dev fallback the two `loadOrGenerate*` helpers have
   * always had, kept behaviorally identical: no env var means a fresh key
   * for this process only, and signatures stop verifying after a restart. */
  static ephemeral(): EnvEd25519Signer {
    return new EnvEd25519Signer(generateEvidenceSigningKeyPair().privateKey);
  }

  async sign(payload: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(sign(null, Buffer.from(payload), this.#privateKey));
  }

  async publicKey(): Promise<Uint8Array> {
    return rawEd25519PublicKey(this.#privateKey);
  }

  /** The **public** half as a `KeyObject`, for the verification helpers and
   * the published key directory, both of which are `KeyObject`-shaped and
   * predate this interface. Public keys are safe to hand out by
   * construction -- they cannot sign. There is deliberately no private
   * counterpart to this method. */
  publicKeyObject(): KeyObject {
    return createPublicKey(this.#privateKey);
  }
}

/**
 * secp256k1 signer for the Safe cosigner role (§1.2's second key) -- the
 * only one of the three with on-chain blast radius, and the only one that
 * needs an EVM address, because Safe ownership is an address.
 *
 * Carries three EVM signing operations beyond the base interface's
 * `sign()` -- see their own comment below for why collapsing them would
 * produce invalid Safe signatures rather than merely inelegant code.
 */
export class EnvSecp256k1Signer implements Secp256k1Signer {
  readonly algorithm = "secp256k1" as const;
  readonly keyId: string;

  readonly #account: PrivateKeyAccount;

  private constructor(account: PrivateKeyAccount) {
    this.#account = account;
    // Derived from the public half (the address is a hash of the public
    // key), so it is stable across processes exactly like the Ed25519
    // key_id, and never derived from the secret.
    this.keyId = createHash("sha256").update(account.address.toLowerCase()).digest("hex").slice(0, 16);
  }

  /** `privateKeyHex` is exactly the format `WAYSAFE_SAFE_COSIGNER_KEY`
   * already holds -- a 0x-prefixed 32-byte hex string. Unchanged by D-63. */
  static fromHex(privateKeyHex: string): EnvSecp256k1Signer {
    const normalized = (privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`) as Hex;
    return new EnvSecp256k1Signer(privateKeyToAccount(normalized));
  }

  async sign(payload: Uint8Array): Promise<Uint8Array> {
    const signature = await this.#account.signMessage({ message: { raw: Buffer.from(payload) as unknown as Hex } });
    return new Uint8Array(Buffer.from(signature.slice(2), "hex"));
  }

  /**
   * The three EVM signing primitives, exposed as distinct operations
   * because they genuinely are distinct (D-63 completion). `sign()` above
   * is EIP-191 `personal_sign`; a Safe owner signature over a
   * `SafeTx` is EIP-712 typed data, and broadcasting needs a signed
   * transaction envelope. Routing all three through `sign()` would produce
   * signatures that are well-formed but **invalid** -- the Safe contract
   * would reject them as coming from a non-owner, which is exactly the
   * `GS026` failure mode the bypass test exists to detect.
   *
   * Each delegates to the private account, so the key still never leaves
   * this class. A KMS-backed secp256k1 signer implements these three the
   * same way against its own API; nothing outside needs to change.
   */
  async signMessage(...args: Parameters<PrivateKeyAccount["signMessage"]>): Promise<Hex> {
    return this.#account.signMessage(...args);
  }

  async signTypedData(...args: Parameters<PrivateKeyAccount["signTypedData"]>): Promise<Hex> {
    return this.#account.signTypedData(...args);
  }

  async signTransaction(...args: Parameters<PrivateKeyAccount["signTransaction"]>): Promise<Hex> {
    return this.#account.signTransaction(...args);
  }

  /** Raw uncompressed secp256k1 public key is not what anything here needs;
   * the address is the identity that matters on-chain, and it is a pure
   * function of the public key. Returned as bytes to satisfy the interface
   * contract, and used by `assertDistinctSigners` for comparison. */
  async publicKey(): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(this.#account.address.slice(2).toLowerCase(), "hex"));
  }

  /** Narrowed to viem's `Address` rather than the interface's plain
   * `string`: this is the implementation, and every EVM caller needs the
   * narrow type. Still satisfies `Secp256k1Signer`. */
  async address(): Promise<Address> {
    return this.#account.address;
  }
}
