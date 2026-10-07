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
 * D-32, item 3 / D-35: a card is provisioned per *mandate*, not per agent,
 * and the actor a rail-initiated decision is attributed to is the
 * Instrument that card *is* -- never an agent, and never null.
 * `provisionCardForMandate` creates that Instrument row and stamps its own
 * id into the card's metadata, which is the join key `parseRequest` reads
 * back out. See D-35 for why this closes D-33 point 6 (card spend now
 * counts against D-4's cumulative limits).
 */

import Stripe from "stripe";
import {
  Decision,
  ID_PREFIX,
  ReasonCode,
  evaluate,
  generateId,
  resolveMerchant,
  type AuthorizationStatus,
  type Currency,
  type EnforcementAdapter,
  type EnforcementRequest,
  type EngineResult,
  type MandateStatus,
  type MerchantAssertion,
  type Reason,
} from "@waysafe/core";
import {
  ExternalRefConflictError,
  type AuthorizationRepository,
  type MandateDetail,
  type NewLedgerEntry,
  type StoredAuthorization,
} from "../authorization/types.js";
// D-73: moved out of this file so the step-up approval path reads the same
// status table instead of a second copy of it.
import { gateMandateExpiry, gateMandateStatus } from "../authorization/mandate-gate.js";
import type { EvidenceRepository } from "../evidence/types.js";
import type { InstrumentRepository } from "../instruments/types.js";

// --- Provisioning (D-32 item 3, D-35) ---------------------------------------

export interface ProvisionedCard {
  cardholderId: string;
  cardId: string;
  instrumentId: string;
}

/** stripe-node's shipped types don't know about `financial_account_v2` yet
 * (D-37) -- this account's real API rejects the typed `financial_account`
 * field outright (`parameter_unknown`). Cast past the stale typing rather
 * than wait on an SDK update. */
type CardCreateParamsWithFinancialAccountV2 = Stripe.Issuing.CardCreateParams & {
  financial_account_v2: string;
};

export const MISSING_FINANCIAL_ACCOUNT_ENV_MESSAGE = "STRIPE_ISSUING_FINANCIAL_ACCOUNT is not set";

/** Read at provisioning time, not import time, so a missing value fails only
 * the one call that needs it (D-37). Fails loudly and specifically -- never
 * a silent fallback to some other balance, since there is no other balance
 * on this account to fall back to. */
function requireIssuingFinancialAccount(): string {
  const financialAccount = process.env.STRIPE_ISSUING_FINANCIAL_ACCOUNT;
  if (!financialAccount) {
    throw new Error(
      `${MISSING_FINANCIAL_ACCOUNT_ENV_MESSAGE} -- Stripe Issuing card creation on this account requires ` +
        "a v2 Money Management financial account id (D-37). Set it to an fa_... id; see .env.example.",
    );
  }
  return financialAccount;
}

const FINANCIAL_ACCOUNT_STATUS_PATTERN = /because its status is (\w+)/;

/**
 * Extracts the FinancialAccount's status from Stripe's own card-creation
 * error message ("...because its status is pending. Please try again with
 * an open FinancialAccount."), so callers can report exactly what Stripe
 * said rather than guessing. Returns null for any other error, including
 * `requireIssuingFinancialAccount`'s own thrown error (that one fails
 * before Stripe is ever called, so it can never carry a status).
 */
export function financialAccountStatusFromError(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(FINANCIAL_ACCOUNT_STATUS_PATTERN);
  return match?.[1] ?? null;
}

interface CardIssuingTermsAcceptance {
  ip: string;
  acceptedAt: Date;
  mandateVersionId: string;
}

export const NO_CARD_ISSUING_TERMS_ACCEPTANCE_PREFIX = "Cannot provision a card for mandate";

/**
 * D-38: `individual.card_issuing.user_terms_acceptance` is the cardholder's
 * own legal acceptance of Stripe's Issuing terms -- a fact about the
 * cardholder, not about Waysafe, and Waysafe must never manufacture it (no
 * `Date.now()`, no placeholder IP). The only legitimate source is the
 * moment the principal actually authenticated this mandate version over
 * WebAuthn (D-20): a real signature from a real request, with a real IP
 * and a real timestamp, captured exactly once by
 * `webauthn/service.ts`'s `completeMandateAuthentication` and persisted on
 * the MandateVersion (`authenticatedAt`/`authenticationIp` --
 * `AuthorizationRepository.activateMandate`). If the mandate was never
 * authenticated, there is no acceptance on file, and provisioning must
 * refuse outright rather than invent one.
 */
async function requireCardIssuingTermsAcceptance(
  authorization: AuthorizationRepository,
  mandateId: string,
): Promise<CardIssuingTermsAcceptance> {
  const detail = await authorization.getMandateDetail(mandateId);
  if (!detail || !detail.authenticatedAt || !detail.authenticationIp) {
    throw new Error(
      `${NO_CARD_ISSUING_TERMS_ACCEPTANCE_PREFIX} ${mandateId}: it has never been authenticated by its principal ` +
        "(D-38). Stripe Issuing requires the cardholder's own acceptance of its Issuing terms, sourced only " +
        "from that authentication -- Waysafe will not synthesize one. Complete the mandate's WebAuthn " +
        "authentication first.",
    );
  }
  return {
    ip: detail.authenticationIp,
    acceptedAt: new Date(detail.authenticatedAt),
    mandateVersionId: detail.mandateVersionId,
  };
}

/** D-48: polls a freshly-created cardholder until Stripe's own transient
 * `"under_review"` disabled_reason clears (see `provisionCardForMandate`'s
 * own call site for why this exists). Bounded at 10 attempts / 500ms --
 * 5s worst case against a delay measured at 1-2s -- and simply returns if
 * it never clears in that window rather than throwing: a slow clear is
 * Stripe's own timing, not a failure this function can diagnose further,
 * and the caller's own authorization attempt will surface the real
 * decline reason if it's still pending. */
async function waitForCardholderReview(stripe: Stripe, cardholderId: string, attempts = 10, delayMs = 500): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const current = await stripe.issuing.cardholders.retrieve(cardholderId);
    if (current.requirements.disabled_reason !== "under_review") return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Creates a Stripe Issuing cardholder and card whose spend authority *is*
 * the named mandate, and the Instrument row (D-35) that makes that spend
 * attributable and countable against D-4's cumulative limits.
 *
 * Ordering is deliberate: the Instrument's own id doesn't exist until its
 * row is created, and its row wants the card's id as `externalRef` -- so the
 * card is created first (carrying only `waysafe_mandate_id`), the Instrument
 * row is created referencing it, and only then is the card's metadata
 * updated to also carry `waysafe_instrument_id`, the field `parseRequest`
 * actually reads back out on every subsequent authorization.
 *
 * Stripe's own `spending_controls` are deliberately not set here: per D-32,
 * they're a coarse backstop below the engine's decision, never a substitute
 * for it, and this spike leaves them at Stripe's permissive default so every
 * decision genuinely comes from `evaluate()`, not from a control this file
 * quietly also enforced.
 *
 * D-37: this account has no legacy Issuing balance -- card creation requires
 * a v2 Money Management financial account, read from
 * `STRIPE_ISSUING_FINANCIAL_ACCOUNT` (see `requireIssuingFinancialAccount`),
 * and Stripe's own field for it is `financial_account_v2`, not
 * `financial_account` as stripe-node's shipped types still call it -- same
 * lesson as D-36, checked directly against this account rather than assumed
 * from the SDK's types. A financial account also needs a phone number on
 * the cardholder before Stripe will attach a card to it at all (3DS), which
 * this account's default path never required -- hence `cardholderPhone`.
 *
 * D-38: the cardholder also needs `individual.card_issuing.user_terms_acceptance`
 * -- see `requireCardIssuingTermsAcceptance` for where that comes from and
 * why provisioning refuses rather than defaulting it. Once the card exists,
 * the acceptance is recorded as its own evidence event
 * (`mandate.card_issuing_terms_accepted`), separate from
 * `mandate.authenticated`, so a receipt can show exactly when and from
 * where the principal's acceptance was asserted to Stripe -- not merely
 * when the mandate itself was authenticated.
 *
 * D-48: `individual.first_name`/`individual.last_name` are also required --
 * checked directly against a real declined authorization's own
 * `request_history` reason (`card_inactive`), not assumed. Without them,
 * Stripe leaves the cardholder's `requirements.past_due` non-empty
 * (`["individual.first_name", "individual.last_name"]`), which disables the
 * cardholder and creates every card under it `status: "inactive"` --
 * Stripe then auto-declines any authorization attempt against an inactive
 * card by its own account-level control, before the request ever reaches
 * the `issuing_authorization.request` webhook stage at all. The top-level
 * `name` field (a display name Stripe also accepts on its own) does not
 * satisfy this requirement; the two `individual.*` fields are a distinct,
 * separately-checked pair.
 *
 * D-48: `individual.dob` closes a second, separate pre-webhook auto-decline
 * -- without it, `requirements.past_due` stays empty (so it doesn't look
 * required) but every authorization still auto-declines with
 * `cardholder_verification_required`, again before the webhook stage.
 * There is no real date of birth to source here -- this cardholder is a
 * compliance artifact Stripe's Issuing product requires for any
 * `individual`-type cardholder, not a representation of Waysafe's actual
 * principal -- so, like `cardholderPhone`, it is synthetic test-mode data
 * every real caller passes the same fixed value for.
 */
export async function provisionCardForMandate(
  stripe: Stripe,
  repos: IssuingEnforcementRepos,
  params: {
    organizationId: string;
    mandateId: string;
    cardholderName: string;
    cardholderFirstName: string;
    cardholderLastName: string;
    cardholderPhone: string;
    cardholderDob: { day: number; month: number; year: number };
    currency: Currency;
    billingAddress: Stripe.Issuing.CardholderCreateParams.Billing.Address;
  },
  now: Date,
): Promise<ProvisionedCard> {
  const financialAccount = requireIssuingFinancialAccount();
  const acceptance = await requireCardIssuingTermsAcceptance(repos.authorization, params.mandateId);

  const cardholder = await stripe.issuing.cardholders.create({
    name: params.cardholderName,
    phone_number: params.cardholderPhone,
    type: "individual",
    individual: {
      first_name: params.cardholderFirstName,
      last_name: params.cardholderLastName,
      dob: params.cardholderDob,
      card_issuing: {
        user_terms_acceptance: {
          ip: acceptance.ip,
          date: Math.floor(acceptance.acceptedAt.getTime() / 1000),
        },
      },
    },
    billing: { address: params.billingAddress },
    metadata: { waysafe_mandate_id: params.mandateId },
  });

  // D-48: a brand-new individual cardholder with a DOB goes through a
  // brief asynchronous identity check on Stripe's side --
  // `requirements.disabled_reason: "under_review"` immediately after
  // creation. Measured directly against this sandbox, repeatedly: it
  // clears on its own within 1-2 seconds, never longer. Until it clears,
  // any authorization against a card under this cardholder auto-declines
  // with `cardholder_verification_required` -- another pre-webhook
  // decline, same effect as the inactive-card case above. Polling once
  // here means every caller gets a cardholder that's actually ready to
  // authorize, not the same timing gap pushed onto whoever calls this
  // next.
  await waitForCardholderReview(stripe, cardholder.id);

  const card = await stripe.issuing.cards.create({
    cardholder: cardholder.id,
    currency: params.currency.toLowerCase(),
    type: "virtual",
    // D-48: Stripe's own field doc says it plainly -- "Defaults to
    // `inactive`." An inactive card is auto-declined by Stripe's own
    // account-level control before an authorization ever reaches the
    // request stage, so no `issuing_authorization.request` webhook fires
    // for it at all. Explicit, not a workaround for anything unusual.
    status: "active",
    financial_account_v2: financialAccount,
    metadata: { waysafe_mandate_id: params.mandateId },
  } as CardCreateParamsWithFinancialAccountV2);

  const instrument = await repos.instruments.createInstrument(
    {
      organizationId: params.organizationId,
      mandateId: params.mandateId,
      rail: "stripe_issuing",
      externalRef: card.id,
    },
    now,
  );

  await stripe.issuing.cards.update(card.id, {
    metadata: { waysafe_mandate_id: params.mandateId, waysafe_instrument_id: instrument.id },
  });

  await repos.evidence.withOrganizationLock(params.organizationId, () =>
    repos.evidence.appendEvent({
      organizationId: params.organizationId,
      type: "mandate.card_issuing_terms_accepted",
      subjectType: "mandate_version",
      subjectId: acceptance.mandateVersionId,
      payload: {
        ip: acceptance.ip,
        accepted_at: acceptance.acceptedAt.toISOString(),
        cardholder_id: cardholder.id,
      },
      now,
    }),
  );

  return { cardholderId: cardholder.id, cardId: card.id, instrumentId: instrument.id };
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
/** D-84: exported so the transaction path reuses this rather than
 * growing a second copy -- the drift D-80 removed for the mandate gate. */
export function merchantAssertionFromStripe(
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
    // D-35: the Instrument's own id, not the mandate id -- `instrumentRef`
    // is "the Waysafe-recognized reference for the spend instrument's
    // authority" (packages/core/src/enforcement.ts), and now that a real
    // Instrument entity exists, its id *is* that reference. The handler
    // resolves the mandate from the Instrument row, not from anything
    // Stripe's metadata claims about it directly.
    const instrumentId = authorization.card.metadata?.waysafe_instrument_id;
    if (!instrumentId) return null;

    const amount = authorization.pending_request?.amount ?? authorization.amount;

    return {
      instrumentRef: instrumentId,
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
  instruments: InstrumentRepository;
}

/**
 * The mandate-lifecycle gate for a rail-initiated decision. Deliberately
 * narrower than `resolveMandateGate` (D-13/D-18): there is no agent to bind
 * or suspend on this rail -- the card *is* the mandate's spend authority
 * (D-32 item 3) -- so only the mandate's own status is checked. `evaluate()`
 * still separately checks `policy.expires_at` once this gate passes.
 */
export interface IssuingDecision {
  response: StripeIssuingResponse;
  /** Null when no instrument could be resolved at all -- nothing to write
   * evidence or an authorization row against (see
   * handleIssuingAuthorizationRequest). */
  mandateId: string | null;
  /** D-45: the saved Authorization's own id -- the same value stamped as
   * `subject_id` on the `enforcement.stripe_issuing.decision` EvidenceEvent
   * below, so a caller that needs to show *this specific* decision's real
   * evidence (a receipt view, `/film`'s Act 3) can find it without a second,
   * fuzzier lookup. Null alongside `mandateId` for the same reason: no
   * instrument resolved, nothing saved. */
  authorizationId: string | null;
}

/**
 * Runs one `issuing_authorization.request` end to end: resolve the
 * Instrument from the card's metadata, look up its mandate, gate the
 * mandate's lifecycle status, evaluate the policy and persist the decision
 * under the mandate lock (D-4 discipline -- serialized against any
 * concurrent authorize() call or another enforcement decision on the same
 * mandate), and record an EvidenceEvent of the outcome.
 *
 * D-35 (closes D-33 point 6): an ALLOW writes a real RESERVATION ledger
 * entry, attributed to the Instrument (`actorKind: "instrument"`) --
 * `getSpendSnapshot`'s SUM now sees card-rail spend, so a cumulative limit
 * genuinely protects against it. A DENY, or a STEP_UP that fails closed
 * (D-33 point 4: no channel for a human within Stripe's synchronous window),
 * writes no ledger entry -- nothing moved, nothing to reserve against.
 * Capture (releasing the RESERVATION into a CAPTURE once Stripe actually
 * settles the transaction) happens later, via the existing webhook path --
 * see webhooks/service.ts's `issuing_authorization.updated` handling.
 */
export async function handleIssuingAuthorizationRequest(
  repos: IssuingEnforcementRepos,
  adapter: EnforcementAdapter<Stripe.Issuing.Authorization, StripeIssuingResponse>,
  authorization: Stripe.Issuing.Authorization,
  now: Date,
): Promise<IssuingDecision> {
  const parsed = adapter.parseRequest(authorization);

  if (!parsed) {
    // No instrument id in the card's metadata at all -- a card issued
    // outside provisionCardForMandate, or with metadata since cleared.
    // Nothing to attach evidence or an authorization row to; fail closed
    // and say why in the response only.
    const result: EngineResult = {
      decision: Decision.DENY,
      reasons: [
        {
          code: ReasonCode.DENY_NO_ACTIVE_MANDATE,
          message: "The card presented carries no Waysafe instrument reference.",
        },
      ],
    };
    return { response: await adapter.toResponse(result, authorization), mandateId: null, authorizationId: null };
  }

  const instrument = await repos.instruments.getInstrument(parsed.instrumentRef);
  if (!instrument) {
    const result: EngineResult = {
      decision: Decision.DENY,
      reasons: [
        {
          code: ReasonCode.DENY_NO_ACTIVE_MANDATE,
          message: "No instrument is registered for the card presented.",
        },
      ],
    };
    return { response: await adapter.toResponse(result, authorization), mandateId: null, authorizationId: null };
  }

  const mandateId = instrument.mandate_id;

  /**
   * D-74: the decision already recorded for this rail reference, rebuilt
   * into the same response body it produced the first time.
   *
   * `decision` and `reasons` are persisted on the row precisely so a
   * receipt can show the real outcome, so a replay needs nothing the row
   * does not already hold -- no second evaluate(), and no second evidence
   * event, because no second decision was made.
   */
  const replayOf = async (original: StoredAuthorization): Promise<IssuingDecision> => ({
    response: await adapter.toResponse(
      { decision: original.decision, reasons: original.reasons },
      authorization,
    ),
    mandateId: original.mandate_id,
    authorizationId: original.id,
  });

  // D-74, the fast path. Stripe redelivers events, and before this an
  // identical redelivery produced a second Authorization row and a second
  // RESERVATION -- $120 held for one $60 card authorization, with no event
  // that would ever release the duplicate. The lookup is only the fast
  // path; the uniqueness constraint below is the control.
  /**
   * D-79: which revision of this external authorization is being asked
   * about. Stripe reuses one `issuing_authorization.id` across incremental
   * requests, appending to `request_history` each time, so the id alone
   * cannot tell a redelivery from a request for more money. D-74's replay
   * key was therefore wrong for increments: the second independent review
   * approved $10 and then had a $10,000 request on the same id served the
   * original approval.
   */
  const historyLength = Array.isArray(authorization.request_history)
    ? authorization.request_history.length
    : 0;
  const requestedAmount = parsed?.action.amount ?? 0;

  const decidedSoFar = await repos.authorization.listByExternalRef(mandateId, authorization.id);

  /**
   * A redelivery is the same id, the same request sequence AND the same
   * amount. All three, because the amount is what actually matters and
   * Stripe does not guarantee that `request_history` grows in a way this
   * code could rely on alone -- the second review's own increment payload
   * left it untouched, which is exactly the case a sequence-only key misses.
   */
  const redelivery = decidedSoFar.find(
    (row) =>
      (row.external_revision ?? 0) === historyLength &&
      row.action.amount === requestedAmount,
  );
  if (redelivery) return replayOf(redelivery);

  /**
   * Not a redelivery, and something is already decided under this id, so
   * this is a REVISION: a new decision whose subject is the DIFFERENCE
   * between the new total and what is already held.
   *
   * The revision number is the next free one rather than the payload's
   * history length, so two revisions can never collide on the uniqueness
   * key just because Stripe did not grow the history.
   */
  const isIncrement = decidedSoFar.length > 0;
  const revision = isIncrement
    ? Math.max(historyLength, ...decidedSoFar.map((r) => (r.external_revision ?? 0) + 1))
    : historyLength;
  const priorHold = isIncrement
    ? await repos.authorization.getExternalRefHold(mandateId, authorization.id)
    : 0;
  const incrementAmount = requestedAmount - priorHold;

  // Read before the lock only for the merchant resolution and the receipt
  // fields below. The AUTHORITY check is re-read inside the lock (D-80) --
  // a gate read outside the lock is a cache, and the second review revoked a
  // mandate in exactly that window.
  const detail = await repos.authorization.getMandateDetail(mandateId);

  // D-34: this is the one rail-attested resolveMerchant() call in the
  // codebase -- merchant_data.network_id came from Stripe's own webhook
  // payload, not from anything the agent (or whoever holds the card) could
  // fabricate, so "rail" is the only source that's ever honest here.
  // Resolved unconditionally, even on a gate failure, so the persisted
  // receipt always shows what merchant was involved (same convention
  // authorize()'s own gate-fail branch uses).
  const merchant = resolveMerchant(
    parsed.action.merchant,
    repos.authorization.getMerchantDirectory(),
    "rail",
  );

  const decideUnderLock = () =>
    // D-80 follow-up: the gate runs inside the lock, handed over by the
    // repository rather than re-derived here.
    repos.authorization.withAuthorizedMandate(mandateId, now, async (underLockGate) => {
    let result: EngineResult;
    const ledgerEntries: NewLedgerEntry[] = [];

    if (!underLockGate.ok) {
      result = { decision: Decision.DENY, reasons: underLockGate.reasons };
    } else {
      const mandate = underLockGate.mandate;
      const spend = await repos.authorization.getSpendSnapshot(mandateId, mandate.policy.accounting, now);

      // D-79: on an increment, the engine decides the DELTA, because the
      // prior hold is already in the ledger SUM the snapshot reads. The
      // per-transaction ceiling is the one rule that must see the AGGREGATE
      // instead -- otherwise ten $10 increments would each pass a $10
      // per-transaction cap while totalling $100.
      const aggregate = requestedAmount;
      const perTransactionMax = mandate.policy.per_transaction_max;
      if (isIncrement && perTransactionMax !== undefined && aggregate > perTransactionMax) {
        result = {
          decision: Decision.DENY,
          reasons: [
            {
              code: ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED,
              message:
                `This incremental request would raise the authorization to ` +
                `${aggregate} minor units, above the per-transaction ceiling of ` +
                `${perTransactionMax}.`,
              policy_path: "/per_transaction_max",
              detail: { aggregate, per_transaction_max: perTransactionMax, prior_hold: priorHold },
            },
          ],
        };
      } else {
        const decidedAction = isIncrement
          ? { ...parsed.action, amount: incrementAmount }
          : parsed.action;
        result = evaluate({ policy: mandate.policy, action: decidedAction, merchant, spend, now });
      }

      if (result.decision === Decision.ALLOW) {
        // The hold is the DELTA, so the total held across every revision of
        // this external authorization equals the amount now authorized.
        ledgerEntries.push({ type: "RESERVATION", amount: incrementAmount });
      }
    }

    // D-33 point 4 / D-35: STEP_UP has no channel to reach a human within
    // Stripe's synchronous window, so it fails closed exactly like DENY --
    // there is no PENDING_STEP_UP state on this rail, ever. Persisted status
    // reflects that: only ALLOW is AUTHORIZED, everything else is DENIED,
    // even though `decision`/`reasons` still record the real outcome
    // (including STEP_UP's own reasons) for an accurate receipt.
    const status: AuthorizationStatus = result.decision === Decision.ALLOW ? "AUTHORIZED" : "DENIED";

    const authorization_ = await repos.authorization.saveAuthorization({
      id: generateId(ID_PREFIX.authorization),
      organizationId: instrument.organization_id,
      actorKind: "instrument",
      agentId: null,
      instrumentId: instrument.id,
      principalId: detail?.principalId ?? "",
      mandateId,
      mandateVersionId: detail?.mandateVersionId ?? "",
      policyHash: detail?.policyHash ?? "",
      decision: result.decision,
      status,
      reasons: result.reasons,
      action: parsed.action,
      merchant,
      idempotencyKey: null,
      requestHash: null,
      externalRef: authorization.id,
      externalRevision: revision,
      stepUpExpiresAt: null,
      now,
      ledgerEntries,
    });

      // D-76: the evidence event is appended INSIDE this transaction,
      // before any answer reaches Stripe. The decision, its ledger hold and
      // its evidence event now commit or roll back together -- there is no
      // longer a window in which a committed hold exists with no record of
      // why. `withOrganizationLock` joins this transaction rather than
      // opening a competing one (see db/transaction-context.ts).
      await repos.evidence.withOrganizationLock(instrument.organization_id, () =>
        repos.evidence.appendEvent({
          organizationId: instrument.organization_id,
          type: "enforcement.stripe_issuing.decision",
          subjectType: "authorization",
          subjectId: authorization_.id,
          payload: {
            decision: result.decision,
            reason_codes: result.reasons.map((r) => r.code),
            amount: parsed.action.amount,
            currency: parsed.action.currency,
            merchant: parsed.action.merchant,
            stripe_authorization_id: authorization.id,
            card_id: authorization.card.id,
            instrument_id: instrument.id,
          },
          now,
        }),
      );

      return { result, authorization: authorization_ };
    });

  let stored: { result: EngineResult; authorization: StoredAuthorization };
  try {
    stored = await decideUnderLock();
  } catch (err) {
    // D-74: a concurrent delivery of the same event won the race. Its
    // transaction rolled back, so it reserved nothing; re-read outside the
    // aborted transaction (which cannot serve a query) and replay the
    // winner's decision.
    if (err instanceof ExternalRefConflictError) {
      const winner = await repos.authorization.findByExternalRef(authorization.id);
      if (winner) return replayOf(winner);
    }
    // D-76: anything else -- including a failure to append the evidence
    // event -- rolled the whole transaction back, so no authorization row
    // and no ledger hold survive. Answer Stripe with an explicit decline
    // rather than letting the exception become a 500 and relying on
    // Stripe's own decline-on-timeout setting to fail closed for us.
    // Never an approval without a record.
    const unrecorded: EngineResult = {
      decision: Decision.DENY,
      reasons: [
        {
          code: ReasonCode.DENY_DECISION_NOT_RECORDED,
          message:
            "The decision could not be durably recorded, so it was not authorized.",
        },
      ],
    };
    // Same precedent as sweepExpiredStepUps: this handler has no logger of
    // its own, and losing the cause of a decline would be worse than a
    // console write.
    console.error(
      `issuing decision for ${authorization.id} could not be recorded; declined:`,
      err,
    );
    return {
      response: await adapter.toResponse(unrecorded, authorization),
      mandateId,
      authorizationId: null,
    };
  }

  return { response: await adapter.toResponse(stored.result, authorization), mandateId, authorizationId: stored.authorization.id };
}
