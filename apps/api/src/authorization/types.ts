/**
 * The persistence boundary the authorization service talks to.
 *
 * `evaluate()` in @waysafe/core is pure; everything on this interface is the
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
  ActorKind,
  AgentStatus,
  AuthorizationStatus,
  Decision,
  MandateStatus,
  MerchantDirectory,
  Policy,
  ProposedAction,
  Reason,
  ResolvedMerchant,
  SpendSnapshot,
} from "@waysafe/core";

export type LedgerEntryType = "RESERVATION" | "RELEASE" | "CAPTURE" | "CREDIT";

export interface NewLedgerEntry {
  type: LedgerEntryType;
  /** Signed minor units: RESERVATION/CAPTURE positive, RELEASE/CREDIT negative. */
  amount: number;
  /** Set only on CAPTURE entries (D-13): which rail executed, and what it
   * took in minor units. A receipt that can't show this can't prove the
   * router stayed neutral across rails. */
  provider?: string;
  providerFee?: number;
}

export interface StoredAuthorization {
  id: string;
  organization_id: string;
  /** Who acted (D-35). Exactly one of agent_id/instrument_id is set,
   * matching this discriminator -- enforced by a DB CHECK constraint, see
   * packages/db/prisma/manual-constraints.sql. */
  actor_kind: ActorKind;
  agent_id: string | null;
  instrument_id: string | null;
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
  /** A rail's own reference for this decision, e.g. a Stripe Issuing
   * authorization id (D-35) -- the join key a later webhook event (capture)
   * uses to find this row back. Null for an agent-actor authorization. */
  external_ref: string | null;
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
  policy: Policy;
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
  /** Who acted (D-35). Exactly one of agentId/instrumentId must be set,
   * matching this value -- both implementations reject anything else, and
   * the Prisma one is additionally backstopped by a DB CHECK constraint. */
  actorKind: ActorKind;
  agentId: string | null;
  instrumentId: string | null;
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
  /** A rail's own reference for this decision (D-35), e.g. a Stripe Issuing
   * authorization id. Null for an agent-actor authorization. */
  externalRef?: string | null;
  stepUpExpiresAt: Date | null;
  now: Date;
  /** Written atomically with the authorization row, inside the same mandate lock. */
  ledgerEntries: NewLedgerEntry[];
}

export interface NewMandate {
  organizationId: string;
  principalId: string;
  /** Agents this mandate version delegates to. No ambient authority (D-1). */
  agentIds: string[];
  policy: Policy;
  policyHash: string;
  /** The principal's original words, verbatim (D-5). */
  intentText: string;
  compilerName: string;
  compilerModel?: string;
  /** Choices the compiler made that the principal did not state (D-6). */
  assumptions: string[];
}

export interface CreatedMandate {
  mandateId: string;
  mandateVersionId: string;
  policyHash: string;
}

export interface MandateSummary {
  mandateId: string;
  mandateVersionId: string;
  organizationId: string;
  principalId: string;
  policyHash: string;
  status: MandateStatus;
}

export interface MandateListItem {
  mandateId: string;
  organizationId: string;
  principalId: string;
  status: MandateStatus;
  policyHash: string;
  summary: string;
  createdAt: string;
}

export interface MandateDetail extends MandateListItem {
  mandateVersionId: string;
  policy: Policy;
  intentText: string;
  assumptions: string[];
  agentIds: string[];
  authenticatedAt: string | null;
  /** The request IP the principal authenticated from (D-38). Null exactly
   * when authenticatedAt is null -- the two are set together, by the same
   * activateMandate call, and never independently. */
  authenticationIp: string | null;
}

export interface NewAgent {
  organizationId: string;
  name: string;
  description?: string | null;
}

export interface CreatedAgent {
  agentId: string;
  organizationId: string;
  name: string;
  status: AgentStatus;
}

export interface AgentListItem {
  agentId: string;
  organizationId: string;
  name: string;
  status: AgentStatus;
  createdAt: string;
}

export interface RecordExecutionInput {
  authorizationId: string;
  provider: string;
  providerReference: string;
  /** Integer minor units. */
  providerFee: number;
}

export interface RecordRefundInput {
  authorizationId: string;
  /** Positive integer minor units -- stored as a negative CREDIT entry. */
  amount: number;
  provider: string;
  providerReference: string;
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

  /** Global lookup by a rail's own reference for the decision (D-35), e.g.
   * a Stripe Issuing authorization id -- how a later capture webhook event
   * finds the row it needs to release/capture. Not org-scoped, same
   * reasoning as `getAuthorization`: the caller doesn't know the
   * organization until this resolves it. */
  findByExternalRef(externalRef: string): Promise<StoredAuthorization | null>;

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
   * Every PENDING_STEP_UP authorization whose TTL has already passed as of
   * `now`, across every organization -- not scoped to one mandate or org,
   * unlike everything else on this interface, because this is what the
   * expiry worker (D-31/OQ-6) sweeps on a timer, not what one tenant's
   * request reads. Each result feeds `resolveStepUp(..., "expired", ...)`
   * directly, which still takes `withMandateLock` itself -- this method
   * only finds the work, it does not hold anything.
   */
  listExpiredPendingStepUps(now: Date): Promise<{ mandateId: string; authorizationId: string }[]>;

  /**
   * Stamps `authenticatedAt` and `authenticationIp` on the mandate version
   * and moves the mandate to ACTIVE. D-20: the only caller is
   * `webauthn/service.ts`'s `authenticateMandate()`, and only after
   * `verifyAuthentication()` (a real signature check) has returned
   * `ok: true` -- there is no code path that reaches this method without
   * one. This method itself does not verify anything; it trusts the caller
   * already did.
   *
   * `ip` (D-38) is the request IP of that same verified ceremony -- the
   * only legitimate source for a rail's own "the cardholder accepted these
   * terms from this IP at this time" field
   * (`provisionCardForMandate`/`requireCardIssuingTermsAcceptance`).
   * Callers must pass the real `request.ip`, never a placeholder.
   */
  activateMandate(mandateId: string, mandateVersionId: string, ip: string, now: Date): Promise<void>;

  /**
   * Creates a Mandate (status PENDING_AUTHENTICATION) and its first
   * MandateVersion (authenticatedAt null). Closes the D-7 gap: compiling a
   * policy is a proposal (`POST /v1/mandates/compile`), never persisted;
   * this is the step that turns a confirmed proposal into something that
   * can be authenticated and, eventually, authorized against.
   */
  createMandate(input: NewMandate, now: Date): Promise<CreatedMandate>;

  /** For the authenticate/options and /verify endpoints, which need to know
   * who a mandate belongs to and its current policy_hash before any
   * particular agent is in the picture. Null if no such mandate exists. */
  getMandateSummary(mandateId: string): Promise<MandateSummary | null>;

  /** The receipt endpoint. Null if no such authorization exists. */
  getAuthorization(id: string): Promise<StoredAuthorization | null>;

  /**
   * Creates an Agent row. Kept on this interface rather than a separate
   * one: agent existence and status are already read here (resolveMandateGate),
   * and a standalone in-memory agent store would silently desync from the
   * one the gate checks actually consult.
   */
  createAgent(input: NewAgent, now: Date): Promise<CreatedAgent>;

  /**
   * Releases the authorization's existing RESERVATION and replaces it with
   * a CAPTURE for the same amount, tagged with which rail executed and
   * what it took (D-13) -- net zero change to cumulative spend, since the
   * reservation already counted against it at decision time (D-4) -- then
   * flips the authorization to EXECUTED. Throws if the authorization isn't
   * currently AUTHORIZED or STEP_UP_APPROVED: defense in depth, not the
   * primary guard -- the primary guard is that callers can only reach this
   * with an `ExecutableAuthorization` (`execution/executable.ts`), which
   * cannot be constructed for any other status. Must be called from inside
   * `withMandateLock` for the authorization's mandate.
   */
  recordExecution(input: RecordExecutionInput, now: Date): Promise<StoredAuthorization>;

  /**
   * A CREDIT ledger entry for a refund on an already-EXECUTED authorization.
   * Whether this affects cumulative spend is decided at read time by
   * `getSpendSnapshot` (the policy's own `refunds_credit_budget`, D-4), not
   * here -- this always records the fact of the refund. Does not change
   * the authorization's status; a refund doesn't un-execute a payment.
   * Must be called from inside `withMandateLock` for the authorization's
   * mandate.
   */
  recordRefund(input: RecordRefundInput, now: Date): Promise<void>;

  /** Dashboard reads (Week 5). Most-recent-first, capped at `limit`. */
  listMandates(organizationId: string, limit: number): Promise<MandateListItem[]>;

  /** The full policy + version detail a dashboard mandate page needs, beyond
   * MandateSummary's lookup-only fields. Null if no such mandate exists. */
  getMandateDetail(mandateId: string): Promise<MandateDetail | null>;

  /** Most-recent-first, capped at `limit`. */
  listAuthorizations(organizationId: string, limit: number): Promise<StoredAuthorization[]>;

  listAgents(organizationId: string): Promise<AgentListItem[]>;
}
