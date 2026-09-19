/**
 * The authorization service: the one place that turns a proposed action into
 * a persisted decision.
 *
 * This is where the actor-state gate (mandate active? authenticated? agent
 * bound and not suspended? principal matches?) runs, ahead of the pure
 * `evaluate()` engine — see DECISIONS.md D-13 for why that split exists.
 * Agent API key verification (D-18) runs alongside it, also ahead of
 * `evaluate()`: an agent whose key is missing, forged, or revoked never
 * reaches the engine, and the refusal is persisted as an ordinary DENY with
 * a reason code -- not a bare HTTP 401 from some other layer that the
 * service itself never sees. Then, under a per-mandate lock (D-4), it reads
 * the spend snapshot, resolves the merchant, calls `evaluate()`, and
 * persists the decision plus any ledger entries in one atomic step. No LLM
 * call anywhere on this path.
 *
 * Every `resolveMerchant` call below passes `"agent"` (D-34): the merchant on
 * `request.action` is whatever the caller of `authorize()` asserted, the
 * same untrusted party a bare `name` claim already can't come from -- a
 * `psp_account` or `network_mid` here is exactly as unverified as a `name`
 * would be, and caps at ASSERTED accordingly. Only a rail's own callback
 * (apps/api/src/enforcement/*.ts) is ever entitled to pass `"rail"`.
 */

import {
  Decision,
  ID_PREFIX,
  ReasonCode,
  evaluate,
  generateId,
  resolveMerchant,
  type AuthorizationRequest,
  type AuthorizationStatus,
  type Reason,
} from "@waysafe/core";
import { extractKeyPrefix } from "../agent-keys/keys.js";
import type { AgentKeyRepository } from "../agent-keys/types.js";
import type { EvidenceRepository } from "../evidence/types.js";
import { hashAuthorizationRequest } from "./idempotency.js";
import type { AuthorizationRepository, NewLedgerEntry, StoredAuthorization } from "./types.js";

export type AuthorizeResult =
  | { kind: "decided"; authorization: StoredAuthorization; replayed: boolean }
  | { kind: "idempotency_conflict"; existing: StoredAuthorization }
  | { kind: "no_mandate"; reasons: Reason[] };

export interface AuthorizeRepos {
  authorization: AuthorizationRepository;
  agentKeys: AgentKeyRepository;
  evidence: EvidenceRepository;
}

export interface AuthorizeParams {
  organizationId: string;
  request: AuthorizationRequest;
  now: Date;
  /**
   * The agent's presented API key. D-18: this, not `request.agent_id`
   * alone, is the source of truth for agent identity -- the two must agree
   * or the request is rejected before `evaluate()` is ever called.
   */
  apiKey: string;
  id?: string; // injectable for deterministic tests
}

export async function authorize(
  repos: AuthorizeRepos,
  params: AuthorizeParams,
): Promise<AuthorizeResult> {
  const { organizationId, request, now, apiKey } = params;
  const { authorization: repo, agentKeys, evidence } = repos;
  const requestHash = hashAuthorizationRequest(request);

  if (request.idempotency_key) {
    const existing = await repo.findByIdempotencyKey(organizationId, request.idempotency_key);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        return { kind: "idempotency_conflict", existing };
      }
      return { kind: "decided", authorization: existing, replayed: true };
    }
  }

  const gate = await repo.resolveMandateGate({
    organizationId,
    agentId: request.agent_id,
    principalId: request.principal_id,
    mandateId: request.mandate_id,
  });

  // Runs regardless of the gate's outcome, and unconditionally records an
  // EvidenceEvent -- success or failure -- under the organization's chain.
  const keyCheck = await verifyAgentKey(agentKeys, evidence, {
    organizationId,
    claimedAgentId: request.agent_id,
    apiKey,
    now,
  });

  if (!gate.ok) {
    if (!gate.mandateId) {
      // No real mandate row to attach this DENY to -- nothing to persist.
      return { kind: "no_mandate", reasons: gate.reasons };
    }
    // A real mandate exists but failed the gate (revoked, expired, unauthenticated,
    // agent suspended/unbound, principal mismatch) -- persist it like any other DENY,
    // still serialized by the mandate lock since it shares the mandate's ledger.
    // A credential problem takes precedence in the reasons shown: knowing
    // *who* rejected the request matters more than every other reason the
    // mandate itself might also currently be unusable for.
    return repo.withMandateLock(gate.mandateId, async () => {
      const authorization = await repo.saveAuthorization({
        id: params.id ?? generateId(ID_PREFIX.authorization),
        organizationId,
        actorKind: "agent",
        agentId: request.agent_id,
        instrumentId: null,
        principalId: request.principal_id,
        mandateId: gate.mandateId!,
        mandateVersionId: gate.mandateVersionId ?? "",
        policyHash: gate.policyHash ?? "",
        decision: Decision.DENY,
        status: "DENIED",
        reasons: keyCheck.ok ? gate.reasons : keyCheck.reasons,
        action: request.action,
        merchant: resolveMerchant(request.action.merchant, repo.getMerchantDirectory(), "agent"),
        idempotencyKey: request.idempotency_key ?? null,
        requestHash,
        stepUpExpiresAt: null,
        now,
        ledgerEntries: [],
      });
      return { kind: "decided", authorization, replayed: false } as const;
    });
  }

  // gate.ok === true from here on.

  if (!keyCheck.ok) {
    // Mandate is otherwise fine; the credential presented for it isn't.
    // Same treatment as the branch above -- persisted DENY, mandate lock,
    // no ledger entries -- just without a gate failure to also carry.
    return repo.withMandateLock(gate.mandateId, async () => {
      const authorization = await repo.saveAuthorization({
        id: params.id ?? generateId(ID_PREFIX.authorization),
        organizationId,
        actorKind: "agent",
        agentId: request.agent_id,
        instrumentId: null,
        principalId: request.principal_id,
        mandateId: gate.mandateId,
        mandateVersionId: gate.mandateVersionId,
        policyHash: gate.policyHash,
        decision: Decision.DENY,
        status: "DENIED",
        reasons: keyCheck.reasons,
        action: request.action,
        merchant: resolveMerchant(request.action.merchant, repo.getMerchantDirectory(), "agent"),
        idempotencyKey: request.idempotency_key ?? null,
        requestHash,
        stepUpExpiresAt: null,
        now,
        ledgerEntries: [],
      });
      return { kind: "decided", authorization, replayed: false } as const;
    });
  }

  return repo.withMandateLock(gate.mandateId, async () => {
    // Idempotency is checked once more inside the lock: two concurrent requests
    // with the same key for the same mandate must not both win the race above.
    if (request.idempotency_key) {
      const existing = await repo.findByIdempotencyKey(organizationId, request.idempotency_key);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          return { kind: "idempotency_conflict", existing } as const;
        }
        return { kind: "decided", authorization: existing, replayed: true } as const;
      }
    }

    const merchant = resolveMerchant(request.action.merchant, repo.getMerchantDirectory(), "agent");
    const spend = await repo.getSpendSnapshot(gate.mandateId, gate.policy.accounting, now);
    const result = evaluate({ policy: gate.policy, action: request.action, merchant, spend, now });

    const status = statusForDecision(result.decision);
    const ledgerEntries: NewLedgerEntry[] = shouldReserve(
      result.decision,
      gate.policy.accounting.reserve_on_step_up,
    )
      ? [{ type: "RESERVATION", amount: request.action.amount }]
      : [];

    const stepUpExpiresAt =
      result.decision === Decision.STEP_UP
        ? new Date(now.getTime() + gate.policy.step_up.ttl_seconds * 1000)
        : null;

    const authorization = await repo.saveAuthorization({
      id: params.id ?? generateId(ID_PREFIX.authorization),
      organizationId,
      actorKind: "agent",
      agentId: request.agent_id,
      instrumentId: null,
      principalId: request.principal_id,
      mandateId: gate.mandateId,
      mandateVersionId: gate.mandateVersionId,
      policyHash: gate.policyHash,
      decision: result.decision,
      status,
      reasons: result.reasons,
      action: request.action,
      merchant,
      idempotencyKey: request.idempotency_key ?? null,
      requestHash,
      stepUpExpiresAt,
      now,
      ledgerEntries,
    });

    return { kind: "decided", authorization, replayed: false } as const;
  });
}

function statusForDecision(decision: Decision): AuthorizationStatus {
  if (decision === Decision.ALLOW) return "AUTHORIZED";
  if (decision === Decision.DENY) return "DENIED";
  return "PENDING_STEP_UP";
}

function shouldReserve(decision: Decision, reserveOnStepUp: boolean): boolean {
  if (decision === Decision.ALLOW) return true;
  if (decision === Decision.STEP_UP) return reserveOnStepUp;
  return false;
}

/** Answer (approve/decline) or expire a pending step-up. Releases any reservation on decline/expiry. */
export async function resolveStepUp(
  repo: AuthorizationRepository,
  mandateId: string,
  authorizationId: string,
  outcome: "approved" | "declined" | "expired",
  now: Date,
): Promise<StoredAuthorization> {
  return repo.withMandateLock(mandateId, () =>
    repo.resolveStepUp(mandateId, authorizationId, outcome, now),
  );
}

/**
 * One pass of the expiry worker (D-31/OQ-6): every step-up past its TTL,
 * across every organization, expired the same way `resolveStepUp` always
 * has. Exists alongside `resolveStepUp` rather than in `worker.ts` itself
 * so it can be unit-tested without importing a file whose only other job
 * is to run forever.
 */
export async function sweepExpiredStepUps(repo: AuthorizationRepository, now: Date): Promise<number> {
  const expired = await repo.listExpiredPendingStepUps(now);
  for (const { mandateId, authorizationId } of expired) {
    // Another sweep, or a request that happened to touch this same
    // authorization first (server.ts's expireIfNeeded), may have already
    // resolved it between the list above and this call -- resolveStepUp
    // throws if the row is no longer PENDING_STEP_UP by the time its lock
    // is acquired. Losing that race is expected, the same way two HTTP
    // requests racing for the same resource is expected, not a bug.
    try {
      await resolveStepUp(repo, mandateId, authorizationId, "expired", now);
    } catch (err) {
      console.error(`failed to expire step-up ${authorizationId} on mandate ${mandateId}:`, err);
    }
  }
  return expired.length;
}

/**
 * D-62: resolves a `needs-higher-authority` step-up as an approver mandate.
 * Closes D-59 -- the endpoint no longer accepts a bare `{outcome}` from
 * any credential in the organization; it re-runs the real `evaluate()`
 * engine against a *different*, authorized mandate.
 *
 * `stepUp` must already be the fresh, `PENDING_STEP_UP` authorization
 * (the caller -- server.ts -- runs `expireIfNeeded` first, same as
 * before). `"rejected"` means the resolve *attempt* was refused (bad
 * credential, self-approval, not an approver) and the step-up itself is
 * untouched -- a legitimate approver can still resolve it before TTL.
 * `"resolved"` means a real rule-3/4 outcome (or a replay of one that a
 * concurrent request already produced) consumed the step-up.
 */
export interface ResolveStepUpAsApproverParams {
  organizationId: string;
  stepUp: StoredAuthorization;
  approverAgentId: string;
  approverPrincipalId: string;
  approverMandateId?: string;
  apiKey: string;
  idempotencyKey?: string;
  now: Date;
}

export type ResolveStepUpAsApproverResult =
  | { kind: "resolved"; authorization: StoredAuthorization }
  | { kind: "rejected"; reasons: Reason[] };

export async function resolveStepUpAsApprover(
  repos: AuthorizeRepos,
  params: ResolveStepUpAsApproverParams,
): Promise<ResolveStepUpAsApproverResult> {
  const { authorization: repo, agentKeys, evidence } = repos;
  const { organizationId, stepUp, approverAgentId, approverPrincipalId, approverMandateId, apiKey, now } =
    params;

  const keyCheck = await verifyAgentKey(agentKeys, evidence, {
    organizationId,
    claimedAgentId: approverAgentId,
    apiKey,
    now,
  });
  if (!keyCheck.ok) {
    await writeStepUpEvidence(evidence, {
      organizationId,
      type: "step_up.resolution_rejected",
      authorizationId: stepUp.id,
      originalMandateId: stepUp.mandate_id,
      reasons: keyCheck.reasons,
      idempotencyKey: params.idempotencyKey,
      now,
    });
    return { kind: "rejected", reasons: keyCheck.reasons };
  }

  const gate = await repo.resolveMandateGate({
    organizationId,
    agentId: approverAgentId,
    principalId: approverPrincipalId,
    mandateId: approverMandateId,
  });
  if (!gate.ok) {
    await writeStepUpEvidence(evidence, {
      organizationId,
      type: "step_up.resolution_rejected",
      authorizationId: stepUp.id,
      originalMandateId: stepUp.mandate_id,
      approverMandateId: gate.mandateId,
      reasons: gate.reasons,
      idempotencyKey: params.idempotencyKey,
      now,
    });
    return { kind: "rejected", reasons: gate.reasons };
  }

  // Rule 1 (the D-59 fix): checked first among the substantive rules,
  // ahead of rule 2, own reason code. gate.ok === true here, so
  // gate.mandateId is a real, authenticated, properly-bound mandate --
  // this is a valid credential that simply cannot approve its own escalation.
  if (gate.mandateId === stepUp.mandate_id) {
    const reasons: Reason[] = [
      {
        code: ReasonCode.DENY_STEP_UP_SELF_APPROVAL,
        message:
          "The resolving credential's mandate is the same mandate that produced this step-up.",
      },
    ];
    await writeStepUpEvidence(evidence, {
      organizationId,
      type: "step_up.resolution_rejected",
      authorizationId: stepUp.id,
      originalMandateId: stepUp.mandate_id,
      approverMandateId: gate.mandateId,
      reasons,
      idempotencyKey: params.idempotencyKey,
      now,
    });
    return { kind: "rejected", reasons };
  }

  // Rule 2: the approver must be named in the ORIGINAL mandate's current
  // escalation.approvers. No "update mandate" path exists yet (D-62), so
  // there's no staleness risk in reading this outside the lock below.
  const originalMandate = await repo.getMandateDetail(stepUp.mandate_id);
  const approvers = originalMandate?.policy.escalation?.approvers ?? [];
  if (!approvers.includes(gate.mandateId)) {
    const reasons: Reason[] = [
      {
        code: ReasonCode.DENY_MANDATE_NOT_AN_APPROVER,
        message: "This mandate is not named in the principal mandate's list of approvers.",
      },
    ];
    await writeStepUpEvidence(evidence, {
      organizationId,
      type: "step_up.resolution_rejected",
      authorizationId: stepUp.id,
      originalMandateId: stepUp.mandate_id,
      approverMandateId: gate.mandateId,
      reasons,
      idempotencyKey: params.idempotencyKey,
      now,
    });
    return { kind: "rejected", reasons };
  }

  // Rules 3/4 + Additions B/C/D. Atomic under a globally-ordered pair of
  // mandate locks -- sorted by id, not "original then approver" -- so two
  // concurrent resolutions can never wait on each other in a cycle (a 3+
  // approver cycle is accepted, D-62 Addition A; this locking order is
  // what keeps it deadlock-free regardless of cycle length).
  //
  // Evidence is written AFTER this block, once the lock has released --
  // never from inside it. `EvidenceRepository`'s own lock (a real Postgres
  // transaction, same as `AuthorizationRepository`'s) is a *different*
  // repository's transaction; nesting one Prisma `$transaction()` inside
  // another isn't a savepoint, it's a second competing transaction on the
  // same pool -- confirmed live, it starved the connection and blew the
  // 20s transaction timeout (`P2028`) before this was fixed. Matches
  // `authorize()`'s own existing precedent (`verifyAgentKey`'s evidence
  // write already happens outside the mandate lock there, not inside it).
  const [firstLockId, secondLockId] = [stepUp.mandate_id, gate.mandateId].sort() as [string, string];
  const lockResult = await repo.withMandateLock(firstLockId, () =>
    repo.withMandateLock(secondLockId, async () => {
      // Re-check under lock (Addition D): a concurrent resolution or a
      // TTL sweep may have already settled this since the caller fetched
      // `stepUp`. First writer wins; every later caller -- including this
      // one, on a retry -- replays the recorded outcome, never re-runs
      // evaluate() (Addition C: single-use, idempotent by construction).
      const fresh = await repo.getAuthorization(stepUp.id);
      if (!fresh) throw new Error(`authorization vanished mid-resolution: ${stepUp.id}`);
      if (fresh.status !== "PENDING_STEP_UP") {
        return { kind: "replayed" as const, authorization: fresh };
      }

      const spend = await repo.getSpendSnapshot(gate.mandateId, gate.policy.accounting, now);
      const result = evaluate({
        policy: gate.policy,
        action: stepUp.action,
        merchant: stepUp.merchant,
        spend,
        now,
      });

      if (result.decision === Decision.ALLOW) {
        // Addition B: the approval permanently costs real budget on the
        // approver's own mandate -- never released -- so its cumulative
        // and velocity limits actually accumulate from approvals, not
        // only from its own authorize() calls.
        await repo.recordApproverLedgerEntry(gate.mandateId, stepUp.id, stepUp.action.amount, now);
        const updated = await repo.resolveStepUp(stepUp.mandate_id, stepUp.id, "approved", now);
        return { kind: "approved" as const, authorization: updated, reasons: result.reasons };
      }

      // DENY reuses the approver's own DENY_* codes verbatim (rule 4).
      // STEP_UP declines too -- single-level, an approver cannot
      // escalate further -- with its own dedicated code instead of the
      // approver's STEP_UP_* reasons, which would otherwise read as if
      // this step-up were still open.
      const declineReasons: Reason[] =
        result.decision === Decision.DENY
          ? result.reasons
          : [
              {
                code: ReasonCode.DENY_APPROVER_ESCALATION_NOT_SUPPORTED,
                message:
                  "The approver's own policy also requires escalation for this action; approval authority is single-level and cannot chain to a further approver.",
              },
            ];
      const updated = await repo.resolveStepUp(stepUp.mandate_id, stepUp.id, "declined", now);
      return { kind: "declined" as const, authorization: updated, reasons: declineReasons };
    }),
  );

  if (lockResult.kind !== "replayed") {
    await writeStepUpEvidence(evidence, {
      organizationId,
      type: lockResult.kind === "approved" ? "step_up.approved" : "step_up.declined",
      authorizationId: stepUp.id,
      originalMandateId: stepUp.mandate_id,
      approverMandateId: gate.mandateId,
      reasons: lockResult.reasons,
      idempotencyKey: params.idempotencyKey,
      now,
    });
  }

  return { kind: "resolved", authorization: lockResult.authorization };
}

/**
 * Rule 6: one evidence entry per distinct mandate id involved -- "both
 * mandates' chains" in practice means two events with different
 * `subjectId` on the same organization's one physical chain (evidence is
 * organization-scoped, not mandate-scoped). Collapses to one write when
 * `approverMandateId` is absent or equal to `originalMandateId` (rule-1
 * self-approval), so a rejection never produces two identical rows.
 */
async function writeStepUpEvidence(
  evidence: EvidenceRepository,
  input: {
    organizationId: string;
    type: "step_up.approved" | "step_up.declined" | "step_up.resolution_rejected";
    authorizationId: string;
    originalMandateId: string;
    approverMandateId?: string;
    reasons: Reason[];
    idempotencyKey?: string;
    now: Date;
  },
): Promise<void> {
  const mandateIds = new Set<string>([input.originalMandateId]);
  if (input.approverMandateId) mandateIds.add(input.approverMandateId);

  await evidence.withOrganizationLock(input.organizationId, async () => {
    for (const mandateId of mandateIds) {
      await evidence.appendEvent({
        organizationId: input.organizationId,
        type: input.type,
        subjectType: "mandate",
        subjectId: mandateId,
        payload: {
          authorization_id: input.authorizationId,
          original_mandate_id: input.originalMandateId,
          approver_mandate_id: input.approverMandateId ?? null,
          reasons: input.reasons.map((r) => ({ code: r.code, message: r.message })),
          idempotency_key: input.idempotencyKey ?? null,
        },
        now: input.now,
      });
    }
  });
}

export type AgentKeyCheck = { ok: true } | { ok: false; reasons: Reason[] };

/**
 * Verifies the agent's presented API key (D-18) and unconditionally records
 * an EvidenceEvent -- success or failure -- under the organization's chain.
 * Every credential-shaped failure (missing, forged, revoked, or a key that
 * doesn't belong to the claimed agent/organization) reuses
 * `DENY_AGENT_NOT_BOUND`: the request cannot prove it's from the agent it
 * claims to be, which is exactly what that code already means.
 * `DENY_AGENT_SUSPENDED` stays the mandate gate's job -- an agent's
 * suspended *status* is orthogonal to whether a given key is valid.
 */
export async function verifyAgentKey(
  agentKeys: AgentKeyRepository,
  evidence: EvidenceRepository,
  input: { organizationId: string; claimedAgentId: string; apiKey: string; now: Date },
): Promise<AgentKeyCheck> {
  const verification = await agentKeys.verifyKey(input.apiKey, input.now);

  let outcome: "verified" | "not_found" | "revoked" | "org_mismatch" | "agent_mismatch";
  let reasons: Reason[] = [];

  if (!verification.ok) {
    outcome = verification.reason;
    reasons = [
      {
        code: ReasonCode.DENY_AGENT_NOT_BOUND,
        message:
          verification.reason === "revoked"
            ? "The API key presented for this agent has been revoked."
            : "No active API key matches the credential presented.",
      },
    ];
  } else if (verification.organizationId !== input.organizationId) {
    outcome = "org_mismatch";
    reasons = [
      {
        code: ReasonCode.DENY_AGENT_NOT_BOUND,
        message: "The API key presented does not belong to this organization.",
      },
    ];
  } else if (verification.agentId !== input.claimedAgentId) {
    outcome = "agent_mismatch";
    reasons = [
      {
        code: ReasonCode.DENY_AGENT_NOT_BOUND,
        message: "The API key presented does not belong to the agent named in the request.",
      },
    ];
  } else {
    outcome = "verified";
  }

  await evidence.withOrganizationLock(input.organizationId, () =>
    evidence.appendEvent({
      organizationId: input.organizationId,
      type: outcome === "verified" ? "agent_key.verified" : "agent_key.rejected",
      subjectType: "agent",
      // Null agentId means the presented credential was an org credential,
      // not an agent key -- it can never equal claimedAgentId (D-18), so
      // this only differs from input.claimedAgentId when verification
      // actually resolved to the claimed agent.
      subjectId: verification.ok && verification.agentId ? verification.agentId : input.claimedAgentId,
      payload: { key_prefix: extractKeyPrefix(input.apiKey), outcome },
      now: input.now,
    }),
  );

  return outcome === "verified" ? { ok: true } : { ok: false, reasons };
}
