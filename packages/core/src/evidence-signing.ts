/**
 * Signs the evidence chain (D-26, resolves OQ-8).
 *
 * Hash-chaining (`evidence.ts`) makes the chain tamper-*evident* to anyone
 * who can recompute it -- but whoever controls the database can mutate a
 * row and recompute every hash after it, and a patient enough rewrite (every
 * event from the tamper point through the tip, all internally consistent)
 * looks identical to a real chain to `verifyEvidenceChain` alone. That's the
 * gap this module closes: each event's hash is signed with an Ed25519 key
 * that never lives in the database, so reproducing a valid signature for a
 * forged hash requires the private key, not just write access to Postgres.
 * A third party who has the public key -- published, not something they
 * have to trust us to hand them honestly -- can check a signature without
 * trusting our database at all. See `evidence.test.ts` for the chain-rewrite
 * proof that hash-chaining alone can't catch but signing does.
 *
 * Signs the hash, not the event's full content: the hash already commits to
 * every field via `computeEventHash` (SHA-256), so signing the fixed-size
 * digest is equivalent to signing the content and cheaper. Ed25519 chosen
 * over RSA/ECDSA for speed (signs and verifies every single event, not a
 * periodic batch -- see D-26) and because Node's `node:crypto` supports it
 * natively with no extra dependency.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export interface EvidenceSigningKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** For `keygen` and tests. Never call this to get "the" signing key for a
 * real deployment -- that key must be generated once and kept, not
 * regenerated per process (see apps/api/src/evidence/signing-key.ts). */
export function generateEvidenceSigningKeyPair(): EvidenceSigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
}

/** Base64 PKCS8 -- the format `WAYSAFE_EVIDENCE_SIGNING_KEY` is stored in. */
export function exportPrivateKeyBase64(privateKey: KeyObject): string {
  return (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
}

export function loadEvidenceSigningKey(base64Pkcs8: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(base64Pkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

/** Base64 SPKI -- the format published for third parties to verify against.
 * Safe to hand out; it cannot be used to sign anything. */
export function exportPublicKeyBase64(key: KeyObject): string {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

export function loadEvidencePublicKey(base64Spki: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(base64Spki, "base64"),
    format: "der",
    type: "spki",
  });
}

/**
 * A stable identifier for a public key, derived from the key's own bytes --
 * never assigned or stored anywhere, so the same key always produces the
 * same `key_id` even generated fresh in a different process (this file's
 * `generateEvidenceSigningKeyPair` in a test, or the real deployment key
 * loaded from `WAYSAFE_EVIDENCE_SIGNING_KEY`). First 16 hex characters of
 * SHA-256 over the key's SPKI DER encoding -- enough collision resistance
 * for the handful of keys a deployment's key directory (D-53) will ever
 * hold, short enough to read in a table next to a hash and a signature.
 */
export function computeKeyId(key: KeyObject): string {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/**
 * The wire shape of one entry in the published evidence-signing key
 * directory (D-53, resolves the rotation gap D-26/OQ-8 left open: a single
 * published key meant rotating it silently invalidated every historical
 * signature, because nothing recorded which key an old event was signed
 * under). `public_key` is base64 SPKI, loadable with `loadEvidencePublicKey`.
 * `valid_from` is the ISO-8601 timestamp this key started being used, or
 * `null` for a key that has been valid since the start of this deployment's
 * chain -- true of every deployment until its first real rotation.
 */
export interface EvidenceKeyDirectoryEntry {
  key_id: string;
  public_key: string;
  valid_from: string | null;
}

/** Loads a wire-format key directory into the `Map<key_id, KeyObject>` shape
 * `verifyEvidenceChain` resolves a signed event's key against. */
export function loadEvidenceKeyDirectory(entries: EvidenceKeyDirectoryEntry[]): Map<string, KeyObject> {
  return new Map(entries.map((entry) => [entry.key_id, loadEvidencePublicKey(entry.public_key)]));
}

/** `hash` is the hex digest `computeEventHash` produces. Returns base64. */
export function signEventHash(privateKey: KeyObject, hash: string): string {
  return sign(null, Buffer.from(hash, "hex"), privateKey).toString("base64");
}

/** Never throws -- a malformed signature or key fails closed (`false`),
 * the same way `decryptSession` in the dashboard treats anything that
 * doesn't check out cleanly as invalid rather than crashing the caller. */
export function verifyEventSignature(publicKey: KeyObject, hash: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(hash, "hex"), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
