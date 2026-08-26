/**
 * In-process fake `AuthorizationRepository`.
 *
 * This is the only repository this session's tests run against, per the
 * team's call on OQ-DB: no Postgres or Docker is available here, so real
 * persistence and the row-lock concurrency proof are deferred. See
 * DECISIONS.md D-15 for exactly what this does and does not prove.
 *
 * The mandate lock is a real per-mandate async mutex — a chain of promises,
 * not a flag — so two concurrent `withMandateLock` calls for the same
 * mandate genuinely run back-to-back, in FIFO order. That is a faithful
 * simulation of "the mandate row is locked", not just an assertion of it.
 */

import {
  ID_PREFIX,
  generateId,
  merchantRefKey,
  windowKeys,
  type Accounting,
  type AgentStatus,
  type MandateStatus,
  type MerchantDirectory,
  type Policy,
  type ProposedAction,
  type ReasonCode,
  type ResolvedMerchant,
  type SpendSnapshot,
} from "@bles/core";
import type {
  AgentListItem,
  AuthorizationRepository,
  CreatedAgent,
  CreatedMandate,
  LedgerEntryType,
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
import { Mutex } from "../util/mutex.js";

interface AgentRow {
  id: string;
  organizationId: string;
  status: AgentStatus;
  name: string;
  createdAt: Date;
}

interface MandateVersionRow {
  id: string;
  policy: Policy;
  policyHash: string;
  authenticatedAt: Date | null;
  agentIds: string[];
  intentText: string;
  assumptions: string[];
  createdAt: Date;
}

interface MandateRow {
  id: string;
  organizationId: string;
  principalId: string;
  status: MandateStatus;
  currentVersion: MandateVersionRow;
  createdAt: Date;
}

interface LedgerEntryRow {
  id: string;
  mandateId: string;
  authorizationId: string;
  type: LedgerEntryType;
  amount: number;
  dayKey: string;
  weekKey: string;
  monthKey: string;
  provider?: string;
  providerFee?: number;
  createdAt: Date;
}

interface AuthorizationRow extends StoredAuthorization {
  organizationId: string;
}

export interface SeedMandateInput {
  mandateId?: string;
  organizationId: string;
  principalId: string;
  agentId: string;
  policy: Policy;
  policyHash: string;
  status?: MandateStatus;
  authenticatedAt?: Date | null;
  agentStatus?: AgentStatus;
  boundAgentIds?: string[];
}

export interface SeededMandate {
  mandateId: string;
  mandateVersionId: string;
  policyHash: string;
}

export class InMemoryAuthorizationRepository implements AuthorizationRepository {
  private readonly mandates = new Map<string, MandateRow>();
  private readonly agents = new Map<string, AgentRow>();
  private readonly ledgerByMandate = new Map<string, LedgerEntryRow[]>();
  private readonly authorizations = new Map<string, AuthorizationRow>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly locks = new Map<string, Mutex>();
  private directory: MerchantDirectory;

  constructor(directory: MerchantDirectory) {
    this.directory = directory;
  }

  // --- Test/seeding surface -------------------------------------------------

  seedMandate(input: SeedMandateInput): SeededMandate {
    const mandateId = input.mandateId ?? generateId(ID_PREFIX.mandate);
    const mandateVersionId = generateId(ID_PREFIX.mandate_version);
    const agentIds = input.boundAgentIds ?? [input.agentId];

    if (!this.agents.has(input.agentId)) {
      this.agents.set(input.agentId, {
        id: input.agentId,
        organizationId: input.organizationId,
        status: input.agentStatus ?? "ACTIVE",
        name: "Test Agent",
        createdAt: new Date(),
      });
    }

    this.mandates.set(mandateId, {
      id: mandateId,
      organizationId: input.organizationId,
      principalId: input.principalId,
      status: input.status ?? "ACTIVE",
      createdAt: new Date(),
      currentVersion: {
        id: mandateVersionId,
        policy: input.policy,
        policyHash: input.policyHash,
        authenticatedAt: input.authenticatedAt === undefined ? new Date() : input.authenticatedAt,
        agentIds,
        intentText: "seeded for testing",
        assumptions: [],
        createdAt: new Date(),
      },
    });

    return { mandateId, mandateVersionId, policyHash: input.policyHash };
  }

  authorizationsFor(mandateId: string): StoredAuthorization[] {
    return [...this.authorizations.values()].filter((a) => a.mandate_id === mandateId);
  }

  ledgerEntriesFor(mandateId: string): LedgerEntryRow[] {
    return [...(this.ledgerByMandate.get(mandateId) ?? [])];
  }

  // --- AuthorizationRepository -----------------------------------------------

  getMerchantDirectory(): MerchantDirectory {
    return this.directory;
  }

  async resolveMandateGate(input: ResolveMandateInput): Promise<MandateGateResult> {
    const mandate = input.mandateId
      ? this.mandates.get(input.mandateId)
      : this.findActiveMandate(input.organizationId, input.principalId, input.agentId);

    if (!mandate || mandate.organizationId !== input.organizationId) {
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

    const statusCode: Partial<Record<MandateStatus, ReasonCode>> = {
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

    const agent = this.agents.get(input.agentId);
    if (
      !agent ||
      agent.organizationId !== input.organizationId ||
      !mandate.currentVersion.agentIds.includes(input.agentId)
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
      policy: mandate.currentVersion.policy,
      policyHash: mandate.currentVersion.policyHash,
    };
  }

  async getSpendSnapshot(
    mandateId: string,
    accounting: Accounting,
    now: Date,
  ): Promise<SpendSnapshot> {
    const keys = windowKeys(now, accounting.timezone);
    const entries = this.ledgerByMandate.get(mandateId) ?? [];

    const sumWhere = (matches: (e: LedgerEntryRow) => boolean) => {
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
      seenMerchants: this.seenMerchants(mandateId),
    };
  }

  async findByIdempotencyKey(
    organizationId: string,
    key: string,
  ): Promise<StoredAuthorization | null> {
    const id = this.idempotencyIndex.get(`${organizationId}:${key}`);
    if (!id) return null;
    return this.authorizations.get(id) ?? null;
  }

  async withMandateLock<T>(mandateId: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.locks.get(mandateId);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(mandateId, mutex);
    }
    return mutex.run(fn);
  }

  async saveAuthorization(input: SaveAuthorizationInput): Promise<StoredAuthorization> {
    if (input.idempotencyKey) {
      const existing = this.idempotencyIndex.get(`${input.organizationId}:${input.idempotencyKey}`);
      if (existing) {
        throw new Error(
          `idempotency key already claimed by authorization ${existing}; caller must check findByIdempotencyKey first`,
        );
      }
      // Claimed synchronously, before any await below, so no concurrent
      // saveAuthorization call for the same org+key can race this check.
      this.idempotencyIndex.set(`${input.organizationId}:${input.idempotencyKey}`, input.id);
    }

    const mandate = this.mandates.get(input.mandateId);
    const timezone = mandate?.currentVersion.policy.accounting.timezone ?? "UTC";
    const keys = windowKeys(input.now, timezone);

    const rows = this.ledgerByMandate.get(input.mandateId) ?? [];
    for (const entry of input.ledgerEntries) {
      rows.push({
        id: generateId(ID_PREFIX.evidence),
        mandateId: input.mandateId,
        authorizationId: input.id,
        type: entry.type,
        amount: entry.amount,
        dayKey: keys.day,
        weekKey: keys.week,
        monthKey: keys.month,
        createdAt: input.now,
      });
    }
    this.ledgerByMandate.set(input.mandateId, rows);

    const row: AuthorizationRow = {
      id: input.id,
      organizationId: input.organizationId,
      organization_id: input.organizationId,
      agent_id: input.agentId,
      principal_id: input.principalId,
      mandate_id: input.mandateId,
      mandate_version_id: input.mandateVersionId,
      policy_hash: input.policyHash,
      decision: input.decision,
      status: input.status,
      reasons: input.reasons,
      action: input.action,
      merchant: input.merchant,
      idempotency_key: input.idempotencyKey,
      request_hash: input.requestHash,
      step_up_expires_at: input.stepUpExpiresAt?.toISOString() ?? null,
      created_at: input.now.toISOString(),
      decided_at: input.now.toISOString(),
    };
    this.authorizations.set(input.id, row);
    return row;
  }

  async resolveStepUp(
    mandateId: string,
    authorizationId: string,
    outcome: "approved" | "declined" | "expired",
    now: Date,
  ): Promise<StoredAuthorization> {
    const auth = this.authorizations.get(authorizationId);
    if (!auth) throw new Error(`no such authorization: ${authorizationId}`);
    if (auth.status !== "PENDING_STEP_UP") {
      throw new Error(
        `authorization ${authorizationId} is not pending step-up (status=${auth.status})`,
      );
    }

    if (outcome === "approved") {
      auth.status = "STEP_UP_APPROVED";
      return auth;
    }

    const entries = this.ledgerByMandate.get(mandateId) ?? [];
    const reservation = entries.find(
      (e) => e.authorizationId === authorizationId && e.type === "RESERVATION",
    );
    if (reservation) {
      const mandate = this.mandates.get(mandateId);
      const timezone = mandate?.currentVersion.policy.accounting.timezone ?? "UTC";
      const keys = windowKeys(now, timezone);
      entries.push({
        id: generateId(ID_PREFIX.evidence),
        mandateId,
        authorizationId,
        type: "RELEASE",
        amount: -reservation.amount,
        dayKey: keys.day,
        weekKey: keys.week,
        monthKey: keys.month,
        createdAt: now,
      });
      this.ledgerByMandate.set(mandateId, entries);
    }

    auth.status = outcome === "declined" ? "STEP_UP_DECLINED" : "EXPIRED";
    return auth;
  }

  async activateMandate(mandateId: string, mandateVersionId: string, now: Date): Promise<void> {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) throw new Error(`no such mandate: ${mandateId}`);
    if (mandate.currentVersion.id !== mandateVersionId) {
      throw new Error(
        `mandate ${mandateId}'s current version is ${mandate.currentVersion.id}, not ${mandateVersionId}`,
      );
    }
    mandate.currentVersion.authenticatedAt = now;
    mandate.status = "ACTIVE";
  }

  async createMandate(input: NewMandate, now: Date): Promise<CreatedMandate> {
    for (const agentId of input.agentIds) {
      const agent = this.agents.get(agentId);
      if (!agent || agent.organizationId !== input.organizationId) {
        throw new Error(`no such agent in this organization: ${agentId}`);
      }
    }

    const mandateId = generateId(ID_PREFIX.mandate);
    const mandateVersionId = generateId(ID_PREFIX.mandate_version);

    this.mandates.set(mandateId, {
      id: mandateId,
      organizationId: input.organizationId,
      principalId: input.principalId,
      status: "PENDING_AUTHENTICATION",
      createdAt: now,
      currentVersion: {
        id: mandateVersionId,
        policy: input.policy,
        policyHash: input.policyHash,
        authenticatedAt: null,
        agentIds: input.agentIds,
        intentText: input.intentText,
        assumptions: input.assumptions,
        createdAt: now,
      },
    });

    return { mandateId, mandateVersionId, policyHash: input.policyHash };
  }

  async getMandateSummary(mandateId: string): Promise<MandateSummary | null> {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) return null;
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
    return this.authorizations.get(id) ?? null;
  }

  async createAgent(input: NewAgent, now: Date): Promise<CreatedAgent> {
    const agentId = generateId(ID_PREFIX.agent);
    this.agents.set(agentId, {
      id: agentId,
      organizationId: input.organizationId,
      status: "ACTIVE",
      name: input.name,
      createdAt: now,
    });
    return { agentId, organizationId: input.organizationId, name: input.name, status: "ACTIVE" };
  }

  async recordExecution(input: RecordExecutionInput, now: Date): Promise<StoredAuthorization> {
    const auth = this.authorizations.get(input.authorizationId);
    if (!auth) throw new Error(`no such authorization: ${input.authorizationId}`);
    if (auth.status !== "AUTHORIZED" && auth.status !== "STEP_UP_APPROVED") {
      throw new Error(
        `authorization ${input.authorizationId} is not executable (status=${auth.status})`,
      );
    }

    const mandate = this.mandates.get(auth.mandate_id);
    const timezone = mandate?.currentVersion.policy.accounting.timezone ?? "UTC";
    const keys = windowKeys(now, timezone);

    const entries = this.ledgerByMandate.get(auth.mandate_id) ?? [];
    const reservation = entries.find(
      (e) => e.authorizationId === input.authorizationId && e.type === "RESERVATION",
    );
    if (reservation) {
      entries.push({
        id: generateId(ID_PREFIX.evidence),
        mandateId: auth.mandate_id,
        authorizationId: input.authorizationId,
        type: "RELEASE",
        amount: -reservation.amount,
        dayKey: keys.day,
        weekKey: keys.week,
        monthKey: keys.month,
        createdAt: now,
      });
    }
    entries.push({
      id: generateId(ID_PREFIX.evidence),
      mandateId: auth.mandate_id,
      authorizationId: input.authorizationId,
      type: "CAPTURE",
      amount: auth.action.amount,
      provider: input.provider,
      providerFee: input.providerFee,
      dayKey: keys.day,
      weekKey: keys.week,
      monthKey: keys.month,
      createdAt: now,
    });
    this.ledgerByMandate.set(auth.mandate_id, entries);

    auth.status = "EXECUTED";
    return auth;
  }

  async recordRefund(input: RecordRefundInput, now: Date): Promise<void> {
    const auth = this.authorizations.get(input.authorizationId);
    if (!auth) throw new Error(`no such authorization: ${input.authorizationId}`);

    const mandate = this.mandates.get(auth.mandate_id);
    const timezone = mandate?.currentVersion.policy.accounting.timezone ?? "UTC";
    const keys = windowKeys(now, timezone);

    const entries = this.ledgerByMandate.get(auth.mandate_id) ?? [];
    entries.push({
      id: generateId(ID_PREFIX.evidence),
      mandateId: auth.mandate_id,
      authorizationId: input.authorizationId,
      type: "CREDIT",
      amount: -input.amount,
      provider: input.provider,
      dayKey: keys.day,
      weekKey: keys.week,
      monthKey: keys.month,
      createdAt: now,
    });
    this.ledgerByMandate.set(auth.mandate_id, entries);
  }

  async listMandates(organizationId: string, limit: number): Promise<MandateListItem[]> {
    return [...this.mandates.values()]
      .filter((m) => m.organizationId === organizationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((m) => ({
        mandateId: m.id,
        organizationId: m.organizationId,
        principalId: m.principalId,
        status: m.status,
        policyHash: m.currentVersion.policyHash,
        summary: m.currentVersion.policy.summary,
        createdAt: m.createdAt.toISOString(),
      }));
  }

  async getMandateDetail(mandateId: string): Promise<MandateDetail | null> {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) return null;
    return {
      mandateId: mandate.id,
      mandateVersionId: mandate.currentVersion.id,
      organizationId: mandate.organizationId,
      principalId: mandate.principalId,
      status: mandate.status,
      policyHash: mandate.currentVersion.policyHash,
      policy: mandate.currentVersion.policy,
      summary: mandate.currentVersion.policy.summary,
      intentText: mandate.currentVersion.intentText,
      assumptions: mandate.currentVersion.assumptions,
      agentIds: mandate.currentVersion.agentIds,
      authenticatedAt: mandate.currentVersion.authenticatedAt?.toISOString() ?? null,
      createdAt: mandate.createdAt.toISOString(),
    };
  }

  async listAuthorizations(organizationId: string, limit: number): Promise<StoredAuthorization[]> {
    return [...this.authorizations.values()]
      .filter((a) => a.organizationId === organizationId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
  }

  async listAgents(organizationId: string): Promise<AgentListItem[]> {
    return [...this.agents.values()]
      .filter((a) => a.organizationId === organizationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((a) => ({
        agentId: a.id,
        organizationId: a.organizationId,
        name: a.name,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
      }));
  }

  // --- Internal --------------------------------------------------------------

  private findActiveMandate(
    organizationId: string,
    principalId: string,
    agentId: string,
  ): MandateRow | undefined {
    for (const mandate of this.mandates.values()) {
      if (mandate.organizationId !== organizationId) continue;
      if (mandate.principalId !== principalId) continue;
      if (mandate.status !== "ACTIVE") continue;
      if (!mandate.currentVersion.agentIds.includes(agentId)) continue;
      return mandate;
    }
    return undefined;
  }

  private seenMerchants(mandateId: string): ReadonlySet<string> {
    const seen = new Set<string>();
    const settled: StoredAuthorization["status"][] = [
      "AUTHORIZED",
      "STEP_UP_APPROVED",
      "EXECUTED",
    ];
    for (const auth of this.authorizations.values()) {
      if (auth.mandate_id !== mandateId) continue;
      if (!settled.includes(auth.status)) continue;
      if (auth.merchant.trust !== "VERIFIED") continue;
      for (const ref of auth.merchant.refs) seen.add(merchantRefKey(ref));
    }
    return seen;
  }
}

function reason(code: ReasonCode, message: string) {
  return { code, message };
}
