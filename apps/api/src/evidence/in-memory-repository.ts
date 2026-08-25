/**
 * In-process fake `EvidenceRepository`.
 *
 * The organization lock is a real per-organization async mutex (see
 * `util/mutex.ts`) -- a chain of promises, not a flag -- so two concurrent
 * `withOrganizationLock` calls for the same organization genuinely run
 * back-to-back, in FIFO order. That proves the *locking logic* is correct;
 * `prisma-repository.test.ts` proves Postgres itself serializes two
 * connections the same way.
 */

import { ID_PREFIX, computeEventHash, generateId, type EvidenceEvent } from "@agentpay/core";
import { Mutex } from "../util/mutex.js";
import type { EvidenceRepository, NewEvidenceEvent } from "./types.js";

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly eventsByOrg = new Map<string, EvidenceEvent[]>();
  private readonly locks = new Map<string, Mutex>();

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
      created_at: input.now,
    };

    events.push(event);
    this.eventsByOrg.set(input.organizationId, events);
    return event;
  }

  async listForOrganization(organizationId: string): Promise<EvidenceEvent[]> {
    return [...(this.eventsByOrg.get(organizationId) ?? [])];
  }
}
