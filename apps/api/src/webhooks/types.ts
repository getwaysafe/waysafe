/**
 * Idempotent webhook ingestion: same provider event twice, one ledger
 * effect. `recordIfNew` is the entire mechanism -- there is no separate
 * "have I seen this?" read followed by an insert. The Prisma implementation
 * relies on the `ProviderEvent` table's `@@unique([provider, externalId])`
 * constraint and treats a unique-violation as "already seen", so two
 * concurrent deliveries of the same event race on the database itself, not
 * on application logic that could get the check-then-write order wrong.
 */

export interface ProviderEventRepository {
  /**
   * Returns `true` the first time this (provider, externalId) pair is
   * seen -- the caller should apply the event's effect. Returns `false` if
   * it's already been recorded -- the caller must not apply the effect
   * again, but should still treat the webhook delivery itself as
   * successfully handled (so the provider stops retrying).
   */
  recordIfNew(
    provider: string,
    externalId: string,
    type: string,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<boolean>;
}
