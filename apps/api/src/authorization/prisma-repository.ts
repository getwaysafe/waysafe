/**
 * Real `AuthorizationRepository`, backed by Postgres via Prisma.
 *
 * The row lock (D-4) is a genuine `SELECT ... FOR UPDATE` inside a
 * transaction, not a simulation: `withMandateLock` opens the transaction and
 * locks the mandate row, then runs the callback with that transaction's
 * client stashed in `mandateLockContext` (AsyncLocalStorage). Every other
 * method reads `this.client`, which resolves to the active transaction when
 * called from inside a lock and to the plain `PrismaClient` otherwise — so
 * `getSpendSnapshot` and `saveAuthorization`, called from within
 * `withMandateLock`'s callback in service.ts, participate in the *same*
 * locked transaction instead of racing it on separate connections. Without
 * that, the lock would exist but do nothing: the read and the write it's
 * meant to serialize would happen outside it.
 *
 * See DECISIONS.md D-15.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import {
  ID_PREFIX,
  generateId,
  resolveMerchant,
  verifiedMerchantKeys,
  windowKeys,
  type Accounting,
  type ActorKind,
  type AuthorizationStatus,
  type Decision,
  type MerchantDirectory,
  type Policy,
  type ProposedAction,
  type Reason,
  type ReasonCode,
  type ResolvedMerchant,
  type SpendSnapshot,
} from "@waysafe/core";
import {
  ExternalRefConflictError,
  MandateCreationError,
  type AuthorizedMandateGate,
  type AgentListItem,
  type AuthorizationRepository,
  type CreatedAgent,
  type CreatedMandate,
  type MandateDetail,
  type MandateGateResult,
  type MandateListItem,
  type MandateSummary,
  type NewAgent,
  type NewMandate,
  type RecordExecutionInput,
  type RecordRefundInput,
  type SettleExternalInput,
  type UnauthorizedSettlementInput,
  type SettlementOutcome,
  type ResolveMandateInput,
  type SaveAuthorizationInput,
  type StoredAuthorization,
} from "./types.js";
import { assertValidActor } from "./actor.js";
import { gateMandateExpiry, gateMandateStatus } from "./mandate-gate.js";
import { activeTransaction } from "../db/transaction-context.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** D-76: the shared store, so `PrismaEvidenceRepository` can join this
 * transaction instead of opening a competing one. Was a module-private
 * AsyncLocalStorage here until D-76. */
const mandateLockContext = activeTransaction;

/**
 * Generous timeouts: Neon's free tier scales to zero when idle, so the first
 * query on a cold database can take several seconds to wake it. That's a
 * slow query, not a stuck transaction -- the default 5s transaction timeout
 * would misdiagnose it as the latter.
 */
const TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 20_000 };

const SETTLED_STATUSES: AuthorizationStatus[] = ["AUTHORIZED", "STEP_UP_APPROVED", "EXECUTED"];

export interface PrismaAuthorizationRepositoryOptions {
  /**
   * Testing only. Skips the `SELECT ... FOR UPDATE` line -- nothing else --
   * so the transaction and the AsyncLocalStorage wiring stay identical and
   * the row lock is the single variable under test. Exists so the D-4
   * concurrency test has a negative control: proof that the test actually
   * detects an unserialized race, not just that two operations happened not
   * to overlap. Never set outside a test.
   */
  disableLockForTesting?: boolean;
}

export class PrismaAuthorizationRepository implements AuthorizationRepository {
  private readonly disableLockForTesting: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly directory: MerchantDirectory,
    options: PrismaAuthorizationRepositoryOptions = {},
  ) {
    this.disableLockForTesting = options.disableLockForTesting ?? false;
  }

  private get client(): Db {
    return mandateLockContext.getStore() ?? this.prisma;
  }

  // --- AuthorizationRepository -----------------------------------------------

  getMerchantDirectory(): MerchantDirectory {
    return this.directory;
  }

  async resolveMandateGate(input: ResolveMandateInput): Promise<MandateGateResult> {
    const client = this.client;

    const mandate = input.mandateId
      ? await client.mandate.findUnique({
          where: { id: input.mandateId },
          include: { currentVersion: { include: { agents: true } } },
        })
      : await client.mandate.findFirst({
          where: {
            organizationId: input.organizationId,
            principalId: input.principalId,
            status: "ACTIVE",
            currentVersion: { agents: { some: { agentId: input.agentId } } },
          },
          include: { currentVersion: { include: { agents: true } } },
        });

    if (!mandate || mandate.organizationId !== input.organizationId || !mandate.currentVersion) {
      return {
        ok: false,
        reasons: [
          reason(
            "DENY_NO_ACTIVE_MANDATE",
            "No active mandate delegates this authority to this agent.",
          ),
        ],
      };
    }

    const base = {
      mandateId: mandate.id,
      mandateVersionId: mandate.currentVersion.id,
      policyHash: mandate.currentVersion.policyHash,
    };

    if (mandate.principalId !== input.principalId) {
      return {
        ok: false,
        ...base,
        reasons: [
          reason(
            "DENY_PRINCIPAL_MISMATCH",
            "The mandate belongs to a different principal than the one named.",
          ),
        ],
      };
    }

    const statusCode: Partial<Record<string, ReasonCode>> = {
      REVOKED: "DENY_MANDATE_REVOKED",
      EXPIRED: "DENY_MANDATE_EXPIRED",
      SUPERSEDED: "DENY_MANDATE_SUPERSEDED",
      DRAFT: "DENY_MANDATE_NOT_AUTHENTICATED",
      PENDING_AUTHENTICATION: "DENY_MANDATE_NOT_AUTHENTICATED",
    };
    if (mandate.status !== "ACTIVE") {
      const code = statusCode[mandate.status] ?? "DENY_NO_ACTIVE_MANDATE";
      return {
        ok: false,
        ...base,
        reasons: [reason(code, `The mandate's status is ${mandate.status}.`)],
      };
    }

    if (!mandate.currentVersion.authenticatedAt) {
      return {
        ok: false,
        ...base,
        reasons: [
          reason(
            "DENY_MANDATE_NOT_AUTHENTICATED",
            "The mandate was never authenticated by the principal.",
          ),
        ],
      };
    }

    const agent = await client.agent.findUnique({ where: { id: input.agentId } });
    const boundAgentIds = mandate.currentVersion.agents.map((a) => a.agentId);
    if (
      !agent ||
      agent.organizationId !== input.organizationId ||
      !boundAgentIds.includes(input.agentId)
    ) {
      return {
        ok: false,
        ...base,
        reasons: [reason("DENY_AGENT_NOT_BOUND", "This agent is not bound to the mandate.")],
      };
    }

    if (agent.status !== "ACTIVE") {
      return {
        ok: false,
        ...base,
        reasons: [reason("DENY_AGENT_SUSPENDED", "This agent is suspended.")],
      };
    }

    return {
      ok: true,
      mandateId: mandate.id,
      mandateVersionId: mandate.currentVersion.id,
      policy: mandate.currentVersion.policy as unknown as Policy,
      policyHash: mandate.currentVersion.policyHash,
    };
  }

  async getSpendSnapshot(
    mandateId: string,
    accounting: Accounting,
    now: Date,
  ): Promise<SpendSnapshot> {
    const client = this.client;
    const keys = windowKeys(now, accounting.timezone);
    const entries = await client.ledgerEntry.findMany({ where: { mandateId } });

    const sumWhere = (matches: (e: (typeof entries)[number]) => boolean) => {
      let amount = 0;
      let reservations = 0;
      let releases = 0;
      for (const entry of entries) {
        if (!matches(entry)) continue;
        if (entry.type === "CREDIT" && !accounting.refunds_credit_budget) continue;
        amount += entry.amount;
        if (entry.type === "RESERVATION") reservations += 1;
        if (entry.type === "RELEASE") releases += 1;
      }
      return { amount, count: Math.max(0, reservations - releases) };
    };

    return {
      day: sumWhere((e) => e.dayKey === keys.day),
      week: sumWhere((e) => e.weekKey === keys.week),
      month: sumWhere((e) => e.monthKey === keys.month),
      mandate: sumWhere(() => true),
      seenMerchants: await this.seenMerchants(mandateId),
    };
  }

  async findByIdempotencyKey(
    organizationId: string,
    key: string,
  ): Promise<StoredAuthorization | null> {
    const row = await this.client.authorization.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: key } },
    });
    return row ? toStoredAuthorization(row) : null;
  }

  async findByExternalRef(externalRef: string): Promise<StoredAuthorization | null> {
    // D-79: multiple revisions can share one externalRef, so this returns
    // the LATEST. Callers that need one specific revision use
    // findByExternalRefAndRevision.
    const row = await this.client.authorization.findFirst({
      where: { externalRef },
      orderBy: [{ externalRevision: "desc" }, { createdAt: "desc" }],
    });
    return row ? toStoredAuthorization(row) : null;
  }

  /** D-79. See `AuthorizationRepository.findByExternalRefAndRevision`. */
  async findByExternalRefAndRevision(
    externalRef: string,
    revision: number | null,
  ): Promise<StoredAuthorization | null> {
    const row = await this.client.authorization.findFirst({
      where: { externalRef, externalRevision: revision },
    });
    return row ? toStoredAuthorization(row) : null;
  }

  /** D-79. See `AuthorizationRepository.listByExternalRef`. */
  async listByExternalRef(mandateId: string, externalRef: string): Promise<StoredAuthorization[]> {
    const rows = await this.client.authorization.findMany({
      where: { mandateId, externalRef },
      orderBy: [{ externalRevision: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(toStoredAuthorization);
  }

  /** D-79. See `AuthorizationRepository.getExternalRefHold`. */
  async getExternalRefHold(mandateId: string, externalRef: string): Promise<number> {
    const rows = await this.client.authorization.findMany({
      where: { mandateId, externalRef },
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const entries = await this.client.ledgerEntry.findMany({
      where: {
        mandateId,
        authorizationId: { in: rows.map((r) => r.id) },
        type: { in: ["RESERVATION", "RELEASE"] },
      },
      select: { amount: true },
    });
    return entries.reduce((sum, e) => sum + e.amount, 0);
  }

  /**
   * D-62: resolving a step-up as an approver needs two mandate locks at
   * once (the original mandate's and the approver's), acquired as a
   * nested `withMandateLock` call. Prisma's `$transaction()` does not
   * nest safely -- calling it again while one is already open, on the
   * same client, opens a second, independent transaction (a second
   * connection, or a wait for one), not a nested savepoint; against a
   * real pool that starves or times out (confirmed live: a nested call
   * here blew the 20s TRANSACTION_OPTIONS timeout on a real Postgres
   * run before this fix, `P2028`). So: if `mandateLockContext` already
   * holds an active transaction, reuse it -- add this mandate's row lock
   * to the SAME transaction rather than opening a second one. Postgres
   * allows any number of `FOR UPDATE` locks within one transaction; this
   * makes a nested call strictly safer than two separate ones would have
   * been, since everything commits or rolls back together.
   */
  async withMandateLock<T>(mandateId: string, fn: () => Promise<T>): Promise<T> {
    const activeTx = mandateLockContext.getStore();
    if (activeTx) {
      if (!this.disableLockForTesting) {
        await activeTx.$queryRaw`SELECT id FROM mandates WHERE id = ${mandateId} FOR UPDATE`;
      }
      return fn();
    }
    return this.prisma.$transaction(async (tx) => {
      if (!this.disableLockForTesting) {
        await tx.$queryRaw`SELECT id FROM mandates WHERE id = ${mandateId} FOR UPDATE`;
      }
      return mandateLockContext.run(tx, fn);
    }, TRANSACTION_OPTIONS);
  }

  /** D-80 follow-up. See `AuthorizationRepository.withAuthorizedMandate`. */
  async withAuthorizedMandate<T>(
    mandateId: string,
    now: Date,
    fn: (gate: AuthorizedMandateGate) => Promise<T>,
  ): Promise<T> {
    return this.withMandateLock(mandateId, async () => {
      const mandate = await this.getMandateDetail(mandateId);
      const reasons = gateMandateStatus(mandate) ?? gateMandateExpiry(mandate, now);
      return fn(reasons ? { ok: false, reasons } : { ok: true, mandate: mandate as MandateDetail });
    });
  }

  async saveAuthorization(input: SaveAuthorizationInput): Promise<StoredAuthorization> {
    assertValidActor(input);

    const client = this.client;
    const timezone = await this.timezoneFor(input.mandateId);
    const keys = windowKeys(input.now, timezone);

    try {
      const created = await client.authorization.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          actorKind: input.actorKind,
          agentId: input.agentId,
          instrumentId: input.instrumentId,
          principalId: input.principalId,
          mandateId: input.mandateId,
          mandateVersionId: input.mandateVersionId,
          policyHash: input.policyHash,
          decision: input.decision,
          status: input.status,
          reasonCodes: input.reasons.map((r) => r.code),
          reasons: input.reasons as unknown as Prisma.InputJsonValue,
          action: input.action as unknown as Prisma.InputJsonValue,
          amount: input.action.amount,
          currency: input.action.currency,
          merchant: input.merchant as unknown as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          externalRevision: input.externalRevision ?? null,
          externalRef: input.externalRef ?? null,
          stepUpExpiresAt: input.stepUpExpiresAt,
          createdAt: input.now,
          decidedAt: input.now,
          ledgerEntries: {
            create: input.ledgerEntries.map((entry) => ({
              id: generateId(ID_PREFIX.evidence),
              organizationId: input.organizationId,
              mandateId: input.mandateId,
              type: entry.type,
              amount: entry.amount,
              currency: input.action.currency,
              dayKey: keys.day,
              weekKey: keys.week,
              monthKey: keys.month,
              createdAt: input.now,
            })),
          },
        },
      });
      return toStoredAuthorization(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // D-74: two different uniqueness constraints land here, and the
        // caller has to tell them apart -- an idempotency-key collision is
        // a caller that skipped its own check, while an external-ref
        // collision is a rail redelivering an event already decided, which
        // is normal and must replay rather than error.
        const target = JSON.stringify(err.meta?.target ?? "");
        if (input.externalRef && target.includes("externalRef")) {
          throw new ExternalRefConflictError(input.externalRef);
        }
        throw new Error(
          `idempotency key already claimed; caller must check findByIdempotencyKey first`,
        );
      }
      throw err;
    }
  }

  /**
   * D-72: the calendar window a ledger row belongs to is the window the
   * authorization was **decided** in -- never the window the later event
   * happens to fire in.
   *
   * Before D-72 every write recomputed `windowKeys(now)`. A $90 hold taken
   * in August and released in September wrote `RESERVATION +9000` under
   * August's keys and `RELEASE -9000` under September's: August kept a hold
   * that no longer existed, September reported **negative** cumulative
   * spend, and the mandate's September budget was its cap plus $90. A
   * negative window SUM is precisely what non-negotiable #6 says cannot
   * happen, and it happened on a calendar boundary with no concurrency
   * involved at all.
   *
   * Prefers the reservation's own stored keys when there is a reservation,
   * so a release always cancels the row it releases exactly -- including
   * for any row written before D-72, whose keys may not match the
   * authorization's window. Falls back to the authorization's decision
   * window when there is no reservation (a `reserve_on_step_up: false`
   * capture, a refund), which by construction is the same value
   * `saveAuthorization` stamped on a reservation it did write.
   */
  private async windowKeysFor(
    auth: { mandateId: string; createdAt: Date },
    reservation: { dayKey: string; weekKey: string; monthKey: string } | null,
  ): Promise<{ day: string; week: string; month: string }> {
    if (reservation) {
      return {
        day: reservation.dayKey,
        week: reservation.weekKey,
        month: reservation.monthKey,
      };
    }
    const timezone = await this.timezoneFor(auth.mandateId);
    return windowKeys(auth.createdAt, timezone);
  }

  async resolveStepUp(
    mandateId: string,
    authorizationId: string,
    outcome: "approved" | "declined" | "expired",
    now: Date,
  ): Promise<StoredAuthorization> {
    const client = this.client;
    const auth = await client.authorization.findUnique({ where: { id: authorizationId } });
    if (!auth) throw new Error(`no such authorization: ${authorizationId}`);
    if (auth.status !== "PENDING_STEP_UP") {
      throw new Error(
        `authorization ${authorizationId} is not pending step-up (status=${auth.status})`,
      );
    }

    if (outcome === "approved") {
      const updated = await client.authorization.update({
        where: { id: authorizationId },
        data: { status: "STEP_UP_APPROVED" },
      });
      return toStoredAuthorization(updated);
    }

    // D-71: scoped to this mandate. Since D-62 two mandates can hold a
    // RESERVATION under one authorization id, and an unscoped lookup here
    // would release the approver's hold onto the original mandate's ledger.
    const reservation = await client.ledgerEntry.findFirst({
      where: { mandateId, authorizationId, type: "RESERVATION" },
    });
    if (reservation) {
      // D-72: the reservation's own window, not `now`'s.
      const keys = await this.windowKeysFor(auth, reservation);
      await client.ledgerEntry.create({
        data: {
          id: generateId(ID_PREFIX.evidence),
          organizationId: auth.organizationId,
          mandateId,
          authorizationId,
          type: "RELEASE",
          amount: -reservation.amount,
          currency: auth.currency,
          dayKey: keys.day,
          weekKey: keys.week,
          monthKey: keys.month,
          createdAt: now,
        },
      });
    }

    const updated = await client.authorization.update({
      where: { id: authorizationId },
      data: { status: outcome === "declined" ? "STEP_UP_DECLINED" : "EXPIRED" },
    });
    return toStoredAuthorization(updated);
  }

  async recordApproverLedgerEntry(
    mandateId: string,
    authorizationId: string,
    amount: number,
    now: Date,
  ): Promise<void> {
    const client = this.client;
    const auth = await client.authorization.findUnique({ where: { id: authorizationId } });
    if (!auth) throw new Error(`no such authorization: ${authorizationId}`);

    const timezone = await this.timezoneFor(mandateId);
    const keys = windowKeys(now, timezone);
    await client.ledgerEntry.create({
      data: {
        id: generateId(ID_PREFIX.evidence),
        organizationId: auth.organizationId,
        mandateId,
        authorizationId,
        type: "RESERVATION",
        amount,
        currency: auth.currency,
        dayKey: keys.day,
        weekKey: keys.week,
        monthKey: keys.month,
        createdAt: now,
      },
    });
  }

  /** D-71. See `AuthorizationRepository.recordStepUpApprovalHold`. */
  async recordStepUpApprovalHold(
    mandateId: string,
    authorizationId: string,
    amount: number,
    now: Date,
  ): Promise<void> {
    const client = this.client;
    const auth = await client.authorization.findUnique({ where: { id: authorizationId } });
    if (!auth) throw new Error(`no such authorization: ${authorizationId}`);
    if (auth.mandateId !== mandateId) {
      throw new Error(
        `authorization ${authorizationId} belongs to mandate ${auth.mandateId}, not ${mandateId}`,
      );
    }

    const existing = await client.ledgerEntry.findFirst({
      where: { mandateId, authorizationId, type: "RESERVATION" },
    });
    if (existing) return; // reserve_on_step_up: true already took the hold

    // D-72: the window the authorization was decided in, not the window
    // the approval happens to land in -- a step-up raised in August and
    // approved in September is August's spend.
    const keys = await this.windowKeysFor(auth, null);
    await client.ledgerEntry.create({
      data: {
        id: generateId(ID_PREFIX.evidence),
        organizationId: auth.organizationId,
        mandateId,
        authorizationId,
        type: "RESERVATION",
        amount,
        currency: auth.currency,
        dayKey: keys.day,
        weekKey: keys.week,
        monthKey: keys.month,
        createdAt: now,
      },
    });
  }

  async listExpiredPendingStepUps(now: Date): Promise<{ mandateId: string; authorizationId: string }[]> {
    const rows = await this.client.authorization.findMany({
      where: { status: "PENDING_STEP_UP", stepUpExpiresAt: { lte: now } },
      select: { id: true, mandateId: true },
    });
    return rows.map((row) => ({ mandateId: row.mandateId, authorizationId: row.id }));
  }

  async activateMandate(mandateId: string, mandateVersionId: string, ip: string, now: Date): Promise<void> {
    const client = this.client;
    const result = await client.mandateVersion.updateMany({
      where: { id: mandateVersionId, mandateId },
      data: { authenticatedAt: now, authenticationIp: ip },
    });
    if (result.count === 0) {
      throw new Error(`mandate version ${mandateVersionId} does not belong to mandate ${mandateId}`);
    }
    await client.mandate.update({ where: { id: mandateId }, data: { status: "ACTIVE" } });
  }

  /**
   * D-62 (Addition A): rejects a mandate whose `escalation.approvers`
   * would form a cycle with a mandate that already exists -- a mandate
   * naming itself (the degenerate 1-cycle) or two mandates naming each
   * other. Deliberately does not walk the full graph -- a 3+ cycle isn't
   * caught here. See the in-memory repository's own `checkApproverCycle`
   * (identical logic, synchronous there since it reads a local Map) and
   * DECISIONS.md D-62 for why that's an accepted, bounded gap.
   */
  private async checkApproverCycle(mandateId: string, policy: Policy): Promise<void> {
    const approvers = policy.escalation?.approvers ?? [];
    if (approvers.includes(mandateId)) {
      throw new MandateCreationError(
        "DENY_APPROVER_CYCLE",
        "a mandate cannot name itself as its own approver",
      );
    }
    for (const approverId of approvers) {
      const approverMandate = await this.client.mandate.findUnique({
        where: { id: approverId },
        include: { currentVersion: true },
      });
      const approverPolicy = approverMandate?.currentVersion?.policy as unknown as Policy | undefined;
      if (approverPolicy?.escalation?.approvers?.includes(mandateId)) {
        throw new MandateCreationError(
          "DENY_APPROVER_CYCLE",
          `mandate ${approverId} already names this mandate as its own approver, forming a cycle`,
        );
      }
    }
  }

  async createMandate(input: NewMandate, now: Date): Promise<CreatedMandate> {
    const mandateId = input.id ?? generateId(ID_PREFIX.mandate);
    const mandateVersionId = generateId(ID_PREFIX.mandate_version);

    await this.checkApproverCycle(mandateId, input.policy);

    await this.prisma.$transaction(async (tx) => {
      await tx.mandate.create({
        data: {
          id: mandateId,
          organizationId: input.organizationId,
          principalId: input.principalId,
          status: "PENDING_AUTHENTICATION",
          createdAt: now,
        },
      });
      await tx.mandateVersion.create({
        data: {
          id: mandateVersionId,
          mandateId,
          version: 1,
          intentText: input.intentText,
          policy: input.policy as unknown as Prisma.InputJsonValue,
          policyHash: input.policyHash,
          compilerName: input.compilerName,
          compilerModel: input.compilerModel,
          assumptions: input.assumptions,
          authenticatedAt: null,
          createdAt: now,
          agents: { create: input.agentIds.map((agentId) => ({ agentId })) },
        },
      });
      await tx.mandate.update({
        where: { id: mandateId },
        data: { currentVersionId: mandateVersionId },
      });
    });

    return { mandateId, mandateVersionId, policyHash: input.policyHash };
  }

  async getMandateSummary(mandateId: string): Promise<MandateSummary | null> {
    const mandate = await this.client.mandate.findUnique({
      where: { id: mandateId },
      include: { currentVersion: true },
    });
    if (!mandate || !mandate.currentVersion) return null;
    return {
      mandateId: mandate.id,
      mandateVersionId: mandate.currentVersion.id,
      organizationId: mandate.organizationId,
      principalId: mandate.principalId,
      policyHash: mandate.currentVersion.policyHash,
      status: mandate.status,
    };
  }

  async getAuthorization(id: string): Promise<StoredAuthorization | null> {
    const row = await this.client.authorization.findUnique({ where: { id } });
    return row ? toStoredAuthorization(row) : null;
  }

  async createAgent(input: NewAgent, now: Date): Promise<CreatedAgent> {
    const agentId = generateId(ID_PREFIX.agent);
    await this.client.agent.create({
      data: {
        id: agentId,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description ?? null,
        status: "ACTIVE",
        createdAt: now,
      },
    });
    return { agentId, organizationId: input.organizationId, name: input.name, status: "ACTIVE" };
  }

  async recordExecution(input: RecordExecutionInput, now: Date): Promise<StoredAuthorization> {
    const client = this.client;
    const auth = await client.authorization.findUnique({ where: { id: input.authorizationId } });
    if (!auth) throw new Error(`no such authorization: ${input.authorizationId}`);

    // D-71: an authorization is executed against the mandate that issued
    // it, and nothing else. Rejected rather than coerced -- a caller that
    // has the wrong mandate id has a bug, and charging "whichever mandate
    // the row names" would hide it.
    if (auth.mandateId !== input.mandateId) {
      throw new Error(
        `authorization ${input.authorizationId} belongs to mandate ${auth.mandateId}, not ${input.mandateId}`,
      );
    }

    // D-71: an authorization is executable once. A second call returns the
    // recorded outcome rather than throwing, so a retried capture webhook
    // or a retried execute() is idempotent instead of an error the caller
    // has to special-case. The unique index on (mandate_id,
    // authorization_id) WHERE type = 'CAPTURE' is the real control -- this
    // check only keeps the common path quiet.
    if (auth.status === "EXECUTED") return toStoredAuthorization(auth);

    if (auth.status !== "AUTHORIZED" && auth.status !== "STEP_UP_APPROVED") {
      throw new Error(
        `authorization ${input.authorizationId} is not executable (status=${auth.status})`,
      );
    }

    // D-71: scoped to this authorization's own mandate.
    const reservation = await client.ledgerEntry.findFirst({
      where: { mandateId: auth.mandateId, authorizationId: input.authorizationId, type: "RESERVATION" },
    });
    // D-72: both the release and the capture land in the window this
    // authorization was decided in.
    const keys = await this.windowKeysFor(auth, reservation);
    if (reservation) {
      await client.ledgerEntry.create({
        data: {
          id: generateId(ID_PREFIX.evidence),
          organizationId: auth.organizationId,
          mandateId: auth.mandateId,
          authorizationId: input.authorizationId,
          type: "RELEASE",
          amount: -reservation.amount,
          currency: auth.currency,
          dayKey: keys.day,
          weekKey: keys.week,
          monthKey: keys.month,
          createdAt: now,
        },
      });
    }
    await client.ledgerEntry.create({
      data: {
        id: generateId(ID_PREFIX.evidence),
        organizationId: auth.organizationId,
        mandateId: auth.mandateId,
        authorizationId: input.authorizationId,
        type: "CAPTURE",
        amount: auth.amount,
        currency: auth.currency,
        provider: input.provider,
        providerFee: input.providerFee,
        dayKey: keys.day,
        weekKey: keys.week,
        monthKey: keys.month,
        createdAt: now,
      },
    });

    const updated = await client.authorization.update({
      where: { id: input.authorizationId },
      data: { status: "EXECUTED" },
    });
    return toStoredAuthorization(updated);
  }

  /** D-83. See `AuthorizationRepository.settleExternalAuthorization`. */
  async settleExternalAuthorization(
    input: SettleExternalInput,
    now: Date,
  ): Promise<SettlementOutcome> {
    const client = this.client;
    const rows = await client.authorization.findMany({
      where: { mandateId: input.mandateId, externalRef: input.externalRef },
      orderBy: [{ externalRevision: "asc" }, { createdAt: "asc" }],
    });
    if (rows.length === 0) {
      throw new Error(`no authorization recorded for external ref ${input.externalRef}`);
    }

    const latest = rows[rows.length - 1]!;
    if (latest.currency !== input.settledCurrency.toUpperCase()) {
      // No FX in this codebase. Converting silently would be worse than
      // refusing, and refusing is retryable at the webhook layer.
      throw new Error(
        `settled currency ${input.settledCurrency} does not match the authorization's ${latest.currency}`,
      );
    }

    const entries = await client.ledgerEntry.findMany({
      where: {
        mandateId: input.mandateId,
        authorizationId: { in: rows.map((r) => r.id) },
        type: { in: ["RESERVATION", "RELEASE"] },
      },
    });

    // Release each revision's outstanding hold in that revision's own
    // window (D-72), not in the window the settlement happens to arrive in.
    let released = 0;
    for (const row of rows) {
      const mine = entries.filter((e) => e.authorizationId === row.id);
      const outstanding = mine.reduce((sum, e) => sum + e.amount, 0);
      if (outstanding === 0) continue;
      const reservation = mine.find((e) => e.type === "RESERVATION") ?? null;
      const keys = await this.windowKeysFor(row, reservation);
      await client.ledgerEntry.create({
        data: {
          id: generateId(ID_PREFIX.evidence),
          organizationId: row.organizationId,
          mandateId: input.mandateId,
          authorizationId: row.id,
          type: "RELEASE",
          amount: -outstanding,
          currency: row.currency,
          dayKey: keys.day,
          weekKey: keys.week,
          monthKey: keys.month,
          createdAt: now,
        },
      });
      released += outstanding;
    }

    // One CAPTURE, for what actually moved, on the latest revision -- in the
    // window that revision was authorized in.
    if (input.settledAmount > 0) {
      const keys = await this.windowKeysFor(latest, null);
      await client.ledgerEntry.create({
        data: {
          id: generateId(ID_PREFIX.evidence),
          organizationId: latest.organizationId,
          mandateId: input.mandateId,
          authorizationId: latest.id,
          type: "CAPTURE",
          amount: input.settledAmount,
          currency: latest.currency,
          provider: input.provider,
          providerFee: 0,
          dayKey: keys.day,
          weekKey: keys.week,
          monthKey: keys.month,
          createdAt: now,
        },
      });
    }

    await client.authorization.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: "EXECUTED" },
    });

    return {
      released,
      captured: input.settledAmount,
      authorized: released,
      rows: rows.length,
    };
  }

  /** D-83. See `AuthorizationRepository.releaseExternalAuthorization`. */
  async releaseExternalAuthorization(
    mandateId: string,
    externalRef: string,
    _reason: "reversed" | "expired" | "declined",
    now: Date,
  ): Promise<{ released: number; rows: number }> {
    const client = this.client;
    const rows = await client.authorization.findMany({
      where: { mandateId, externalRef },
    });
    if (rows.length === 0) return { released: 0, rows: 0 };

    const entries = await client.ledgerEntry.findMany({
      where: {
        mandateId,
        authorizationId: { in: rows.map((r) => r.id) },
        type: { in: ["RESERVATION", "RELEASE"] },
      },
    });

    let released = 0;
    for (const row of rows) {
      const mine = entries.filter((e) => e.authorizationId === row.id);
      const outstanding = mine.reduce((sum, e) => sum + e.amount, 0);
      if (outstanding === 0) continue;
      const reservation = mine.find((e) => e.type === "RESERVATION") ?? null;
      const keys = await this.windowKeysFor(row, reservation);
      await client.ledgerEntry.create({
        data: {
          id: generateId(ID_PREFIX.evidence),
          organizationId: row.organizationId,
          mandateId,
          authorizationId: row.id,
          type: "RELEASE",
          amount: -outstanding,
          currency: row.currency,
          dayKey: keys.day,
          weekKey: keys.week,
          monthKey: keys.month,
          createdAt: now,
        },
      });
      released += outstanding;
    }

    await client.authorization.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: { in: ["AUTHORIZED", "STEP_UP_APPROVED"] } },
      data: { status: "EXPIRED" },
    });

    return { released, rows: rows.length };
  }

  /** D-84. See `AuthorizationRepository.recordUnauthorizedSettlement`. */
  async recordUnauthorizedSettlement(
    input: UnauthorizedSettlementInput,
    now: Date,
  ): Promise<StoredAuthorization> {
    const merchant = resolveMerchant(input.merchant, this.directory, "rail");
    const action: ProposedAction = {
      amount: input.amount,
      currency: input.currency as ProposedAction["currency"],
      merchant: input.merchant,
      attestations: {},
    };
    // decision DENY, status EXECUTED: what Waysafe would have said, and the
    // fact that the money moved regardless. The ledger CAPTURE rides in the
    // same transaction via `ledgerEntries`.
    return this.saveAuthorization({
      id: generateId(ID_PREFIX.authorization),
      organizationId: input.organizationId,
      actorKind: "instrument",
      agentId: null,
      instrumentId: input.instrumentId,
      principalId: input.principalId,
      mandateId: input.mandateId,
      mandateVersionId: input.mandateVersionId,
      policyHash: input.policyHash,
      decision: "DENY" as Decision,
      status: "EXECUTED",
      reasons: input.reasons,
      action,
      merchant,
      idempotencyKey: null,
      requestHash: null,
      externalRef: input.externalRef,
      externalRevision: null,
      stepUpExpiresAt: null,
      now,
      ledgerEntries: [{ type: "CAPTURE", amount: input.amount }],
    });
  }

  async recordRefund(input: RecordRefundInput, now: Date): Promise<void> {
    const client = this.client;
    const auth = await client.authorization.findUnique({ where: { id: input.authorizationId } });
    if (!auth) throw new Error(`no such authorization: ${input.authorizationId}`);

    // D-72: a credit offsets the charge it reverses, so it belongs in that
    // charge's window. Stamping it with `now` would push a negative row
    // into a window where nothing was ever spent -- the same defect as the
    // cross-boundary release, by a different route. The reservation is
    // gone by the time a refund arrives (released at capture), so this
    // resolves through the authorization's decision window.
    const keys = await this.windowKeysFor(auth, null);

    /**
     * D-82: credit the DELTA over what is already credited, never the
     * provider's cumulative total again.
     *
     * Must run under the mandate lock, and does: both callers take it. Two
     * concurrent refund events for one charge would otherwise each read the
     * same "already credited" figure and both write a full delta.
     */
    const existing = await client.ledgerEntry.findMany({
      where: {
        mandateId: auth.mandateId,
        authorizationId: input.authorizationId,
        type: { in: ["CREDIT", "CAPTURE"] },
      },
      select: { type: true, amount: true },
    });
    const alreadyCredited = existing
      .filter((e) => e.type === "CREDIT")
      .reduce((sum, e) => sum - e.amount, 0);
    const captured = existing
      .filter((e) => e.type === "CAPTURE")
      .reduce((sum, e) => sum + e.amount, 0);

    /**
     * Clamped to what was actually captured, so a provider over-refund
     * cannot drive a window SUM negative -- non-negotiable #6. An
     * over-refund is a real thing (a goodwill credit beyond the charge), and
     * the honest ledger answer is "this authorization's spend is zero", not
     * "this mandate has extra budget". The excess is reported on the
     * evidence event rather than silently absorbed.
     */
    const requested = input.amount - alreadyCredited;
    const delta = Math.max(0, Math.min(requested, captured - alreadyCredited));
    if (delta === 0) return;

    await client.ledgerEntry.create({
      data: {
        id: generateId(ID_PREFIX.evidence),
        organizationId: auth.organizationId,
        mandateId: auth.mandateId,
        authorizationId: input.authorizationId,
        type: "CREDIT",
        amount: -delta,
        currency: auth.currency,
        provider: input.provider,
        dayKey: keys.day,
        weekKey: keys.week,
        monthKey: keys.month,
        createdAt: now,
      },
    });
  }

  async listMandates(organizationId: string, limit: number): Promise<MandateListItem[]> {
    const rows = await this.client.mandate.findMany({
      where: { organizationId },
      include: { currentVersion: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows
      .filter((m) => m.currentVersion)
      .map((m) => {
        const policy = m.currentVersion!.policy as unknown as Policy;
        return {
          mandateId: m.id,
          organizationId: m.organizationId,
          principalId: m.principalId,
          status: m.status,
          policyHash: m.currentVersion!.policyHash,
          summary: policy.summary,
          createdAt: m.createdAt.toISOString(),
        };
      });
  }

  async getMandateDetail(mandateId: string): Promise<MandateDetail | null> {
    const mandate = await this.client.mandate.findUnique({
      where: { id: mandateId },
      include: { currentVersion: { include: { agents: true } } },
    });
    if (!mandate || !mandate.currentVersion) return null;
    const policy = mandate.currentVersion.policy as unknown as Policy;
    return {
      mandateId: mandate.id,
      mandateVersionId: mandate.currentVersion.id,
      organizationId: mandate.organizationId,
      principalId: mandate.principalId,
      status: mandate.status,
      policyHash: mandate.currentVersion.policyHash,
      policy,
      summary: policy.summary,
      intentText: mandate.currentVersion.intentText,
      assumptions: mandate.currentVersion.assumptions,
      agentIds: mandate.currentVersion.agents.map((a) => a.agentId),
      authenticatedAt: mandate.currentVersion.authenticatedAt
        ? mandate.currentVersion.authenticatedAt.toISOString()
        : null,
      authenticationIp: mandate.currentVersion.authenticationIp,
      createdAt: mandate.createdAt.toISOString(),
    };
  }

  async listAuthorizations(
    organizationId: string,
    limit: number,
    agentId?: string | null,
  ): Promise<StoredAuthorization[]> {
    const rows = await this.client.authorization.findMany({
      // D-78: an agent credential sees only its own.
      where: agentId ? { organizationId, agentId } : { organizationId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toStoredAuthorization);
  }

  async listAgents(organizationId: string): Promise<AgentListItem[]> {
    const rows = await this.client.agent.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((a) => ({
      agentId: a.id,
      organizationId: a.organizationId,
      name: a.name,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  // --- Internal --------------------------------------------------------------

  private async timezoneFor(mandateId: string): Promise<string> {
    const mandate = await this.client.mandate.findUnique({
      where: { id: mandateId },
      select: { currentVersion: { select: { policy: true } } },
    });
    const policy = mandate?.currentVersion?.policy as unknown as Policy | undefined;
    return policy?.accounting.timezone ?? "UTC";
  }

  private async seenMerchants(mandateId: string): Promise<ReadonlySet<string>> {
    const rows = await this.client.authorization.findMany({
      where: { mandateId, status: { in: SETTLED_STATUSES } },
      select: { merchant: true },
    });
    const seen = new Set<string>();
    for (const row of rows) {
      const merchant = row.merchant as unknown as ResolvedMerchant;
      // D-69: only identifiers that themselves verified. Rows written before
      // D-69 have refs with no `trust` field at all, so they contribute
      // nothing here and a first-use step-up may fire once more per merchant
      // than it strictly needed to -- the conservative direction, and not
      // worth a backfill.
      for (const key of verifiedMerchantKeys(merchant)) seen.add(key);
    }
    return seen;
  }
}

function reason(code: ReasonCode, message: string): Reason {
  return { code, message };
}

interface AuthorizationRow {
  id: string;
  organizationId: string;
  actorKind: string;
  agentId: string | null;
  instrumentId: string | null;
  principalId: string;
  mandateId: string;
  mandateVersionId: string;
  policyHash: string;
  decision: string;
  status: string;
  reasons: Prisma.JsonValue;
  action: Prisma.JsonValue;
  merchant: Prisma.JsonValue;
  idempotencyKey: string | null;
  requestHash: string | null;
  externalRef: string | null;
  externalRevision: number | null;
  stepUpExpiresAt: Date | null;
  createdAt: Date;
  decidedAt: Date;
}

function toStoredAuthorization(row: AuthorizationRow): StoredAuthorization {
  return {
    id: row.id,
    organization_id: row.organizationId,
    actor_kind: row.actorKind as ActorKind,
    agent_id: row.agentId,
    instrument_id: row.instrumentId,
    principal_id: row.principalId,
    mandate_id: row.mandateId,
    mandate_version_id: row.mandateVersionId,
    policy_hash: row.policyHash,
    decision: row.decision as Decision,
    status: row.status as AuthorizationStatus,
    reasons: row.reasons as unknown as Reason[],
    action: row.action as unknown as ProposedAction,
    merchant: row.merchant as unknown as ResolvedMerchant,
    idempotency_key: row.idempotencyKey,
    request_hash: row.requestHash,
    external_ref: row.externalRef,
    external_revision: row.externalRevision ?? null,
    step_up_expires_at: row.stepUpExpiresAt ? row.stepUpExpiresAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    decided_at: row.decidedAt.toISOString(),
  };
}
