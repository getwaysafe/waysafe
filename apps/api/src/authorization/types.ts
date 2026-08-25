/**
 * The persistence boundary the authorization service talks to.
 *
 * `evaluate()` in @agentpay/core is pure; everything on this interface is the
 * I/O it deliberately doesn't do. Two implementations exist:
 *
 *  - `InMemoryAuthorizationRepository` — an in-process fake, used by every
 *    test in this package including the concurrency test. It simulates a
 *    Postgres row lock with a real per-mandate async mutex, so it proves the
 *    *service's* locking logic is correct, but it cannot prove Postgres
 *    itself will serialize two connections the same way.
 *  - `PrismaAuthorizationRepository` — real persistence, `SELECT ... FOR
 *    UPDATE` inside a transaction. Its own test suite
 *    (prisma-repository.test.ts) skips itself when DATABASE_URL isn't a
 *    reachable Postgres instance; see DECISIONS.md D-15.
 */

import type {
  Accounting,
  AuthorizationStatus,
  Decision,
  MerchantDirectory,
  ProposedAction,
  Reason,
  ResolvedMerchant,
  SpendSnapshot,
} from "@agentpay/core";

export type LedgerEntryType = "RESERVATION" | "RELEASE" | "CAPTURE" | "CREDIT";

export interface NewLedgerEntry {
  type: LedgerEntryType;
  /** Signed minor units: RESERVATION/CAPTURE positive, RELEASE/CREDIT negative. */
  amount: number;
}

export interface StoredAuthorization {
  id: string;
  organization_id: string;
  agent_id: string;
  principal_id: string;
  mandate_id: string;
  mandate_version_id: string;
  policy_hash: string;
  decision: Decision;
  status: AuthorizationStatus;
  reasons: Reason[];
  action: ProposedAction;
  merchant: ResolvedMerchant;
  idempotency_key: string | null;
  request_hash: string | null;
  step_up_expires_at: string | null;
  created_at: string;
  decided_at: string;
}

export interface ResolveMandateInput {
  organizationId: string;
  agentId: string;
  principalId: string;
  mandateId?: string;
}

export interface MandateGateOk {
  ok: true;
  mandateId: string;
  mandateVersionId: string;
  policy: import("@agentpay/core").Policy;
  policyHash: string;
}

export interface MandateGateFail {
  ok: false;
  /** Present when a real mandate row exists to attach the DENY to. */
  mandateId?: string;
  mandateVersionId?: string;
  policyHash?: string;
  reasons: Reason[];
}

export type MandateGateResult = MandateGateOk | MandateGateFail;

export interface SaveAuthorizationInput {
  id: string;
  organizationId: string;
  agentId: string;
  principalId: string;
  mandateId: string;
  mandateVersionId: string;
  policyHash: string;
  decision: Decision;
  status: AuthorizationStatus;
  reasons: Reason[];
  action: ProposedAction;
  merchant: ResolvedMerchant;
  idempotencyKey: string | null;
  requestHash: string | null;
  stepUpExpiresAt: Date | null;
  now: Date;
  /** Written atomically with the authorization row, inside the same mandate lock. */
  ledgerEntries: NewLedgerEntry[];
}

export interface AuthorizationRepository {
  /**
   * Look up the mandate this request should be evaluated against and check
   * every actor-state precondition (status, authentication, agent binding,
   * agent status, principal match). This is the one gate `evaluate()` itself
   * never runs, because it needs rows the pure engine has no business
   * reading.
   */
  resolveMandateGate(input: ResolveMandateInput): Promise<MandateGateResult>;

  getMerchantDirectory(): MerchantDirectory;

  /** SUM over ledger_entries for this mandate's day/week/month/lifetime windows, as of `now`. */
  getSpendSnapshot(
    mandateId: string,
    accounting: Accounting,
    now: Date,
  ): Promise<SpendSnapshot>;

  findByIdempotencyKey(
    organizationId: string,
    key: string,
  ): Promise<StoredAuthorization | null>;

  /**
   * Serializes everything the callback does against this mandate: two
   * concurrent authorizations for the same mandate run their spend-snapshot
   * read and ledger write back-to-back, never interleaved. D-4's row lock.
   */
  withMandateLock<T>(mandateId: string, fn: () => Promise<T>): Promise<T>;

  /** Must be called from inside `withMandateLock` for the same mandate. */
  saveAuthorization(input: SaveAuthorizationInput): Promise<StoredAuthorization>;

  /**
   * A pending step-up is answered (approved/declined) or times out. Declined
   * and expired release any RESERVATION this authorization holds. Must be
   * called from inside `withMandateLock` for the authorization's mandate.
   */
  resolveStepUp(
    mandateId: string,
    authorizationId: string,
    outcome: "approved" | "declined" | "expired",
    now: Date,
  ): Promise<StoredAuthorization>;

  /**
   * Stamps `authenticatedAt` on the mandate version and moves the mandate to
   * ACTIVE. D-20: the only caller is `webauthn/service.ts`'s
   * `authenticateMandate()`, and only after `verifyAuthentication()` (a real
   * signature check) has returned `ok: true` -- there is no code path that
   * reaches this method without one. This method itself does not verify
   * anything; it trusts the caller already did.
   */
  activateMandate(mandateId: string, mandateVersionId: string, now: Date): Promise<void>;
}
