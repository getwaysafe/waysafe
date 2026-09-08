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

  if (event.type === "issuing_authorization.updated") {
    return handleIssuingCapture(repos, event.data.object as Stripe.Issuing.Authorization, now);
  }

  if (event.type !== "charge.refunded") {
    return { kind: "ignored", reason: `unhandled event type: ${event.type}` };
  }

  const charge = event.data.object as Stripe.Charge;
  const authorizationId = charge.metadata?.waysafe_authorization_id;
  if (!authorizationId) {
    return { kind: "ignored", reason: "charge has no waysafe_authorization_id metadata" };
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

/**
 * D-35: closes the loop `handleIssuingAuthorizationRequest` (D-32/D-35,
 * apps/api/src/enforcement/stripe-issuing.ts) opens -- an ALLOW there writes
 * a RESERVATION, keyed to the Stripe issuing authorization id via
 * `Authorization.externalRef`. Once Stripe actually settles the
 * transaction, this releases that RESERVATION and writes a CAPTURE for the
 * same amount, exactly like `execution/service.ts` does for a
 * PaymentAdapter-executed authorization -- `recordExecution` doesn't care
 * which rail called it, only that the authorization it names is currently
 * AUTHORIZED (the branded-type gate D-22 built is specific to the explicit
 * POST .../execute route; a webhook-triggered capture calls the same
 * repository method directly, same as `handleStripeWebhook`'s own refund
 * branch already does for `recordRefund`).
 *
 * `issuing_authorization.updated` fires on every change to the authorization
 * object; only `status === "closed" && approved` is treated as "captured"
 * here. Anything else (still pending, expired, reversed, or closed-but-
 * declined) is ignored, not applied -- there is nothing to capture yet, or
 * ever.
 */
async function handleIssuingCapture(
  repos: WebhookRepos,
  authorization: Stripe.Issuing.Authorization,
  now: Date,
): Promise<WebhookResult> {
  if (authorization.status !== "closed" || !authorization.approved) {
    return {
      kind: "ignored",
      reason: `issuing authorization not yet captured (status: ${authorization.status}, approved: ${authorization.approved})`,
    };
  }

  const stored = await repos.authorization.findByExternalRef(authorization.id);
  if (!stored) {
    return { kind: "ignored", reason: `no stored authorization for issuing authorization ${authorization.id}` };
  }
  if (stored.status !== "AUTHORIZED") {
    return {
      kind: "ignored",
      reason: `authorization ${stored.id} is not in a capturable state (status: ${stored.status})`,
    };
  }

  await repos.authorization.withMandateLock(stored.mandate_id, () =>
    repos.authorization.recordExecution(
      {
        authorizationId: stored.id,
        provider: "stripe_issuing",
        providerReference: authorization.id,
        providerFee: 0,
      },
      now,
    ),
  );

  await repos.evidence.withOrganizationLock(stored.organization_id, () =>
    repos.evidence.appendEvent({
      organizationId: stored.organization_id,
      type: "enforcement.stripe_issuing.captured",
      subjectType: "authorization",
      subjectId: stored.id,
      payload: { stripe_authorization_id: authorization.id },
      now,
    }),
  );

  return { kind: "applied", effect: "capture" };
}
