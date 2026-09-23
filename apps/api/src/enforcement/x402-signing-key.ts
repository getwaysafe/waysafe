/**
 * Where the x402 co-signer key comes from at runtime (D-40).
 *
 * Deliberately its own key, not a reuse of the evidence chain's signing key
 * (`apps/api/src/evidence/signing-key.ts`) even though both are Ed25519 and
 * both use `@waysafe/core`'s evidence-signing.ts primitives. The evidence
 * key attests "this is really what got written to the chain"; this key is
 * meant, per the custody comment in `x402.ts`, to eventually be one slot of
 * a 2-of-2 smart account's owner set on-chain -- a key with a real
 * counterpart registered outside this codebase. Conflating the two would
 * mean rotating one silently rotates the other's on-chain registration,
 * and would blur two genuinely different trust boundaries into one key.
 * Mirrors signing-key.ts's shape exactly otherwise, including the
 * ephemeral-key dev fallback.
 */

import { EnvEd25519Signer } from "../signing/env-signer.js";

/**
 * Loads `WAYSAFE_X402_COSIGNER_KEY` if set; otherwise generates a fresh key
 * for this process only. An ephemeral key here has the same consequence
 * signing-key.ts's fallback documents: co-signatures only verify within
 * this process's own lifetime. Never rely on this for anything that
 * persists, or -- once a real 2-of-2 account design lands -- for anything
 * registered on-chain as this key's counterpart.
 */
export function loadOrGenerateX402SigningKey(warn?: (message: string) => void): EnvEd25519Signer {
  const configured = process.env.WAYSAFE_X402_COSIGNER_KEY;
  if (configured) return EnvEd25519Signer.fromBase64Pkcs8(configured);

  (warn ?? console.warn)(
    "WAYSAFE_X402_COSIGNER_KEY not set -- generated an ephemeral x402 co-signer key for this " +
      "process only. Co-signatures will not verify after a restart or from a different process, " +
      "and this key has no real on-chain counterpart yet (D-40's custody tension). Generate a real " +
      "one with `npm run keygen -w @waysafe/api`.",
  );
  return EnvEd25519Signer.ephemeral();
}
