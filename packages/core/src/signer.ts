/**
 * The signing boundary (D-63).
 *
 * Before this interface existed, every signing call in this codebase took a
 * raw `KeyObject` or a private-key hex string directly, which meant "produce
 * a signature" and "the private key is in this process" were the same
 * statement -- there was no seam where one could be true and the other not.
 * This file is that seam, and nothing more: it is deliberately an interface
 * plus nothing, with no implementation, no key loading, and no `node:crypto`
 * import at all, so it stays a pure type that costs a browser bundle nothing
 * and can be implemented by a KMS client, an HSM client, or (today, the only
 * one that exists) a class holding a key in process memory.
 *
 * **This interface is not a security improvement on its own.** Today's only
 * production implementation (`EnvSigner`, apps/api) still reads a base64
 * private key from an environment variable into ordinary process memory --
 * exactly as before. What changed is that the key material is now reachable
 * only from inside that one class, so a KMS-backed implementation is a new
 * class plus config rather than a rewrite of every call site. See
 * docs/THREAT-MODEL.md §5, which states the same thing in the same terms.
 *
 * The deliberate omission: there is no way to get the private key back out
 * of a `Signer`. Any future implementation that adds one has removed the
 * only property this interface exists to provide.
 */

/** Algorithms this codebase actually signs with. Ed25519 covers the
 * evidence chain and the x402 off-chain attestation; secp256k1 covers the
 * Safe cosigner, which must be an EVM account to be a Safe owner at all. */
export type SignerAlgorithm = "ed25519" | "secp256k1";

export interface Signer {
  /**
   * A stable identifier derived from the public key's own bytes, never
   * assigned or stored. Matches `computeKeyId`'s existing derivation for
   * Ed25519 keys, so evidence events keep the exact `key_id` values they
   * already carry -- see `computeKeyId` in evidence-signing.ts.
   */
  readonly keyId: string;
  readonly algorithm: SignerAlgorithm;

  /** Raw signature bytes over `payload` exactly as given -- no hashing,
   * no framing, no encoding. Callers that sign a digest hash it first and
   * pass the digest bytes; callers that encode (base64, hex) do so on the
   * way out. Async because a real KMS is a network call; today's
   * in-process implementations resolve immediately. */
  sign(payload: Uint8Array): Promise<Uint8Array>;

  /** Raw public key bytes -- not SPKI DER, not base64. Callers that need a
   * wire format wrap this themselves, so this interface stays the same
   * shape for a key whose public half comes back from a KMS API. */
  publicKey(): Promise<Uint8Array>;
}

/**
 * A `Signer` whose key is an EVM account. Kept off the base interface
 * deliberately: Safe ownership is an on-chain fact about an address, so
 * only the secp256k1 signer has one, and an Ed25519 signer must not appear
 * to. (This is the same distinction docs/THREAT-MODEL.md §1.2 draws between
 * the two x402 keys: the Ed25519 attestation key "has no EVM address at
 * all", which is precisely why it cannot move funds.)
 */
export interface Secp256k1Signer extends Signer {
  readonly algorithm: "secp256k1";
  /** The checksummed `0x`-prefixed EVM address this signer owns. */
  address(): Promise<string>;
}

/**
 * The three signers a deployment needs, matching the three keys inventoried
 * in docs/THREAT-MODEL.md §1. They are never one object reused: each key has
 * a different blast radius, and collapsing any two into one would silently
 * widen it (the Ed25519 attestation key gaining the Safe key's on-chain
 * power, say). `assertDistinctSigners` enforces that at boot.
 */
export interface SignerSet {
  /** §1.1 -- signs every evidence event's hash. */
  evidence: Signer;
  /** §1.2, first key -- signs the off-chain x402 decision attestation.
   * Ed25519, no EVM address, cannot move funds. */
  x402Attestation: Signer;
  /** §1.2, second key -- a real owner of every mandate's 2-of-2 Safe.
   * The only one of the three with on-chain blast radius. */
  safeCosigner: Secp256k1Signer;
}

/**
 * Refuses to start unless all three signers are present and genuinely
 * distinct. Compares **public keys**, not env-var strings: two env vars
 * holding the same key under different names is exactly the
 * misconfiguration this catches, and comparing the strings would miss it
 * (different encodings of one key) while also being unable to compare a
 * future KMS signer that has no env-var string to compare at all.
 *
 * Throws rather than warning. A deployment that has accidentally pointed
 * two roles at one key has a smaller key separation than its own threat
 * model claims, and starting anyway would make that silently untrue.
 */
export async function assertDistinctSigners(signers: SignerSet): Promise<void> {
  const roles: [string, Signer][] = [
    ["evidence", signers.evidence],
    ["x402Attestation", signers.x402Attestation],
    ["safeCosigner", signers.safeCosigner],
  ];

  for (const [role, signer] of roles) {
    if (!signer) throw new Error(`signer set is missing the "${role}" signer`);
  }

  const publicKeys = await Promise.all(
    roles.map(async ([role, signer]) => [role, Buffer.from(await signer.publicKey()).toString("base64")] as const),
  );

  for (let i = 0; i < publicKeys.length; i += 1) {
    for (let j = i + 1; j < publicKeys.length; j += 1) {
      const [roleA, keyA] = publicKeys[i]!;
      const [roleB, keyB] = publicKeys[j]!;
      if (keyA === keyB) {
        throw new Error(
          `signers "${roleA}" and "${roleB}" are the same key -- each role must have its own key ` +
            `(see docs/THREAT-MODEL.md §1: the three keys have different blast radii and are never interchangeable)`,
        );
      }
    }
  }
}
