/**
 * Real `EvidenceRepository`, backed by Postgres via Prisma.
 *
 * Same structure as `PrismaAuthorizationRepository` (see DECISIONS.md D-15,
 * D-16): the organization lock is a genuine `SELECT ... FOR UPDATE` inside a
 * transaction, and every other method reads from `this.client`, which
 * resolves to that locked transaction (via `AsyncLocalStorage`) when called
 * from inside the lock and to the plain `PrismaClient` otherwise -- so
 * `appendEvent`'s read of the current tip and its write of the new event
 * happen inside the same locked transaction instead of racing it on a
 * separate connection.
 *
 * Lock ordering convention (see D-16): when a single transaction needs both
 * this lock and `PrismaAuthorizationRepository`'s mandate lock, acquire the
 * organization lock first.
 *
 * Signs every event with the Ed25519 key it's constructed with (D-26/OQ-8).
 * The private key never touches Postgres -- only `hash` and the resulting
 * `signature` are stored -- which is exactly what makes the signature prove
 * something to a party who doesn't trust this database: reproducing a valid
 * one for a forged row needs the key, not write access here.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  exportPublicKeyBase64,
  ID_PREFIX,
  computeEventHash,
  generateId,
  signEventHash,
  type EvidenceEvent,
} from "@bles/core";
import type { KeyObject } from "node:crypto";
import type { EvidenceRepository, NewEvidenceEvent } from "./types.js";

type Db = PrismaClient | Prisma.TransactionClient;

const orgLockContext = new AsyncLocalStorage<Prisma.TransactionClient>();

/** Same rationale as PrismaAuthorizationRepository: Neon's free tier can take
 * several seconds to wake from idle on the first query of a run. */
const TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 20_000 };

export interface PrismaEvidenceRepositoryOptions {
  /**
   * Testing only. Skips the `SELECT ... FOR UPDATE` line -- nothing else --
   * so the transaction stays identical and the lock is the single variable
   * under test. See DECISIONS.md D-16 and the negative-control test in
   * `prisma-repository.test.ts`. Never set outside a test.
   */
  disableLockForTesting?: boolean;
}

export class PrismaEvidenceRepository implements EvidenceRepository {
  private readonly disableLockForTesting: boolean;
  private readonly publicKeyBase64: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly signingKey: KeyObject,
    options: PrismaEvidenceRepositoryOptions = {},
  ) {
    this.disableLockForTesting = options.disableLockForTesting ?? false;
    this.publicKeyBase64 = exportPublicKeyBase64(signingKey);
  }

  private get client(): Db {
    return orgLockContext.getStore() ?? this.prisma;
  }

  async withOrganizationLock<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      if (!this.disableLockForTesting) {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
      }
      return orgLockContext.run(tx, fn);
    }, TRANSACTION_OPTIONS);
  }

  async appendEvent(input: NewEvidenceEvent): Promise<EvidenceEvent> {
    const client = this.client;

    const latest = await client.evidenceEvent.findFirst({
      where: { organizationId: input.organizationId },
      orderBy: { sequence: "desc" },
    });
    const sequence = (latest?.sequence ?? 0) + 1;
    const previousHash = latest?.hash ?? null;

    const hash = computeEventHash({
      organization_id: input.organizationId,
      sequence,
      type: input.type,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      payload: input.payload,
      previous_hash: previousHash,
      created_at: input.now.toISOString(),
    });

    const created = await client.evidenceEvent.create({
      data: {
        id: generateId(ID_PREFIX.evidence),
        organizationId: input.organizationId,
        sequence,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payload: input.payload as unknown as Prisma.InputJsonValue,
        previousHash,
        hash,
        signature: signEventHash(this.signingKey, hash),
        createdAt: input.now,
      },
    });

    return toEvidenceEvent(created);
  }

  async listForOrganization(organizationId: string): Promise<EvidenceEvent[]> {
    const rows = await this.client.evidenceEvent.findMany({
      where: { organizationId },
      orderBy: { sequence: "asc" },
    });
    return rows.map(toEvidenceEvent);
  }

  getPublicKey(): string {
    return this.publicKeyBase64;
  }
}

interface EvidenceEventRow {
  id: string;
  organizationId: string;
  sequence: number;
  type: string;
  subjectType: string;
  subjectId: string;
  payload: Prisma.JsonValue;
  previousHash: string | null;
  hash: string;
  signature: string;
  createdAt: Date;
}

function toEvidenceEvent(row: EvidenceEventRow): EvidenceEvent {
  return {
    id: row.id,
    organization_id: row.organizationId,
    sequence: row.sequence,
    type: row.type,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    payload: row.payload as Record<string, unknown>,
    previous_hash: row.previousHash,
    hash: row.hash,
    signature: row.signature,
    created_at: row.createdAt,
  };
}
