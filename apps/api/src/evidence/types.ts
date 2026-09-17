/**
 * The evidence chain's persistence boundary.
 *
 * `computeEventHash`/`verifyEvidenceChain` in `@waysafe/core` are pure --
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

import type { EvidenceEvent, EvidenceKeyDirectoryEntry } from "@waysafe/core";

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

  /** Base64 SPKI Ed25519 public key every event's `signature` is checked
   * against (D-26/OQ-8). Derived from whatever signing key this instance
   * was constructed with -- the single source of truth server.ts's
   * /v1/evidence/verify and /v1/evidence/public-key routes both read from,
   * so there is no second place a key could get out of sync with the one
   * events are actually signed under. Unchanged by D-53 -- still the
   * currently active key, still the field a client that predates the key
   * directory reads. */
  getPublicKey(): string;

  /** The `key_id` (D-53) stamped on every event this instance appends --
   * `computeKeyId` of the same signing key `getPublicKey` describes. */
  getActiveKeyId(): string;

  /** Every key a signature in this deployment's evidence chains might have
   * been made under, oldest first (D-53) -- what
   * GET /v1/evidence/public-key's new `key_directory` field publishes,
   * alongside its unchanged `public_key`/`algorithm` fields. Exactly one
   * entry, this instance's own key with `valid_from: null`, until a real
   * key rotation adds a second. */
  getKeyDirectory(): EvidenceKeyDirectoryEntry[];
}
