/**
 * The first enforcement adapter (D-32, D-33): Stripe Issuing's synchronous
 * `issuing_authorization.request` webhook.
 *
 * This is where "the rail asks Waysafe before funds move" (D-32's
 * non-negotiable #9) becomes a real HTTP response the card network is
 * waiting on -- not a preflight SDK call an agent could simply not make.
 * Stripe requires a response within its timeout window (~2 seconds):
 * `{ approved: boolean }`, ideally with a `Stripe-Version` header matching
 * the account's configured API version. Miss the window, or answer with
 * anything else, and Stripe fails closed (declines) on its own -- which is
 * the correct behavior for a system that must never silently fail open.
 *
 * D-3, unchanged for this rail: merchant identity is matched on
 * `merchant_data.network_id` (a `network_mid` assertion, D-33: now
 * VERIFIED-eligible, same corroboration class as a PSP account id) and
 * `merchant_data.category_code` (MCC) -- both assigned by the card
 * network/acquirer. `merchant_data.name` is never read here: a merchant
 * name on this payload is exactly as unverified as one an agent typed, and
 * D-3's whole point is that a name never gets to satisfy an allowlist.
 *
 * D-32, item 3: a card is provisioned per *mandate*, not per agent --
 * `provisionCardForMandate` stamps the mandate id into the card's own
 * metadata, which is the join key `parseRequest` reads back out. There is
 * no per-agent identity on this rail at all; see D-33 for what that means
 * for ledger accounting.
 */

import Stripe from "stripe";
import {
  Decision,
  ReasonCode,
  evaluate,
  resolveMerchant,
  type Currency,
  type EnforcementAdapter,
  type EnforcementRequest,
  type EngineResult,
  type MandateStatus,
  type MerchantAssertion,
  type Reason,
} from "@waysafe/core";
import type { AuthorizationRepository, MandateDetail } from "../authorization/types.js";
import type { EvidenceRepository } from "../evidence/types.js";

// --- Provisioning (D-32 item 3) -----------------------------------------

export interface ProvisionedCard {
  cardholderId: string;
  cardId: string;
}

/**
 * Creates a Stripe Issuing cardholder and card whose spend authority *is*
 * the named mandate -- the mandate id is stamped into the card's own
 * metadata, never the cardholder's alone, since that's the object
 * `parseRequest` below actually reads back from the webhook payload.
 * Stripe's own `spending_controls` are deliberately not set here: per D-32,
 * they're a coarse backstop below the engine's decision, never a substitute
 * for it, and this spike leaves them at Stripe's permissive default so every
 * decision genuinely comes from `evaluate()`, not from a control this file
 * quietly also enforced.
 */
export async function provisionCardForMandate(
  stripe: Stripe,
  params: {
    mandateId: string;
    cardholderName: string;
    currency: Currency;
    billingAddress: Stripe.Issuing.CardholderCreateParams.Billing.Address;
  },
): Promise<ProvisionedCard> {
  const cardholder = await stripe.issuing.cardholders.create({
    name: params.cardholderName,
    billing: { address: params.billingAddress },
    metadata: { waysafe_mandate_id: params.mandateId },
  });

  const card = await stripe.issuing.cards.create({
    cardholder: cardholder.id,
    currency: params.currency.toLowerCase(),
    type: "virtual",
    metadata: { waysafe_mandate_id: params.mandateId },
  });

  return { cardholderId: cardholder.id, cardId: card.id };
}

/** True only for a real-looking test-mode key -- not unset, and not the
 * literal placeholder .env.example ships with. Mirrors payments/stripe-key.ts;
 * kept as its own function (not shared) because the two keys are deliberately
 * scoped to different Stripe capabilities (Payment Intents vs. Issuing) and
 * should never be able to silently stand in for one another. */
export function probeStripeIssuingKey(): boolean {
  const key = process.env.STRIPE_ISSUING_SECRET_KEY;
  if (!key) return false;
  if (key.includes("...")) return false;
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}

// --- The adapter ----------------------------------------------------------

export interface StripeIssuingResponse {
  approved: boolean;
  reason_codes: string[];
}

/** merchant_data.name is deliberately never read (D-3): network_id and
 * category_code are network/acquirer-assigned; name is exactly as
 * unverified on this payload as a name an agent typed. */
function merchantAssertionFromStripe(
  merchantData: Stripe.Issuing.Authorization.MerchantData,
): MerchantAssertion {
  const mcc = /^\d{4}$/.test(merchantData.category_code) ? merchantData.category_code : undefined;
  return {
    network_mid: merchantData.network_id || undefined,
    mcc,
  };
}

export class StripeIssuingAdapter
  implements EnforcementAdapter<Stripe.Issuing.Authorization, StripeIssuingResponse>
{
  readonly name = "stripe_issuing";

  parseRequest(authorization: Stripe.Issuing.Authorization): EnforcementRequest | null {
    const mandateId = authorization.card.metadata?.waysafe_mandate_id;
    if (!mandateId) return null;

    const amount = authorization.pending_request?.amount ?? authorization.amount;

    return {
      instrumentRef: mandateId,
      action: {
        amount,
        // MVP is USD-only (money.ts) -- a non-USD authorization is cast
        // through so evaluate()'s own currency check (DENY_CURRENCY_NOT_PERMITTED)
        // produces a real, reasoned decline instead of this adapter silently
        // discarding the request as unparseable.
        currency: authorization.currency.toUpperCase() as Currency,
        merchant: merchantAssertionFromStripe(authorization.merchant_data),
        attestations: {},
      },
    };
  }

  toResponse(result: EngineResult, _authorization: Stripe.Issuing.Authorization): StripeIssuingResponse {
    return {
      // D-33: a synchronous rail has no channel to put a human in front of
      // a STEP_UP within a ~2-second window, so STEP_UP fails closed here,
      // exactly like DENY -- the record and evidence event still show the
      // real decision (STEP_UP, with its own reasons), only the boolean the
      // network acts on collapses the two.
      approved: result.decision === Decision.ALLOW,
      reason_codes: result.reasons.map((r) => r.code),
    };
  }
}

// --- Orchestration ----------------------------------------------------------

export interface IssuingEnforcementRepos {
  authorization: AuthorizationRepository;
  evidence: EvidenceRepository;
}

/**
 * The mandate-lifecycle gate for a rail-initiated decision. Deliberately
 * narrower than `resolveMandateGate` (D-13/D-18): there is no agent to bind
 * or suspend on this rail -- the card *is* the mandate's spend authority
 * (D-32 item 3) -- so only the mandate's own status is checked. `evaluate()`
 * still separately checks `policy.expires_at` once this gate passes.
 */
function gateMandateStatus(detail: MandateDetail | null): Reason[] | null {
  if (!detail) {
    return [
      {
        code: ReasonCode.DENY_NO_ACTIVE_MANDATE,
        message: "No mandate is associated with the card presented for this authorization.",
      },
    ];
  }

  const statusReason: Partial<Record<MandateStatus, Reason>> = {
    EXPIRED: {
      code: ReasonCode.DENY_MANDATE_EXPIRED,
      message: "The mandate has expired.",
    },
    REVOKED: {
      code: ReasonCode.DENY_MANDATE_REVOKED,
      message: "The mandate was revoked by the principal.",
    },
    SUPERSEDED: {
      code: ReasonCode.DENY_MANDATE_SUPERSEDED,
      message: "The mandate version referenced has been replaced by a newer version.",
    },
    PENDING_AUTHENTICATION: {
      code: ReasonCode.DENY_MANDATE_NOT_AUTHENTICATED,
      message: "The mandate was never authenticated by the principal.",
    },
    DRAFT: {
      code: ReasonCode.DENY_MANDATE_NOT_AUTHENTICATED,
      message: "The mandate was never confirmed and authenticated by the principal.",
    },
  };

  if (detail.status === "ACTIVE") return null;
  const reason = statusReason[detail.status];
  return [reason ?? { code: ReasonCode.DENY_NO_ACTIVE_MANDATE, message: "The mandate is not active." }];
}

export interface IssuingDecision {
  response: StripeIssuingResponse;
  /** Null when no mandate could be attributed at all -- nothing to write
   * evidence against (see handleIssuingAuthorizationRequest). */
  mandateId: string | null;
}

/**
 * Runs one `issuing_authorization.request` end to end: resolve the mandate
 * from the card's metadata, gate its lifecycle status, evaluate the policy
 * under the mandate lock (D-4 discipline -- serialized against any
 * concurrent authorize() call or another enforcement decision on the same
 * mandate), and record an EvidenceEvent of the outcome.
 *
 * D-33 (recorded, not silently skipped): this does **not** write a ledger
 * entry (RESERVATION/CAPTURE) for an approved card authorization.
 * `AuthorizationRecord.agentId` is a mandatory foreign key to a real Agent
 * row (packages/db/prisma/schema.prisma), and a rail-initiated decision has
 * no agent acting -- the card is the mandate's own spend authority, per item
 * 3. Fabricating an agent id to satisfy the schema would misattribute the
 * spend to whichever agent happened to be picked. Until the domain model
 * has a real answer for "who acted" on this rail (a nullable agentId, or a
 * synthetic per-mandate instrument actor), D-4's cumulative limits do not
 * yet see card-rail spend -- per-transaction limits and merchant/category
 * rules are fully enforced by this evaluate() call; a monthly cumulative cap
 * is not yet protected against card spend specifically. Flagged for a
 * follow-up, not silently shipped as if it were solved.
 */
export async function handleIssuingAuthorizationRequest(
  repos: IssuingEnforcementRepos,
  adapter: EnforcementAdapter<Stripe.Issuing.Authorization, StripeIssuingResponse>,
  authorization: Stripe.Issuing.Authorization,
  now: Date,
): Promise<IssuingDecision> {
  const parsed = adapter.parseRequest(authorization);

  if (!parsed) {
    // No mandate id in the card's metadata at all -- a card issued outside
    // provisionCardForMandate, or with metadata since cleared. Nothing to
    // attach evidence to; fail closed and say why in the response only.
    const result: EngineResult = {
      decision: Decision.DENY,
      reasons: [
        {
          code: ReasonCode.DENY_NO_ACTIVE_MANDATE,
          message: "The card presented carries no Waysafe mandate reference.",
        },
      ],
    };
    return { response: adapter.toResponse(result, authorization), mandateId: null };
  }

  const mandateId = parsed.instrumentRef;
  const detail = await repos.authorization.getMandateDetail(mandateId);
  const gateReasons = gateMandateStatus(detail);

  let result: EngineResult;

  if (gateReasons) {
    result = { decision: Decision.DENY, reasons: gateReasons };
  } else {
    // detail is non-null here: gateMandateStatus only returns null when it is.
    const mandate = detail as MandateDetail;
    const merchant = resolveMerchant(parsed.action.merchant, repos.authorization.getMerchantDirectory());
    result = await repos.authorization.withMandateLock(mandateId, async () => {
      const spend = await repos.authorization.getSpendSnapshot(mandateId, mandate.policy.accounting, now);
      return evaluate({ policy: mandate.policy, action: parsed.action, merchant, spend, now });
    });
  }

  if (detail) {
    await repos.evidence.withOrganizationLock(detail.organizationId, () =>
      repos.evidence.appendEvent({
        organizationId: detail.organizationId,
        type: "enforcement.stripe_issuing.decision",
        subjectType: "mandate",
        subjectId: mandateId,
        payload: {
          decision: result.decision,
          reason_codes: result.reasons.map((r) => r.code),
          amount: parsed.action.amount,
          currency: parsed.action.currency,
          merchant: parsed.action.merchant,
          stripe_authorization_id: authorization.id,
          card_id: authorization.card.id,
        },
        now,
      }),
    );
  }

  return { response: adapter.toResponse(result, authorization), mandateId };
}
