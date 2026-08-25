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
}

export async function completeRegistration(
  repos: WebauthnServiceRepos,
  config: WebauthnConfig,
  input: CompleteRegistrationInput,
  now: Date,
): Promise<CompleteRegistrationResult> {
  const consumed = await repos.webauthn.consumeChallenge(input.principalId, input.claimedChallenge, now);

  let result: CompleteRegistrationResult;
  if (!consumed) {
    result = { kind: "rejected", reason: "challenge not found, already used, or expired" };
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
        await repos.authorization.activateMandate(input.mandateId, input.mandateVersionId, now);
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
