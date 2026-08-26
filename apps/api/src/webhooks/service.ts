/**
 * Applies a verified Stripe webhook event's effect, idempotently.
 *
 * Signature verification happens in server.ts (it's an HTTP-layer concern:
 * the raw request body and the `Stripe-Signature` header); by the time an
 * event reaches this function, its authenticity has already been checked.
 * This function's own job is narrower: record that this exact
 * (provider, event id) pair has been seen, and only apply the ledger
 * effect the first time -- `ProviderEventRepository.recordIfNew`
 * (types.ts) is what actually makes a redelivered event a no-op instead of
 * a second credit.
 */

import type Stripe from "stripe";
import type { AuthorizationRepository } from "../authorization/types.js";
import type { EvidenceRepository } from "../evidence/types.js";
import type { ProviderEventRepository } from "./types.js";

export interface WebhookRepos {
  providerEvents: ProviderEventRepository;
  authorization: AuthorizationRepository;
  evidence: EvidenceRepository;
}

export type WebhookResult =
  | { kind: "applied"; effect: string }
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string };

export async function handleStripeWebhook(
  repos: WebhookRepos,
  event: Stripe.Event,
  now: Date,
): Promise<WebhookResult> {
  const isNew = await repos.providerEvents.recordIfNew(
    "stripe",
    event.id,
    event.type,
    event.data.object as unknown as Record<string, unknown>,
    now,
  );
  if (!isNew) {
    return { kind: "duplicate" };
  }

  if (event.type !== "charge.refunded") {
    return { kind: "ignored", reason: `unhandled event type: ${event.type}` };
  }

  const charge = event.data.object as Stripe.Charge;
  const authorizationId = charge.metadata?.agentpay_authorization_id;
  if (!authorizationId) {
    return { kind: "ignored", reason: "charge has no agentpay_authorization_id metadata" };
  }

  const stored = await repos.authorization.getAuthorization(authorizationId);
  if (!stored) {
    return { kind: "ignored", reason: `no such authorization: ${authorizationId}` };
  }

  await repos.authorization.withMandateLock(stored.mandate_id, () =>
    repos.authorization.recordRefund(
      {
        authorizationId,
        amount: charge.amount_refunded,
        provider: "stripe",
        providerReference: charge.id,
      },
      now,
    ),
  );

  await repos.evidence.withOrganizationLock(stored.organization_id, () =>
    repos.evidence.appendEvent({
      organizationId: stored.organization_id,
      type: "refund.applied",
      subjectType: "authorization",
      subjectId: authorizationId,
      payload: { provider: "stripe", provider_reference: charge.id, amount: charge.amount_refunded },
      now,
    }),
  );

  return { kind: "applied", effect: "refund" };
}
