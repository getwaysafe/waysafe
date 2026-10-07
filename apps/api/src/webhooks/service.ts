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
  /**
   * D-81: `retryable` says whether this event was recorded as seen.
   *
   * `false` means the event is permanently irrelevant -- an unhandled type,
   * a charge with no Waysafe metadata -- so it is recorded and the provider
   * can stop retrying. `true` means the reason might not hold next time (a
   * target that does not exist yet), so it is NOT recorded and a retry gets
   * another attempt. Marking a transient miss as seen is how an event
   * disappears permanently.
   */
  | { kind: "ignored"; reason: string; retryable: boolean };

export async function handleStripeWebhook(
  repos: WebhookRepos,
  event: Stripe.Event,
  now: Date,
): Promise<WebhookResult> {
  /**
   * D-81: the event is recorded INSIDE the transaction that applies its
   * effect, not before it.
   *
   * Before D-81, `recordIfNew` committed on its own connection first. A
   * failed effect therefore left the event marked processed, and Stripe's
   * retry was classified `duplicate` -- the second independent review
   * injected a ledger outage and the $100 refund was never credited. The
   * customer's money came back and the mandate's budget did not.
   *
   * Two things follow. The record and the effect share one transaction, so a
   * failed effect rolls the record back and the retry is a genuine first
   * attempt. And an event that is ignored for a reason that might not hold
   * next time is not recorded at all.
   */
  if (event.type === "issuing_authorization.updated") {
    return handleIssuingCapture(
      repos,
      event.data.object as Stripe.Issuing.Authorization,
      event,
      now,
    );
  }

  if (event.type !== "charge.refunded") {
    // Permanently irrelevant: record it so the provider stops retrying.
    return recordOnly(repos, event, now, `unhandled event type: ${event.type}`);
  }

  const charge = event.data.object as Stripe.Charge;
  const authorizationId = charge.metadata?.waysafe_authorization_id;
  if (!authorizationId) {
    return recordOnly(repos, event, now, "charge has no waysafe_authorization_id metadata");
  }

  const stored = await repos.authorization.getAuthorization(authorizationId);
  if (!stored) {
    // Retryable: the authorization may simply not be written yet. Recording
    // this as seen is how a real refund disappears.
    return { kind: "ignored", reason: `no such authorization: ${authorizationId}`, retryable: true };
  }

  return repos.authorization.withMandateLock(stored.mandate_id, async () => {
    const isNew = await repos.providerEvents.recordIfNew(
      "stripe",
      event.id,
      event.type,
      event.data.object as unknown as Record<string, unknown>,
      now,
    );
    if (!isNew) return { kind: "duplicate" } as const;

    await repos.authorization.recordRefund(
      {
        authorizationId,
        amount: charge.amount_refunded,
        provider: "stripe",
        providerReference: charge.id,
      },
      now,
    );

    await repos.evidence.withOrganizationLock(stored.organization_id, () =>
      repos.evidence.appendEvent({
        organizationId: stored.organization_id,
        type: "refund.applied",
        subjectType: "authorization",
        subjectId: authorizationId,
        payload: {
          provider: "stripe",
          provider_reference: charge.id,
          amount: charge.amount_refunded,
        },
        now,
      }),
    );

    return { kind: "applied", effect: "refund" } as const;
  });
}

/**
 * Records an event that will never have an effect, so the provider stops
 * retrying it -- D-81. No transaction needed: there is nothing to roll back.
 */
async function recordOnly(
  repos: WebhookRepos,
  event: Stripe.Event,
  now: Date,
  reason: string,
): Promise<WebhookResult> {
  const isNew = await repos.providerEvents.recordIfNew(
    "stripe",
    event.id,
    event.type,
    event.data.object as unknown as Record<string, unknown>,
    now,
  );
  return isNew ? { kind: "ignored", reason, retryable: false } : { kind: "duplicate" };
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
  event: Stripe.Event,
  now: Date,
): Promise<WebhookResult> {
  if (authorization.status !== "closed" || !authorization.approved) {
    // Retryable: a pending authorization may close later, so recording this
    // delivery as seen would drop the real capture when it arrives (D-81).
    return {
      kind: "ignored",
      reason: `issuing authorization not yet captured (status: ${authorization.status}, approved: ${authorization.approved})`,
      retryable: true,
    };
  }

  const stored = await repos.authorization.findByExternalRef(authorization.id);
  if (!stored) {
    // Retryable: the decision may not be written yet. A settlement with no
    // authorization at all is a force capture, which D-84 handles.
    return {
      kind: "ignored",
      reason: `no stored authorization for issuing authorization ${authorization.id}`,
      retryable: true,
    };
  }

  return repos.authorization.withMandateLock(stored.mandate_id, async () => {
    // D-81: recorded inside the transaction that applies the effect.
    const isNew = await repos.providerEvents.recordIfNew(
      "stripe",
      event.id,
      event.type,
      event.data.object as unknown as Record<string, unknown>,
      now,
    );
    if (!isNew) return { kind: "duplicate" } as const;

    if (stored.status !== "AUTHORIZED") {
      return {
        kind: "ignored",
        reason: `authorization ${stored.id} is not in a capturable state (status: ${stored.status})`,
        retryable: false,
      } as const;
    }

    await repos.authorization.recordExecution(
      {
        authorizationId: stored.id,
        mandateId: stored.mandate_id,
        provider: "stripe_issuing",
        providerReference: authorization.id,
        providerFee: 0,
      },
      now,
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

    return { kind: "applied", effect: "capture" } as const;
  });
}
