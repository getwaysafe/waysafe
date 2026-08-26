/** In-process fake `WebauthnRepository`. */

import { ID_PREFIX, generateId } from "@agentpay/core";
import type {
  NewChallenge,
  NewPasskeyCredential,
  StoredChallenge,
  StoredPasskeyCredential,
  WebauthnRepository,
} from "./types.js";

interface ChallengeRow extends StoredChallenge {
  consumedAt: Date | null;
}

export class InMemoryWebauthnRepository implements WebauthnRepository {
  private readonly challenges = new Map<string, ChallengeRow>();
  private readonly credentialsById = new Map<string, StoredPasskeyCredential>();

  async createChallenge(input: NewChallenge, now: Date): Promise<StoredChallenge> {
    const id = generateId(ID_PREFIX.webauthn_challenge);
    const row: ChallengeRow = {
      id,
      principalId: input.principalId,
      challenge: input.challenge,
      purpose: input.purpose,
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    this.challenges.set(id, row);
    return row;
  }

  async consumeChallenge(
    principalId: string,
    challenge: string,
    now: Date,
  ): Promise<StoredChallenge | null> {
    // Single pass over the map, synchronous with no await before the write --
    // matches InMemoryAuthorizationRepository's idempotency-claim pattern
    // for the same reason: nothing can interleave between the find and the
    // mark-consumed.
    for (const row of this.challenges.values()) {
      if (row.principalId !== principalId) continue;
      if (row.challenge !== challenge) continue;
      if (row.consumedAt) continue;
      if (row.expiresAt.getTime() <= now.getTime()) continue;
      row.consumedAt = now;
      return { id: row.id, principalId: row.principalId, challenge: row.challenge, purpose: row.purpose, expiresAt: row.expiresAt };
    }
    return null;
  }

  async saveCredential(input: NewPasskeyCredential, now: Date): Promise<StoredPasskeyCredential> {
    const id = generateId(ID_PREFIX.passkey_credential);
    const row: StoredPasskeyCredential = {
      id,
      principalId: input.principalId,
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
      transports: input.transports,
      rpId: input.rpId,
    };
    this.credentialsById.set(input.credentialId, row);
    return row;
  }

  async getCredentialByCredentialId(credentialId: string): Promise<StoredPasskeyCredential | null> {
    return this.credentialsById.get(credentialId) ?? null;
  }

  async updateCredentialCounter(credentialId: string, counter: number, now: Date): Promise<void> {
    const row = this.credentialsById.get(credentialId);
    if (row) row.counter = counter;
  }

  async hasCredentialForPrincipal(principalId: string): Promise<boolean> {
    for (const row of this.credentialsById.values()) {
      if (row.principalId === principalId) return true;
    }
    return false;
  }
}
