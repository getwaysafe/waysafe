/**
 * Persistence boundary for passkey credentials and WebAuthn challenges.
 *
 * `webauthn.ts` is the crypto verification (real `@simplewebauthn/server`,
 * no I/O); this interface is the I/O it doesn't do. Challenge single-use is
 * enforced by `consumeChallenge` being one atomic conditional update --
 * "mark consumed WHERE not already consumed and not expired" -- never a
 * separate check-then-write, so two concurrent attempts to redeem the same
 * challenge can't both succeed.
 */

export type ChallengePurpose = "REGISTRATION" | "AUTHENTICATION";

export interface NewChallenge {
  principalId: string;
  /** base64url. For AUTHENTICATION, this is base64url(policyHash) -- see D-20. */
  challenge: string;
  purpose: ChallengePurpose;
  expiresAt: Date;
}

export interface StoredChallenge {
  id: string;
  principalId: string;
  challenge: string;
  purpose: ChallengePurpose;
  expiresAt: Date;
}

export interface NewPasskeyCredential {
  principalId: string;
  /** base64url. */
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  rpId: string;
}

export interface StoredPasskeyCredential {
  id: string;
  principalId: string;
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  rpId: string;
}

export interface WebauthnRepository {
  createChallenge(input: NewChallenge, now: Date): Promise<StoredChallenge>;

  /**
   * Atomically finds a non-expired, not-yet-consumed challenge for this
   * principal matching `challenge`, marks it consumed, and returns it -- or
   * null if no such challenge exists. A challenge that has already been
   * consumed (replay) or has expired returns null exactly like one that
   * never existed; the caller doesn't get to distinguish "reused" from
   * "never happened" from the return value alone (deliberately -- nothing
   * about *why* a challenge failed should be observable beyond that).
   */
  consumeChallenge(principalId: string, challenge: string, now: Date): Promise<StoredChallenge | null>;

  saveCredential(input: NewPasskeyCredential, now: Date): Promise<StoredPasskeyCredential>;

  getCredentialByCredentialId(credentialId: string): Promise<StoredPasskeyCredential | null>;

  updateCredentialCounter(credentialId: string, counter: number, now: Date): Promise<void>;

  /** For the authenticate/options endpoint: register a first passkey, or
   * sign with one already registered? */
  hasCredentialForPrincipal(principalId: string): Promise<boolean>;
}
