/**
 * WebAuthn ceremony orchestration: registration, and mandate authentication.
 *
 * `webauthn.ts` does the real crypto verification and has no I/O;
 * `types.ts`'s `WebauthnRepository` does the I/O and has no crypto. This is
 * where they meet: consume a single-use challenge, verify the ceremony,
 * store/advance credential state, activate the mandate only after a
 * verified signature, and record an EvidenceEvent for every attempt --
 * success or failure.
 */

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import type { AuthorizationRepository } from "../authorization/types.js";
import type { EvidenceRepository } from "../evidence/types.js";
import type { WebauthnRepository } from "./types.js";
import { policyHashToChallenge, verifyAuthentication, verifyRegistration, type WebauthnConfig } from "./webauthn.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface WebauthnServiceRepos {
  webauthn: WebauthnRepository;
  authorization: AuthorizationRepository;
  evidence: EvidenceRepository;
}

function randomChallenge(): string {
  return randomBytes(32).toString("base64url");
}

async function recordEvidence(
  repos: WebauthnServiceRepos,
  organizationId: string,
  type: string,
  subjectType: string,
  subjectId: string,
  payload: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await repos.evidence.withOrganizationLock(organizationId, () =>
    repos.evidence.appendEvent({ organizationId, type, subjectType, subjectId, payload, now }),
  );
}

// --- Registration ------------------------------------------------------------

export async function beginRegistration(
  repos: WebauthnServiceRepos,
  principalId: string,
  now: Date,
): Promise<{ challenge: string }> {
  const challenge = randomChallenge();
  await repos.webauthn.createChallenge(
    {
      principalId,
      challenge,
      purpose: "REGISTRATION",
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    },
    now,
  );
  return { challenge };
}

export type CompleteRegistrationResult =
  | { kind: "registered"; credentialId: string }
  | { kind: "rejected"; reason: string };

export interface CompleteRegistrationInput {
  organizationId: string;
  principalId: string;
  response: RegistrationResponseJSON;
  claimedChallenge: string;
  /** D-66: required to enroll an ADDITIONAL passkey on a principal that
   * already has one. Minted only by `completeReenrollmentAuthentication`,
   * i.e. only by proving control of a credential this principal already
   * has. Omitted for a first enrollment, where there is no existing
   * credential to prove control of. */
  reenrollmentGrant?: string;
}

export async function completeRegistration(
  repos: WebauthnServiceRepos,
  config: WebauthnConfig,
  input: CompleteRegistrationInput,
  now: Date,
): Promise<CompleteRegistrationResult> {
  // D-66 (fix 2), checked BEFORE the challenge is consumed so a failed
  // re-enrollment attempt doesn't burn the challenge: enrolling an
  // additional passkey is privileged. A principal with zero credentials is
  // a first enrollment and needs no grant -- there is nothing to prove
  // control of yet.
  const alreadyHasCredential = await repos.webauthn.hasCredentialForPrincipal(input.principalId);
  if (alreadyHasCredential) {
    if (!input.reenrollmentGrant) {
      const reason =
        "this principal already has a passkey; enrolling another requires a re-enrollment grant " +
        "from POST /v1/principals/:id/passkeys/verify";
      await recordEvidence(
        repos,
        input.organizationId,
        "passkey.registration_rejected",
        "principal",
        input.principalId,
        { reason },
        now,
      );
      return { kind: "rejected", reason };
    }
    const grant = await repos.webauthn.consumeChallenge(input.principalId, input.reenrollmentGrant, now);
    if (!grant || grant.purpose !== "REENROLLMENT_GRANT") {
      const reason = "re-enrollment grant not found, already used, expired, or not a grant";
      await recordEvidence(
        repos,
        input.organizationId,
        "passkey.registration_rejected",
        "principal",
        input.principalId,
        { reason },
        now,
      );
      return { kind: "rejected", reason };
    }
  }

  const consumed = await repos.webauthn.consumeChallenge(input.principalId, input.claimedChallenge, now);

  let result: CompleteRegistrationResult;
  if (!consumed) {
    result = { kind: "rejected", reason: "challenge not found, already used, or expired" };
  } else if (consumed.purpose !== "REGISTRATION") {
    // D-66 (fix 1), THE finding-2 fix. The purpose was always recorded at
    // issuance and then ignored, so an AUTHENTICATION challenge could be
    // answered with a registration response and enroll an attacker's key.
    // The STORED purpose decides; the caller's own `mode` never does
    // (non-negotiable #9 -- a control may not depend on the client telling
    // the truth about what it is doing).
    result = {
      kind: "rejected",
      reason: `challenge was issued for ${consumed.purpose}, not REGISTRATION`,
    };
  } else {
    const verification = await verifyRegistration(config, input.response, consumed.challenge);
    if (!verification.ok) {
      result = { kind: "rejected", reason: verification.reason };
    } else {
      await repos.webauthn.saveCredential(
        {
          principalId: input.principalId,
          credentialId: verification.value.credentialId,
          publicKey: verification.value.publicKey,
          counter: verification.value.counter,
          transports: [],
          rpId: config.rpId,
        },
        now,
      );
      result = { kind: "registered", credentialId: verification.value.credentialId };
    }
  }

  await recordEvidence(
    repos,
    input.organizationId,
    result.kind === "registered" ? "passkey.registered" : "passkey.registration_rejected",
    "principal",
    input.principalId,
    result.kind === "registered" ? { credential_id: result.credentialId } : { reason: result.reason },
    now,
  );

  return result;
}

// --- Mandate authentication ---------------------------------------------------

export async function beginMandateAuthentication(
  repos: WebauthnServiceRepos,
  principalId: string,
  policyHash: string,
  now: Date,
): Promise<{ challenge: string }> {
  const challenge = policyHashToChallenge(policyHash);
  await repos.webauthn.createChallenge(
    {
      principalId,
      challenge,
      purpose: "AUTHENTICATION",
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    },
    now,
  );
  return { challenge };
}

export type AuthenticateMandateResult = { kind: "activated" } | { kind: "rejected"; reason: string };

export interface AuthenticateMandateInput {
  organizationId: string;
  principalId: string;
  mandateId: string;
  mandateVersionId: string;
  /** The policy_hash being signed over. Must match what beginMandateAuthentication
   * was called with -- the challenge is derived from it (D-20), so a
   * mismatch here means no matching challenge was ever issued. */
  policyHash: string;
  response: AuthenticationResponseJSON;
  /** The real request IP of this ceremony (D-38) -- the caller (the
   * `/authenticate/verify` route handler) must pass `request.ip`, never a
   * placeholder. This is the only legitimate source for a rail's own
   * "the cardholder accepted these terms from this IP" field; synthesizing
   * it here would make Waysafe the one asserting a principal's consent
   * instead of the principal. */
  ip: string;
}

/**
 * Verifies a signature over `policyHash` and, only if it verifies,
 * activates the mandate. There is no path from a rejected or missing
 * verification to `activateMandate` being called -- see
 * `AuthorizationRepository.activateMandate`'s doc comment.
 */
export async function completeMandateAuthentication(
  repos: WebauthnServiceRepos,
  config: WebauthnConfig,
  input: AuthenticateMandateInput,
  now: Date,
): Promise<AuthenticateMandateResult> {
  const expectedChallenge = policyHashToChallenge(input.policyHash);
  const consumed = await repos.webauthn.consumeChallenge(input.principalId, expectedChallenge, now);

  let result: AuthenticateMandateResult;
  let credentialId: string | undefined;

  if (!consumed) {
    result = { kind: "rejected", reason: "challenge not found, already used, or expired" };
  } else if (consumed.purpose !== "AUTHENTICATION") {
    // D-66 (fix 1), the mirror of the registration check. Previously the
    // only thing stopping a REGISTRATION challenge being answered with an
    // authentication response was that a random registration challenge
    // cannot equal `policyHashToChallenge(policyHash)` -- an accidental
    // defense, now a deliberate one.
    result = {
      kind: "rejected",
      reason: `challenge was issued for ${consumed.purpose}, not AUTHENTICATION`,
    };
  } else {
    const credential = await repos.webauthn.getCredentialByCredentialId(input.response.id);
    if (!credential || credential.principalId !== input.principalId) {
      result = { kind: "rejected", reason: "no matching passkey credential for this principal" };
    } else {
      credentialId = credential.credentialId;
      const verification = await verifyAuthentication(config, input.response, consumed.challenge, {
        id: credential.credentialId,
        publicKey: Uint8Array.from(credential.publicKey),
        counter: credential.counter,
      });
      if (!verification.ok) {
        result = { kind: "rejected", reason: verification.reason };
      } else {
        await repos.webauthn.updateCredentialCounter(
          credential.credentialId,
          verification.value.newCounter,
          now,
        );
        await repos.authorization.activateMandate(input.mandateId, input.mandateVersionId, input.ip, now);
        result = { kind: "activated" };
      }
    }
  }

  await recordEvidence(
    repos,
    input.organizationId,
    result.kind === "activated" ? "mandate.authenticated" : "mandate.authentication_rejected",
    "mandate_version",
    input.mandateVersionId,
    result.kind === "activated" ? { credential_id: credentialId } : { reason: result.reason },
    now,
  );

  return result;
}

// --- Re-enrollment (D-66) -----------------------------------------------------

/**
 * Enrolling an ADDITIONAL passkey on a principal is a privileged act, not a
 * convenience: whoever can do it can thereafter authenticate any mandate as
 * that principal, which is the root of all delegated authority
 * (docs/THREAT-MODEL.md §2.5). The adversarial review of 387958a showed an
 * org credential alone was enough, by answering an authentication challenge
 * with a registration response.
 *
 * So re-enrollment is a two-step ceremony. First, prove control of a
 * credential this principal already has (`beginReenrollmentAuthentication`
 * + `completeReenrollmentAuthentication`); that mints a single-use,
 * short-lived grant. Second, present the grant alongside an ordinary
 * registration (`completeRegistration`). An org credential by itself cannot
 * complete step one, which is the whole point.
 *
 * The grant is bound to the principal by the row it lives in, and to the
 * authenticating credential by being embedded in the token itself -- so a
 * grant minted on principal X is unusable on principal Y, and the record
 * shows which existing key authorized the new one.
 */
const REENROLLMENT_GRANT_TTL_MS = 5 * 60 * 1000;

export async function beginReenrollmentAuthentication(
  repos: WebauthnServiceRepos,
  principalId: string,
  now: Date,
): Promise<{ challenge: string }> {
  // A random challenge, deliberately NOT policyHashToChallenge: this
  // ceremony authenticates the *principal*, not a specific policy, so there
  // is no policy hash to bind to and nothing here may activate a mandate.
  const challenge = randomChallenge();
  await repos.webauthn.createChallenge(
    {
      principalId,
      challenge,
      // AUTHENTICATION purpose, so `completeRegistration` refuses it as a
      // registration challenge (fix 1) -- and `completeMandateAuthentication`
      // cannot consume it either, since that path only ever looks up
      // policyHashToChallenge(policyHash), never a random value.
      purpose: "AUTHENTICATION",
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    },
    now,
  );
  return { challenge };
}

export type CompleteReenrollmentAuthenticationResult =
  | { kind: "granted"; grant: string; expiresAt: string }
  | { kind: "rejected"; reason: string };

export async function completeReenrollmentAuthentication(
  repos: WebauthnServiceRepos,
  config: WebauthnConfig,
  input: {
    organizationId: string;
    principalId: string;
    claimedChallenge: string;
    response: AuthenticationResponseJSON;
  },
  now: Date,
): Promise<CompleteReenrollmentAuthenticationResult> {
  const consumed = await repos.webauthn.consumeChallenge(input.principalId, input.claimedChallenge, now);

  let result: CompleteReenrollmentAuthenticationResult;
  if (!consumed) {
    result = { kind: "rejected", reason: "challenge not found, already used, or expired" };
  } else if (consumed.purpose !== "AUTHENTICATION") {
    result = { kind: "rejected", reason: `challenge was issued for ${consumed.purpose}, not AUTHENTICATION` };
  } else {
    const credential = await repos.webauthn.getCredentialByCredentialId(input.response.id);
    if (!credential || credential.principalId !== input.principalId) {
      result = { kind: "rejected", reason: "no matching passkey credential for this principal" };
    } else {
      const verification = await verifyAuthentication(config, input.response, consumed.challenge, {
        id: credential.credentialId,
        publicKey: Uint8Array.from(credential.publicKey),
        counter: credential.counter,
      });
      if (!verification.ok) {
        result = { kind: "rejected", reason: verification.reason };
      } else {
        await repos.webauthn.updateCredentialCounter(credential.credentialId, verification.value.newCounter, now);
        // The credential that authorized this enrollment is embedded in the
        // token, so the grant is bound to (principal, credential) without
        // needing a column for it.
        const grant = `${randomChallenge()}.${credential.credentialId}`;
        const expiresAt = new Date(now.getTime() + REENROLLMENT_GRANT_TTL_MS);
        await repos.webauthn.createChallenge(
          { principalId: input.principalId, challenge: grant, purpose: "REENROLLMENT_GRANT", expiresAt },
          now,
        );
        result = { kind: "granted", grant, expiresAt: expiresAt.toISOString() };
      }
    }
  }

  await recordEvidence(
    repos,
    input.organizationId,
    result.kind === "granted" ? "passkey.reenrollment_granted" : "passkey.reenrollment_rejected",
    "principal",
    input.principalId,
    result.kind === "granted" ? { credential_id: input.response.id } : { reason: result.reason },
    now,
  );

  return result;
}
