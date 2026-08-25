/**
 * Agent API key generation and hashing.
 *
 * A key is `ap_live_` + an 8-hex-char lookup prefix + a high-entropy secret
 * tail, e.g. `ap_live_7f2c9a1de8k3n...` -- matching the example in
 * `schema.prisma`'s `ApiKey.prefix` comment. Only the prefix and a SHA-256
 * hash of the full key are ever stored (`ApiKey.prefix`, `ApiKey.secretHash`);
 * the full key is generated once, returned to the caller, and never
 * persisted or logged anywhere. `extractKeyPrefix` lets a verifier compute
 * the lookup key from a presented credential without touching the database
 * first.
 */

import { createHash, randomBytes } from "node:crypto";

export const API_KEY_MARKER = "ap_live_";
const PREFIX_HEX_LENGTH = 8;
const SECRET_BYTES = 28;

export interface GeneratedAgentApiKey {
  /** Shown to the caller once. Never stored, never logged. */
  fullKey: string;
  /** Safe to store and log -- this is the non-secret lookup key. */
  prefix: string;
  /** SHA-256 hex digest of `fullKey`. What actually gets stored. */
  secretHash: string;
}

export function generateAgentApiKey(): GeneratedAgentApiKey {
  const prefixHex = randomBytes(PREFIX_HEX_LENGTH / 2).toString("hex");
  const secretTail = randomBytes(SECRET_BYTES).toString("base64url");
  const fullKey = `${API_KEY_MARKER}${prefixHex}${secretTail}`;
  const prefix = `${API_KEY_MARKER}${prefixHex}`;

  return { fullKey, prefix, secretHash: hashApiKey(fullKey) };
}

export function hashApiKey(fullKey: string): string {
  return createHash("sha256").update(fullKey).digest("hex");
}

/** Derives the lookup prefix from a presented key. Null if it can't be one. */
export function extractKeyPrefix(candidate: string): string | null {
  if (!candidate.startsWith(API_KEY_MARKER)) return null;
  const prefixLength = API_KEY_MARKER.length + PREFIX_HEX_LENGTH;
  if (candidate.length <= prefixLength) return null;
  return candidate.slice(0, prefixLength);
}
