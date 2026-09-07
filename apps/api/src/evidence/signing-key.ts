/**
 * Where the evidence-signing key actually comes from at runtime (D-26/OQ-8).
 * `@waysafe/core`'s evidence-signing.ts is pure key/sign/verify math; loading
 * from the environment, and the ephemeral-key fallback, are the I/O it
 * deliberately doesn't do.
 */

import { generateEvidenceSigningKeyPair, loadEvidenceSigningKey } from "@waysafe/core";
import type { KeyObject } from "node:crypto";

/**
 * Loads `WAYSAFE_EVIDENCE_SIGNING_KEY` if set; otherwise generates a fresh key
 * for this process only, so evidence still gets signed and the chain still
 * verifies -- same reasoning as D-15/D-16's in-memory repositories letting
 * `npm run dev` work with no database at all, rather than crashing.
 *
 * An ephemeral key means signatures only verify within this process's own
 * lifetime: a restart generates a new key, and every signature checked
 * against the old one now fails (correctly -- there's no way to tell "the
 * key rotated" from "the database was rebuilt by an attacker" without
 * keeping the old public key on file somewhere, which an ephemeral key by
 * definition doesn't). Never rely on this for anything that persists --
 * generate a real key with `npm run keygen -w @waysafe/api` and set the env
 * var.
 */
export function loadOrGenerateEvidenceSigningKey(warn?: (message: string) => void): KeyObject {
  const configured = process.env.WAYSAFE_EVIDENCE_SIGNING_KEY;
  if (configured) return loadEvidenceSigningKey(configured);

  (warn ?? console.warn)(
    "WAYSAFE_EVIDENCE_SIGNING_KEY not set -- generated an ephemeral evidence-signing key for this " +
      "process only. Signatures will not verify after a restart or from a different process. " +
      "Generate a real one with `npm run keygen -w @waysafe/api`.",
  );
  return generateEvidenceSigningKeyPair().privateKey;
}
