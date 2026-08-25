/**
 * The authorization service: the one place that turns a proposed action into
 * a persisted decision.
 *
 * This is where the actor-state gate (mandate active? authenticated? agent
 * bound and not suspended? principal matches?) runs, ahead of the pure
 * `evaluate()` engine — see DECISIONS.md D-13 for why that split exists. Then,
 * under a per-mandate lock (D-4), it reads the spend snapshot, resolves the
 * merchant, calls `evaluate()`, and persists the decision plus any ledger
 * entries in one atomic step. No LLM call anywhere on this path.
 */

import {
  Decision,
  ID_PREFIX,
  evaluate,
  generateId,
  resolveMerchant,
  type AuthorizationRequest,
  type AuthorizationStatus,
} from "@agentpay/core";
import { hashAuthorizationRequest } from "./idempotency.js";
import type { AuthorizationRepository, NewLedgerEntry, StoredAuthorization } from "./types.js";

export type AuthorizeResult =
  | { kind: "decided"; authorization: StoredAuthorization; replayed: boolean }
  | { kind: "idempotency_conflict"; existing: StoredAuthorization }
  | { kind: "no_mandate"; reasons: import("@agentpay/core").Reason[] };

export interface AuthorizeParams {
  organizationId: string;
  request: AuthorizationRequest;
  now: Date;
  id?: string; // injectable for deterministic tests
}

export async function authorize(
  repo: AuthorizationRepository,
  params: AuthorizeParams,
): Promise<AuthorizeResult> {
  const { organizationId, request, now } = params;
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

  if (!gate.ok) {
    if (!gate.mandateId) {
      // No real mandate row to attach this DENY to -- nothing to persist.
      return { kind: "no_mandate", reasons: gate.reasons };
    }
    // A real mandate exists but failed the gate (revoked, expired, unauthenticated,
    // agent suspended/unbound, principal mismatch) -- persist it like any other DENY,
    // still serialized by the mandate lock since it shares the mandate's ledger.
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
        reasons: gate.reasons,
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
