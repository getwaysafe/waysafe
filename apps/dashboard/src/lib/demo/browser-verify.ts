/**
 * D-42: independent evidence-chain verification, run in the viewer's own
 * browser tab -- the "verify it yourself" scene's whole point.
 *
 * `@waysafe/sdk`'s `verifyEvidenceIndependently` (and the `@waysafe/core`
 * functions it wraps, `evidence.ts`/`evidence-signing.ts`) call
 * `node:crypto` directly and cannot run in a browser bundle. This is a
 * deliberate, from-scratch reimplementation of the identical algorithm
 * using the Web Crypto API (`crypto.subtle`), which every modern browser
 * ships natively -- not a shortcut, and not weaker: SHA-256 and Ed25519 are
 * the same standards either way, Node's Ed25519 signatures (RFC 8032,
 * "PureEdDSA") verify against WebCrypto's Ed25519 implementation with no
 * conversion, and the canonicalization (`sortKeysDeep` + `JSON.stringify`)
 * is copied field-for-field from `packages/core/src/evidence.ts`'s
 * `computeEventHash`. Any drift between the two would make every real
 * event fail to verify here -- see this file's own test for the proof that
 * it doesn't.
 */

export interface BrowserEvidenceEvent {
  organization_id: string;
  sequence: number;
  type: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  previous_hash: string | null;
  hash: string;
  signature: string;
  created_at: string;
}

export interface BrowserChainVerificationResult {
  ok: boolean;
  brokenAtSequence?: number;
  reason?: "hash_mismatch" | "previous_hash_mismatch" | "sequence_gap" | "signature_invalid";
  signed?: boolean;
}

/** Identical to `packages/core/src/evidence.ts`'s private helper of the
 * same name -- copied, not imported, since that module is not meant to run
 * outside Node (see this file's own header comment). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Node's DOM lib types `new Uint8Array(n)` as `Uint8Array<ArrayBufferLike>`,
 * which `crypto.subtle`'s `BufferSource` overloads reject -- copying through
 * `Uint8Array.from` guarantees a plain, non-shared `ArrayBuffer`-backed
 * array, the same fix `virtual-authenticator.ts`'s own `freshBytes` helper
 * uses for the identical TS lib quirk. */
function freshBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(input);
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return freshBytes(out);
}

/** Standard base64 (not base64url) -- Node's `.toString("base64")` and
 * `.export({format: "der"})` both use it, matching `exportPublicKeyBase64`
 * and `signEventHash` exactly. */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return freshBytes(out);
}

async function computeEventHash(content: {
  organization_id: string;
  sequence: number;
  type: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  previous_hash: string | null;
  created_at: string;
}): Promise<string> {
  const canonical = JSON.stringify(sortKeysDeep(content));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToHex(digest);
}

/** `base64Spki` is exactly what `GET /v1/evidence/public-key` publishes --
 * base64 DER, SPKI-encoded. */
async function importEd25519PublicKey(base64Spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", base64ToBytes(base64Spki), { name: "Ed25519" }, true, ["verify"]);
}

async function verifySignature(publicKey: CryptoKey, hashHex: string, signatureBase64: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, base64ToBytes(signatureBase64), hexToBytes(hashHex));
  } catch {
    return false;
  }
}

/**
 * Recomputes and checks the chain exactly as `@waysafe/core`'s
 * `verifyEvidenceChain` does -- see that file's doc comment for what
 * hash-chaining alone proves versus what checking the signature adds.
 * `events` must already be in ascending sequence order.
 */
export async function verifyEvidenceChainInBrowser(
  events: BrowserEvidenceEvent[],
  publicKeyBase64Spki: string,
): Promise<BrowserChainVerificationResult> {
  const publicKey = await importEd25519PublicKey(publicKeyBase64Spki);

  const [head] = events;
  let previousHash: string | null = head ? head.previous_hash : null;
  let expectedSequence = head ? head.sequence : 0;

  for (const event of events) {
    if (event.sequence !== expectedSequence) {
      return { ok: false, brokenAtSequence: event.sequence, reason: "sequence_gap" };
    }
    if (event.previous_hash !== previousHash) {
      return { ok: false, brokenAtSequence: event.sequence, reason: "previous_hash_mismatch" };
    }

    const expectedHash = await computeEventHash({
      organization_id: event.organization_id,
      sequence: event.sequence,
      type: event.type,
      subject_type: event.subject_type,
      subject_id: event.subject_id,
      payload: event.payload,
      previous_hash: event.previous_hash,
      created_at: event.created_at,
    });
    if (expectedHash !== event.hash) {
      return { ok: false, brokenAtSequence: event.sequence, reason: "hash_mismatch" };
    }

    if (!(await verifySignature(publicKey, event.hash, event.signature))) {
      return { ok: false, brokenAtSequence: event.sequence, reason: "signature_invalid" };
    }

    previousHash = event.hash;
    expectedSequence += 1;
  }

  return { ok: true, signed: true };
}
