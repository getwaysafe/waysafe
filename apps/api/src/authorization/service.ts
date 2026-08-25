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
} from "@agentpay/core";
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
        agentId: request.agent_id,
        principalId: request.principal_id,
        mandateId: gate.mandateId!,
        mandateVersionId: gate.mandateVersionId ?? "",
        policyHash: gate.policyHash ?? "",
        decision: Decision.DENY,
        status: "DENIED",
        reasons: keyCheck.ok ? gate.reasons : keyCheck.reasons,
        action: request.action,
        merchant: resolveMerchant(request.action.merchant, repo.getMerchantDirectory()),
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
        agentId: request.agent_id,
        principalId: request.principal_id,
        mandateId: gate.mandateId,
        mandateVersionId: gate.mandateVersionId,
        policyHash: gate.policyHash,
        decision: Decision.DENY,
        status: "DENIED",
        reasons: keyCheck.reasons,
        action: request.action,
        merchant: resolveMerchant(request.action.merchant, repo.getMerchantDirectory()),
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

    const merchant = resolveMerchant(request.action.merchant, repo.getMerchantDirectory());
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
      agentId: request.agent_id,
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

type AgentKeyCheck = { ok: true } | { ok: false; reasons: Reason[] };

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
async function verifyAgentKey(
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
      subjectId: verification.ok ? verification.agentId : input.claimedAgentId,
      payload: { key_prefix: extractKeyPrefix(input.apiKey), outcome },
      now: input.now,
    }),
  );

  return outcome === "verified" ? { ok: true } : { ok: false, reasons };
}
