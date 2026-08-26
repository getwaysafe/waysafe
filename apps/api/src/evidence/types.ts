/**
 * The evidence chain's persistence boundary.
 *
 * `computeEventHash`/`verifyEvidenceChain` in `@bles/core` are pure --
 * this interface is the I/O they deliberately don't do: assigning the next
 * `sequence` number and the chain's current tip hash, and doing so under a
 * lock so two concurrent appends to the same organization's chain can't
 * race (see DECISIONS.md D-16 -- this is the same class of race D-4 exists
 * to prevent, just scoped to an organization instead of a mandate).
 *
 * Two implementations, matching the authorization repository's pattern:
 * `InMemoryEvidenceRepository` (a real per-organization async mutex) and
 * `PrismaEvidenceRepository` (a real `SELECT ... FOR UPDATE`).
 */

import type { EvidenceEvent } from "@bles/core";

export interface NewEvidenceEvent {
  organizationId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  now: Date;
}

export interface EvidenceRepository {
  /**
   * Serializes everything the callback does against this organization's
   * evidence chain: two concurrent appends run their sequence/tip-hash read
   * and their write back-to-back, never interleaved.
   */
  withOrganizationLock<T>(organizationId: string, fn: () => Promise<T>): Promise<T>;

  /** Must be called from inside `withOrganizationLock` for the same organization. */
  appendEvent(input: NewEvidenceEvent): Promise<EvidenceEvent>;

  /** In ascending sequence order -- the order `verifyEvidenceChain` requires. */
  listForOrganization(organizationId: string): Promise<EvidenceEvent[]>;
}
