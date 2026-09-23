/**
 * In-process fake `EvidenceRepository`.
 *
 * The organization lock is a real per-organization async mutex (see
 * `util/mutex.ts`) -- a chain of promises, not a flag -- so two concurrent
 * `withOrganizationLock` calls for the same organization genuinely run
 * back-to-back, in FIFO order. That proves the *locking logic* is correct;
 * `prisma-repository.test.ts` proves Postgres itself serializes two
 * connections the same way.
 *
 * Signs every event with a real Ed25519 key (D-26/OQ-8), the same as
 * `PrismaEvidenceRepository` -- there is no "test mode" that skips signing,
 * because a chain this repository produces but doesn't sign would prove
 * nothing about whether signing actually works when exercised through
 * `server.test.ts` and friends.
 */

import {
  exportPublicKeyBase64,
  ID_PREFIX,
  computeEventHash,
  generateId,
  type EvidenceEvent,
  type EvidenceKeyDirectoryEntry,
} from "@waysafe/core";
import { Mutex } from "../util/mutex.js";
import type { EvidenceSigner } from "../signing/types.js";
import type { EvidenceRepository, NewEvidenceEvent } from "./types.js";

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly eventsByOrg = new Map<string, EvidenceEvent[]>();
  private readonly locks = new Map<string, Mutex>();
  private readonly publicKeyBase64: string;
  private readonly keyId: string;

  constructor(private readonly signer: EvidenceSigner) {
    this.publicKeyBase64 = exportPublicKeyBase64(signer.publicKeyObject());
    this.keyId = signer.keyId;
  }

  async withOrganizationLock<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.locks.get(organizationId);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(organizationId, mutex);
    }
    return mutex.run(fn);
  }

  async appendEvent(input: NewEvidenceEvent): Promise<EvidenceEvent> {
    const events = this.eventsByOrg.get(input.organizationId) ?? [];
    const previous = events[events.length - 1];
    const sequence = (previous?.sequence ?? 0) + 1;
    const previousHash = previous?.hash ?? null;

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

    const event: EvidenceEvent = {
      id: generateId(ID_PREFIX.evidence),
      organization_id: input.organizationId,
      sequence,
      type: input.type,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      payload: input.payload,
      previous_hash: previousHash,
      hash,
      signature: Buffer.from(await this.signer.sign(Buffer.from(hash, "hex"))).toString("base64"),
      key_id: this.keyId,
      created_at: input.now,
    };

    events.push(event);
    this.eventsByOrg.set(input.organizationId, events);
    return event;
  }

  async listForOrganization(organizationId: string): Promise<EvidenceEvent[]> {
    return [...(this.eventsByOrg.get(organizationId) ?? [])];
  }

  getPublicKey(): string {
    return this.publicKeyBase64;
  }

  getActiveKeyId(): string {
    return this.keyId;
  }

  getKeyDirectory(): EvidenceKeyDirectoryEntry[] {
    return [{ key_id: this.keyId, public_key: this.publicKeyBase64, valid_from: null }];
  }
}
