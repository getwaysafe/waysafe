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
import {
  ReasonCode,
  evaluate,
  resolveMerchant,
  type Reason,
} from "@waysafe/core";
import type { AuthorizationRepository } from "../authorization/types.js";
import type { InstrumentRepository } from "../instruments/types.js";
import { merchantAssertionFromStripe } from "../enforcement/stripe-issuing.js";
import type { EvidenceRepository } from "../evidence/types.js";
import type { ProviderEventRepository } from "./types.js";

export interface WebhookRepos {
  providerEvents: ProviderEventRepository;
  authorization: AuthorizationRepository;
  evidence: EvidenceRepository;
  /** D-84: resolving a card to its mandate, for `issuing_transaction.created`.
   * Optional so every existing caller still compiles; a transaction event
   * without it is reported as retryable rather than silently dropped. */
  instruments?: InstrumentRepository;
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
  if (event.type === "issuing_transaction.created") {
    return handleIssuingTransaction(
      repos,
      event.data.object as Stripe.Issuing.Transaction,
      event,
      now,
    );
  }

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
/**
 * D-83: the card authorization lifecycle, modelled rather than patched.
 *
 * `issuing_authorization.updated` fires on every change. Before D-83 only
 * `closed && approved` did anything, and it captured the AUTHORIZED amount.
 * Three consequences the second independent review confirmed: a reversed
 * authorization kept its hold forever, an expired one did too, and a $2.50
 * settlement of a $10 hold was recorded as $10.
 *
 * The unit of settlement is the external authorization, not one Waysafe row:
 * since D-79 it can have several revisions, each with its own hold, and what
 * moves is one settled figure against the sum of them.
 */
async function handleIssuingCapture(
  repos: WebhookRepos,
  authorization: Stripe.Issuing.Authorization,
  event: Stripe.Event,
  now: Date,
): Promise<WebhookResult> {
  const status = authorization.status;

  // Still open. Retryable: it may close, reverse or expire later, and
  // recording this delivery as seen would drop whichever arrives (D-81).
  if (status === "pending") {
    return {
      kind: "ignored",
      reason: `issuing authorization still pending (${authorization.id})`,
      retryable: true,
    };
  }

  const stored = await repos.authorization.findByExternalRef(authorization.id);
  if (!stored) {
    // A settlement with no authorization at all is a force capture, which
    // arrives as issuing_transaction.created and is handled in D-84.
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

    /**
     * Reversed, expired, or closed-but-declined: no money moved, so the
     * aggregate hold is released and nothing is captured. Stripe's own
     * lifecycle has all three and none of them was handled before D-83.
     */
    if (status === "reversed" || status === "expired" || !authorization.approved) {
      const reason = status === "reversed" ? "reversed" : status === "expired" ? "expired" : "declined";
      const outcome = await repos.authorization.releaseExternalAuthorization(
        stored.mandate_id,
        authorization.id,
        reason,
        now,
      );
      await repos.evidence.withOrganizationLock(stored.organization_id, () =>
        repos.evidence.appendEvent({
          organizationId: stored.organization_id,
          type: "enforcement.stripe_issuing.released",
          subjectType: "authorization",
          subjectId: stored.id,
          payload: {
            stripe_authorization_id: authorization.id,
            reason,
            released: outcome.released,
            revisions: outcome.rows,
          },
          now,
        }),
      );
      return { kind: "applied", effect: `release:${reason}` } as const;
    }

    if (stored.status === "EXECUTED") {
      // Already settled. A second settlement against one authorization is a
      // multi-capture, which arrives as its own transaction object (D-84).
      return {
        kind: "ignored",
        reason: `authorization ${stored.id} is already settled`,
        retryable: false,
      } as const;
    }

    /**
     * Closed and approved: the SETTLED amount is what moved.
     * `authorization.amount` on a closed object is the settled figure in the
     * card's own currency; the authorized figure is what we held. A partial
     * settlement must charge the smaller real number.
     */
    const settled = authorization.amount;
    const outcome = await repos.authorization.settleExternalAuthorization(
      {
        mandateId: stored.mandate_id,
        externalRef: authorization.id,
        settledAmount: settled,
        settledCurrency: authorization.currency,
        provider: "stripe_issuing",
        providerReference: authorization.id,
      },
      now,
    );

    await repos.evidence.withOrganizationLock(stored.organization_id, () =>
      repos.evidence.appendEvent({
        organizationId: stored.organization_id,
        type: "enforcement.stripe_issuing.captured",
        subjectType: "authorization",
        subjectId: stored.id,
        payload: {
          stripe_authorization_id: authorization.id,
          // Both figures, deliberately: a receipt that shows only one cannot
          // answer "was this a partial settlement?".
          authorized: outcome.authorized,
          settled: outcome.captured,
          released: outcome.released,
          revisions: outcome.rows,
          partial: outcome.captured < outcome.authorized,
        },
        now,
      }),
    );

    return { kind: "applied", effect: "capture" } as const;
  });
}

/**
 * D-84: money that moved without Waysafe approving it.
 *
 * Two real Stripe behaviours the code ignored entirely before D-84.
 *
 * A **force capture** clears offline: the networks permit certain
 * transactions (a store-and-forward terminal, some MCCs) to settle with no
 * real-time authorization request at all. It arrives as a transaction whose
 * `authorization` is null, or whose authorization Waysafe never saw. Before
 * D-84 `issuing_transaction.created` was not handled, so the money moved,
 * the cap was untouched, and the chain held no record of it.
 *
 * An **overcapture** settles for more than was authorized -- real on
 * amount-controllable categories such as fuel and restaurants. The
 * authorized portion settles normally; the excess was never approved.
 *
 * Neither is silently ignored. Both are written to the ledger because they
 * really happened, charged against the cap because the money is gone, and
 * evidenced with what a principal needs to dispute them -- including what
 * Waysafe *would* have decided had it been asked, which is the basis of the
 * dispute.
 */
async function handleIssuingTransaction(
  repos: WebhookRepos,
  transaction: Stripe.Issuing.Transaction,
  event: Stripe.Event,
  now: Date,
): Promise<WebhookResult> {
  // Stripe signs a purchase negative and a refund positive.
  const moved = Math.abs(transaction.amount);
  if (transaction.type === "refund") {
    return recordOnly(
      repos,
      event,
      now,
      "issuing refund transactions are credited through charge.refunded",
    );
  }

  const instrumentRef =
    typeof transaction.card === "string"
      ? transaction.card
      : (transaction.card?.metadata?.waysafe_instrument_id ?? transaction.card?.id);
  const instrument = instrumentRef ? await repos.instruments?.getInstrument(instrumentRef) : null;
  if (!instrument) {
    // Retryable: a card this deployment does not know may simply not be
    // provisioned yet. A settlement on a card that is genuinely not ours is
    // not ours to charge against anything.
    return {
      kind: "ignored",
      reason: `no instrument for card on issuing transaction ${transaction.id}`,
      retryable: true,
    };
  }

  const authorizationRef =
    typeof transaction.authorization === "string"
      ? transaction.authorization
      : transaction.authorization?.id;

  return repos.authorization.withMandateLock(instrument.mandate_id, async () => {
    const isNew = await repos.providerEvents.recordIfNew(
      "stripe",
      event.id,
      event.type,
      event.data.object as unknown as Record<string, unknown>,
      now,
    );
    if (!isNew) return { kind: "duplicate" } as const;

    const detail = await repos.authorization.getMandateDetail(instrument.mandate_id);
    const merchant = merchantAssertionFromStripe(transaction.merchant_data);

    const known = authorizationRef
      ? await repos.authorization.listByExternalRef(instrument.mandate_id, authorizationRef)
      : [];
    const authorized = authorizationRef
      ? await repos.authorization.getExternalRefHold(instrument.mandate_id, authorizationRef)
      : 0;

    // The authorized portion, if any, settles through the D-83 path.
    let excess = moved;
    if (known.length > 0 && authorized > 0) {
      const settleable = Math.min(moved, authorized);
      await repos.authorization.settleExternalAuthorization(
        {
          mandateId: instrument.mandate_id,
          externalRef: authorizationRef!,
          settledAmount: settleable,
          settledCurrency: transaction.currency,
          provider: "stripe_issuing",
          providerReference: transaction.id,
        },
        now,
      );
      excess = moved - settleable;
      if (excess === 0) {
        return { kind: "applied", effect: "capture" } as const;
      }
    }

    /**
     * What is left was never authorized: the whole amount on a force
     * capture, or the overcapture excess. Recorded with the hypothetical
     * decision, which is what makes the evidence event disputable rather
     * than merely alarming.
     */
    const overAuthorized = known.length > 0;
    const hypothetical = detail
      ? evaluate({
          policy: detail.policy,
          action: {
            amount: excess,
            currency: transaction.currency.toUpperCase() as "USD",
            merchant,
            attestations: {},
          },
          merchant: resolveMerchant(merchant, repos.authorization.getMerchantDirectory(), "rail"),
          spend: await repos.authorization.getSpendSnapshot(
            instrument.mandate_id,
            detail.policy.accounting,
            now,
          ),
          now,
        })
      : null;

    const reasons: Reason[] = [
      {
        code: overAuthorized
          ? ReasonCode.DENY_SETTLED_ABOVE_AUTHORIZATION
          : ReasonCode.DENY_SETTLED_WITHOUT_AUTHORIZATION,
        message: overAuthorized
          ? `The network settled ${moved} against ${authorized} authorized; ${excess} was never approved.`
          : `The network settled ${moved} without ever asking Waysafe to approve it.`,
      },
      ...(hypothetical?.reasons ?? []),
    ];

    const stored = await repos.authorization.recordUnauthorizedSettlement(
      {
        organizationId: instrument.organization_id,
        mandateId: instrument.mandate_id,
        mandateVersionId: detail?.mandateVersionId ?? "",
        principalId: detail?.principalId ?? "",
        policyHash: detail?.policyHash ?? "",
        instrumentId: instrument.id,
        amount: excess,
        currency: transaction.currency.toUpperCase(),
        externalRef: transaction.id,
        merchant,
        reasons,
      },
      now,
    );

    await repos.evidence.withOrganizationLock(instrument.organization_id, () =>
      repos.evidence.appendEvent({
        organizationId: instrument.organization_id,
        type: overAuthorized
          ? "enforcement.stripe_issuing.over_authorized_settlement"
          : "enforcement.stripe_issuing.unauthorized_settlement",
        subjectType: "authorization",
        subjectId: stored.id,
        payload: {
          // Everything a principal needs to dispute this with the issuer.
          stripe_transaction_id: transaction.id,
          stripe_authorization_id: authorizationRef ?? null,
          card_id: typeof transaction.card === "string" ? transaction.card : transaction.card?.id,
          instrument_id: instrument.id,
          // Two merchant fields, deliberately. `merchant` is the assertion
          // used for resolution, which excludes the name because a name can
          // never confer trust (non-negotiable #3). `merchant_data` is the
          // rail's raw payload, which is what a principal actually needs to
          // dispute a charge with the issuer -- the trading name, the city,
          // the terminal id. Recording it as dispute data is not the same as
          // trusting it for a decision.
          merchant,
          merchant_data: transaction.merchant_data,
          settled: moved,
          authorized,
          never_approved: excess,
          currency: transaction.currency.toUpperCase(),
          settled_at: now.toISOString(),
          policy_hash: detail?.policyHash ?? null,
          // What Waysafe would have said, had the rail asked.
          would_have_decided: hypothetical?.decision ?? null,
          would_have_reasoned: (hypothetical?.reasons ?? []).map((r) => r.code),
        },
        now,
      }),
    );

    return {
      kind: "applied",
      effect: overAuthorized ? "over_authorized_settlement" : "unauthorized_settlement",
    } as const;
  });
}
