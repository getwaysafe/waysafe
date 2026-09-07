/**
 * Dashboard auth (OQ-4 / D-23): a session cookie wrapping the org
 * credential, not a separate identity system. There is no dashboard user
 * database -- the org credential already *is* the tenant's identity (D-18),
 * so the session's only job is to carry it from request to request without
 * putting it in the browser in the clear. AES-256-GCM, not a JWT: there is
 * exactly one claim (the credential itself), so a signed-and-encrypted blob
 * needs no separate claims schema, expiry field, or library.
 *
 * `WAYSAFE_DASHBOARD_SESSION_SECRET` must be a base64-encoded 32-byte key.
 * Generate one with:
 *
 *   openssl rand -base64 32
 *
 * A real IdP (Clerk, WorkOS, Auth.js) is a Week 6+ decision -- see D-23.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "waysafe_dashboard_session";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function loadKey(): Buffer {
  const encoded = process.env.WAYSAFE_DASHBOARD_SESSION_SECRET;
  if (!encoded) {
    throw new Error(
      "WAYSAFE_DASHBOARD_SESSION_SECRET is not set. Generate one with " +
        "`openssl rand -base64 32` and set it in the dashboard's environment.",
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error(
      `WAYSAFE_DASHBOARD_SESSION_SECRET must decode to 32 bytes (got ${key.length}). ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }
  return key;
}

/** Encrypts an org credential into an opaque cookie value. Never log or
 * display the result -- it round-trips back to the raw credential. */
export function encryptSession(apiKey: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64url");
}

/**
 * Reverses `encryptSession`. Returns `null` for anything that doesn't
 * decrypt cleanly -- a tampered cookie, one encrypted under a rotated
 * secret, or garbage -- rather than throwing, because this runs on every
 * authenticated page load and a malformed cookie should look like "not
 * logged in," not crash the request.
 */
export function decryptSession(token: string): string | null {
  try {
    const key = loadKey();
    const raw = Buffer.from(token, "base64url");
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
    const ciphertext = raw.subarray(IV_LENGTH + 16);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}
