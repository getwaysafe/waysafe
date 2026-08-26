/**
 * Real `WebauthnRepository`, backed by Postgres via Prisma.
 *
 * `consumeChallenge` is a single conditional `updateMany` --
 * `WHERE id = ... AND consumedAt IS NULL AND expiresAt > now` -- so
 * single-use is a property of one atomic statement, not a race between a
 * read and a write. No row lock needed (contrast D-4/D-16): there's nothing
 * cumulative being raced, just one row's own consumed/not-consumed state,
 * which the conditional UPDATE already makes atomic.
 */

import { PrismaClient } from "@prisma/client";
import { ID_PREFIX, generateId } from "@agentpay/core";
import type {
  NewChallenge,
  NewPasskeyCredential,
  StoredChallenge,
  StoredPasskeyCredential,
  WebauthnRepository,
} from "./types.js";

export class PrismaWebauthnRepository implements WebauthnRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createChallenge(input: NewChallenge, now: Date): Promise<StoredChallenge> {
    const id = generateId(ID_PREFIX.webauthn_challenge);
    const created = await this.prisma.webauthnChallenge.create({
      data: {
        id,
        principalId: input.principalId,
        challenge: input.challenge,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        createdAt: now,
      },
    });
    return toStoredChallenge(created);
  }

  async consumeChallenge(
    principalId: string,
    challenge: string,
    now: Date,
  ): Promise<StoredChallenge | null> {
    const result = await this.prisma.webauthnChallenge.updateMany({
      where: { principalId, challenge, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (result.count === 0) return null;

    // updateMany doesn't return rows; re-fetch the one we just (uniquely)
    // consumed. A benign extra read -- the atomicity that matters already
    // happened in the updateMany above.
    const row = await this.prisma.webauthnChallenge.findFirst({
      where: { principalId, challenge, consumedAt: now },
    });
    return row ? toStoredChallenge(row) : null;
  }

  async saveCredential(input: NewPasskeyCredential, now: Date): Promise<StoredPasskeyCredential> {
    const id = generateId(ID_PREFIX.passkey_credential);
    const created = await this.prisma.passkeyCredential.create({
      data: {
        id,
        principalId: input.principalId,
        credentialId: input.credentialId,
        publicKey: Buffer.from(input.publicKey),
        counter: BigInt(input.counter),
        transports: input.transports,
        rpId: input.rpId,
        createdAt: now,
      },
    });
    return toStoredCredential(created);
  }

  async getCredentialByCredentialId(credentialId: string): Promise<StoredPasskeyCredential | null> {
    const row = await this.prisma.passkeyCredential.findUnique({ where: { credentialId } });
    return row ? toStoredCredential(row) : null;
  }

  async updateCredentialCounter(credentialId: string, counter: number, now: Date): Promise<void> {
    await this.prisma.passkeyCredential.updateMany({
      where: { credentialId },
      data: { counter: BigInt(counter), lastUsedAt: now },
    });
  }

  async hasCredentialForPrincipal(principalId: string): Promise<boolean> {
    const count = await this.prisma.passkeyCredential.count({ where: { principalId } });
    return count > 0;
  }
}

interface ChallengeRow {
  id: string;
  principalId: string;
  challenge: string;
  purpose: string;
  expiresAt: Date;
}

function toStoredChallenge(row: ChallengeRow): StoredChallenge {
  return {
    id: row.id,
    principalId: row.principalId,
    challenge: row.challenge,
    purpose: row.purpose as StoredChallenge["purpose"],
    expiresAt: row.expiresAt,
  };
}

interface CredentialRow {
  id: string;
  principalId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: bigint;
  transports: string[];
  rpId: string;
}

function toStoredCredential(row: CredentialRow): StoredPasskeyCredential {
  return {
    id: row.id,
    principalId: row.principalId,
    credentialId: row.credentialId,
    publicKey: new Uint8Array(row.publicKey),
    counter: Number(row.counter),
    transports: row.transports,
    rpId: row.rpId,
  };
}
