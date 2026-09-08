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

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  ID_PREFIX,
  MerchantTrust,
  generateId,
  merchantRefKey,
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
import type {
  AgentListItem,
  AuthorizationRepository,
  CreatedAgent,
  CreatedMandate,
  MandateDetail,
  MandateGateResult,
  MandateListItem,
  MandateSummary,
  NewAgent,
  NewMandate,
  RecordExecutionInput,
  RecordRefundInput,
  ResolveMandateInput,
  SaveAuthorizationInput,
  StoredAuthorization,
} from "./types.js";
import { assertValidActor } from "./actor.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Holds the active locked transaction for the lifetime of a `withMandateLock` callback. */
const mandateLockContext = new AsyncLocalStorage<Prisma.TransactionClient>();

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
    const row = await this.client.authorization.findFirst({ where: { externalRef } });
    return row ? toStoredAuthorization(row) : null;
  }

  async withMandateLock<T>(mandateId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      if (!this.disableLockForTesting) {
        await tx.$queryRaw`SELECT id FROM mandates WHERE id = ${mandateId} FOR UPDATE`;
      }
      return mandateLockContext.run(tx, fn);
    }, TRANSACTION_OPTIONS);
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
        throw new Error(
          `idempotency key already claimed; caller must check findByIdempotencyKey first`,
        );
      }
      throw err;
    }
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

    const reservation = await client.ledgerEntry.findFirst({
      where: { authorizationId, type: "RESERVATION" },
    });
    if (reservation) {
      const timezone = await this.timezoneFor(mandateId);
      const keys = windowKeys(now, timezone);
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

  async listExpiredPendingStepUps(now: Date): Promise<{ mandateId: string; authorizationId: string }[]> {
    const rows = await this.client.authorization.findMany({
      where: { status: "PENDING_STEP_UP", stepUpExpiresAt: { lte: now } },
      select: { id: true, mandateId: true },
    });
    return rows.map((row) => ({ mandateId: row.mandateId, authorizationId: row.id }));
  }

  async activateMandate(mandateId: string, mandateVersionId: string, now: Date): Promise<void> {
    const client = this.client;
    const result = await client.mandateVersion.updateMany({
      where: { id: mandateVersionId, mandateId },
      data: { authenticatedAt: now },
    });
    if (result.count === 0) {
      throw new Error(`mandate version ${mandateVersionId} does not belong to mandate ${mandateId}`);
    }
    await client.mandate.update({ where: { id: mandateId }, data: { status: "ACTIVE" } });
  }

  async createMandate(input: NewMandate, now: Date): Promise<CreatedMandate> {
    const mandateId = generateId(ID_PREFIX.mandate);
    const mandateVersionId = generateId(ID_PREFIX.mandate_version);

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
    if (auth.status !== "AUTHORIZED" && auth.status !== "STEP_UP_APPROVED") {
      throw new Error(
        `authorization ${input.authorizationId} is not executable (status=${auth.status})`,
      );
    }

    const timezone = await this.timezoneFor(auth.mandateId);
    const keys = windowKeys(now, timezone);

    const reservation = await client.ledgerEntry.findFirst({
      where: { authorizationId: input.authorizationId, type: "RESERVATION" },
    });
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

  async recordRefund(input: RecordRefundInput, now: Date): Promise<void> {
    const client = this.client;
    const auth = await client.authorization.findUnique({ where: { id: input.authorizationId } });
    if (!auth) throw new Error(`no such authorization: ${input.authorizationId}`);

    const timezone = await this.timezoneFor(auth.mandateId);
    const keys = windowKeys(now, timezone);

    await client.ledgerEntry.create({
      data: {
        id: generateId(ID_PREFIX.evidence),
        organizationId: auth.organizationId,
        mandateId: auth.mandateId,
        authorizationId: input.authorizationId,
        type: "CREDIT",
        amount: -input.amount,
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
      createdAt: mandate.createdAt.toISOString(),
    };
  }

  async listAuthorizations(organizationId: string, limit: number): Promise<StoredAuthorization[]> {
    const rows = await this.client.authorization.findMany({
      where: { organizationId },
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
      if (merchant.trust !== MerchantTrust.VERIFIED) continue;
      for (const ref of merchant.refs) seen.add(merchantRefKey(ref));
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
    step_up_expires_at: row.stepUpExpiresAt ? row.stepUpExpiresAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    decided_at: row.decidedAt.toISOString(),
  };
}
