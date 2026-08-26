/**
 * Thin wrapper around the real `@simplewebauthn/server` verification calls.
 *
 * D-20: an *authentication* ceremony's challenge is exactly
 * `base64url(policyHash)`, not a random server nonce -- the caller is
 * responsible for constructing that challenge and handing it in here as
 * `expectedChallenge`. A verified signature therefore proves the principal
 * signed *that* mandate version specifically, not merely "authenticated
 * recently."
 *
 * `verifyRegistrationResponse`/`verifyAuthenticationResponse` throw on most
 * malformed or mismatched input (wrong challenge, wrong origin, a
 * non-increasing signature counter) and only return `verified: false` for
 * an actual signature mismatch. Both collapse to the same outcome here:
 * `ok: false`. Nothing upstream needs to distinguish "threw" from
 * "returned false" -- either way, the ceremony did not verify.
 */

import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

export interface WebauthnConfig {
  rpId: string;
  origin: string;
}

/**
 * D-20: the authentication challenge for a mandate version's signature
 * ceremony is `policyHash`'s UTF-8 bytes, base64url-encoded -- not a random
 * server nonce. Encoding the hash itself as the challenge is what makes a
 * verified signature prove the principal signed *this* policy specifically,
 * not merely "authenticated recently."
 */
export function policyHashToChallenge(policyHash: string): string {
  return Buffer.from(policyHash, "utf8").toString("base64url");
}

export type VerifyOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
}

export async function verifyRegistration(
  config: WebauthnConfig,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifyOutcome<VerifiedRegistration>> {
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
    });
    if (!result.verified) return { ok: false, reason: "attestation signature did not verify" };
    return {
      ok: true,
      value: {
        credentialId: result.registrationInfo.credential.id,
        publicKey: result.registrationInfo.credential.publicKey,
        counter: result.registrationInfo.credential.counter,
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface VerifiedAuthentication {
  newCounter: number;
}

export async function verifyAuthentication(
  config: WebauthnConfig,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: WebAuthnCredential,
): Promise<VerifyOutcome<VerifiedAuthentication>> {
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      credential,
    });
    if (!result.verified) return { ok: false, reason: "assertion signature did not verify" };
    return { ok: true, value: { newCounter: result.authenticationInfo.newCounter } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
