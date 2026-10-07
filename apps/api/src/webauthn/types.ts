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

/**
 * What a stored challenge may be redeemed for -- D-86.
 *
 * One purpose per operation, deliberately. `AUTHENTICATION` used to cover
 * two: activating a mandate and authorizing an additional passkey. Both
 * completion paths accepted it, so a signature the principal produced to
 * confirm a policy could be redeemed at the passkey route to mint an
 * enrolment grant -- the second independent review did exactly that, through
 * HTTP and Postgres. It is retained only because rows may still reference
 * it, and neither completion path accepts it any more.
 */
export type ChallengePurpose =
  | "REGISTRATION"
  | "AUTHENTICATION"
  | "MANDATE_AUTHENTICATION"
  | "REENROLLMENT_AUTHENTICATION"
  | "REENROLLMENT_GRANT";

export interface NewChallenge {
  principalId: string;
  /** base64url. For MANDATE_AUTHENTICATION this is base64url(policyHash)
   * (D-20); for REENROLLMENT_AUTHENTICATION it is random, bound to no
   * policy (D-86). */
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

  /** Reads a live challenge WITHOUT consuming it (D-66), so the route layer
   * can tell a client its `mode` disagrees with the challenge's stored
   * purpose and return a specific 400 -- rather than burning the challenge
   * on a request that was never going to succeed. Never used to authorize
   * anything: the authoritative purpose check happens inside the service,
   * against the challenge it actually consumes. */
  peekChallenge(principalId: string, challenge: string, now: Date): Promise<StoredChallenge | null>;

  saveCredential(input: NewPasskeyCredential, now: Date): Promise<StoredPasskeyCredential>;

  getCredentialByCredentialId(credentialId: string): Promise<StoredPasskeyCredential | null>;

  updateCredentialCounter(credentialId: string, counter: number, now: Date): Promise<void>;

  /** For the authenticate/options endpoint: register a first passkey, or
   * sign with one already registered? */
  hasCredentialForPrincipal(principalId: string): Promise<boolean>;
}
