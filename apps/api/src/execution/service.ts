/**
 * Payment execution orchestration.
 *
 * The only way into this file's `executePayment` is an `ExecutableAuthorization`
 * (`executable.ts`) -- a raw `StoredAuthorization`, DENIED or otherwise, does
 * not typecheck here, so there is no runtime branch in this function that
 * decides whether execution is allowed. That decision was already made,
 * structurally, before this function could even be called.
 *
 * Calls the adapter (D-13: any `PaymentAdapter`, never a specific
 * provider), and only on success writes the ledger effect and flips the
 * authorization to EXECUTED (`recordExecution`, inside the mandate lock --
 * D-4). Records an EvidenceEvent either way, success or rejection.
 */

import type { PaymentAdapter } from "@waysafe/core";
import type { AuthorizationRepository, StoredAuthorization } from "../authorization/types.js";
import type { EvidenceRepository } from "../evidence/types.js";
import type { ExecutableAuthorization } from "./executable.js";

export interface ExecutionRepos {
  authorization: AuthorizationRepository;
  evidence: EvidenceRepository;
}

export type ExecutePaymentResult =
  | { kind: "executed"; authorization: StoredAuthorization }
  | { kind: "rejected"; reason: string };

async function recordEvidence(
  repos: ExecutionRepos,
  authorization: StoredAuthorization,
  type: string,
  payload: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await repos.evidence.withOrganizationLock(authorization.organization_id, () =>
    repos.evidence.appendEvent({
      organizationId: authorization.organization_id,
      type,
      subjectType: "authorization",
      subjectId: authorization.id,
      payload,
      now,
    }),
  );
}

export async function executePayment(
  repos: ExecutionRepos,
  executable: ExecutableAuthorization,
  adapter: PaymentAdapter,
  paymentMethodRef: string,
  now: Date,
): Promise<ExecutePaymentResult> {
  const { authorization } = executable;

  const result = await adapter.execute({
    authorizationId: authorization.id,
    amount: authorization.action.amount,
    currency: authorization.action.currency,
    paymentMethodRef,
    // Deterministic and scoped to this one authorization: a retried
    // execute() call (Waysafe's own request retried, not a fresh attempt)
    // reuses the same idempotency key, so the provider itself refuses to
    // double-charge even if Waysafe's first attempt's response was lost.
    idempotencyKey: `execute:${authorization.id}`,
  });

  if (!result.ok) {
    await recordEvidence(
      repos,
      authorization,
      "execution.rejected",
      { provider: adapter.name, reason: result.reason },
      now,
    );
    return { kind: "rejected", reason: result.reason };
  }

  const updated = await repos.authorization.withMandateLock(authorization.mandate_id, () =>
    repos.authorization.recordExecution(
      {
        authorizationId: authorization.id,
        provider: adapter.name,
        providerReference: result.providerReference,
        providerFee: result.providerFee,
      },
      now,
    ),
  );

  await recordEvidence(
    repos,
    authorization,
    "execution.completed",
    {
      provider: adapter.name,
      provider_reference: result.providerReference,
      provider_fee: result.providerFee,
    },
    now,
  );

  return { kind: "executed", authorization: updated };
}
