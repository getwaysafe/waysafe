/**
 * The x402 enforcement adapter (D-32, D-40): Waysafe as payer-side signer.
 *
 * D-32 named this shape without building it: "x402: Waysafe as payer-side
 * signer, producing the payment header only against a decision." This file
 * is that adapter's spike -- and it deliberately stops short of a complete
 * x402 payment flow, for the custody reason explained in the big comment
 * below `X402CoSignature`. Read that before extending this file.
 *
 * THE ATTACK this file exists to close, restated for x402 specifically
 * (D-34's rule, applied to a rail that has no synchronous network callback
 * the way Stripe Issuing does): an agent that could hand Waysafe its own
 * copy of an x402 402 Payment Required response -- "trust me, this is what
 * the resource server asked for" -- could fabricate a `payTo` address that
 * happens to sit on a mandate's allowlist and launder an ALLOW for money
 * that would actually go somewhere else. `handleX402PaymentRequest` never
 * accepts payment requirements from a caller at all, agent or otherwise --
 * only a `resourceUrl` (a location to fetch, not a claim about what's
 * there) and an `instrumentRef` (which mandate is paying). The payment
 * requirements it evaluates are always the ones *Waysafe itself* just
 * fetched over HTTP from that URL, via `X402Fetcher`. That fetch is what
 * makes `merchant.ts`'s `MerchantAttestationSource.RAIL` honest here, the
 * same way Stripe Issuing's `merchant_data.network_id` is rail-attested
 * because it arrived on Stripe's own webhook payload, not the agent's
 * word -- except here Waysafe is the one placing the call, not receiving
 * one, because there is no third party positioned to call Waysafe the way
 * a card network is. See `merchant.ts`'s D-40 addition
 * (`MerchantScheme.ONCHAIN_ADDRESS`) for the identity side of this.
 */

import { createHash, type KeyObject } from "node:crypto";
import {
  Decision,
  ID_PREFIX,
  ReasonCode,
  evaluate,
  generateId,
  resolveMerchant,
  signEventHash,
  verifyEventSignature,
  type AuthorizationStatus,
  type EnforcementAdapter,
  type EnforcementRequest,
  type EngineResult,
  type Instrument,
  type MandateStatus,
  type MerchantAssertion,
  type Reason,
} from "@waysafe/core";
import type { AuthorizationRepository, MandateDetail, NewLedgerEntry } from "../authorization/types.js";
import type { EvidenceRepository } from "../evidence/types.js";
import type { InstrumentRepository, NewInstrument } from "../instruments/types.js";

// --- x402 payment requirements, as Waysafe itself observes them ------------

/**
 * One entry of a 402 response's `accepts` array -- the x402 spec's own
 * shape, trimmed to the fields this file reads. `maxAmountRequired` is the
 * spec's own field name and is, per spec, a base-10 string of *atomic*
 * units of `asset` (e.g. for a 6-decimal USDC, "10000" is $0.01) --
 * deliberately not parsed as a float anywhere in this file (D-2).
 */
export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  /**
   * Spec-defined escape hatch for asset metadata. This file reads
   * `extra.decimals` (a number) to convert `maxAmountRequired` to cents --
   * see `assetDecimalsToCents`. Present a nonstandard or missing decimals
   * and `parseRequest` returns null (nothing to attribute a mandate to, per
   * the interface's own contract) rather than guess.
   */
  extra?: Record<string, unknown>;
}

export interface X402PaymentRequiredResponse {
  x402Version: number;
  accepts: X402PaymentRequirement[];
  error?: string;
}

/**
 * Fetches a 402 response, independently of anything an agent claims about
 * it. The only implementation in this file is `createHttpX402Fetcher`;
 * tests inject a fake that returns recorded payloads with no network call
 * at all (D-32/D-33's own "no key, no network" testing posture, applied
 * here since x402 needs neither a provider secret nor a live endpoint to
 * prove the adapter mapping and the attack test).
 */
export interface X402Fetcher {
  fetchPaymentRequirements(resourceUrl: string): Promise<X402PaymentRequiredResponse>;
}

/** The real fetcher: an actual HTTP GET, expecting 402 with a JSON body
 * shaped like `X402PaymentRequiredResponse`. Never used in the offline
 * test suite (see X402Fetcher's doc comment) -- exercised only by whatever
 * process ends up calling `handleX402PaymentRequest` for real. */
export function createHttpX402Fetcher(fetchImpl: typeof fetch = fetch): X402Fetcher {
  return {
    async fetchPaymentRequirements(resourceUrl: string): Promise<X402PaymentRequiredResponse> {
      const response = await fetchImpl(resourceUrl);
      if (response.status !== 402) {
        throw new Error(
          `expected 402 Payment Required fetching ${resourceUrl}, got ${response.status} -- Waysafe ` +
            "will not pay for a resource that didn't itself ask for payment.",
        );
      }
      const body = (await response.json()) as X402PaymentRequiredResponse;
      if (!Array.isArray(body.accepts)) {
        throw new Error(`malformed 402 response from ${resourceUrl}: no "accepts" array`);
      }
      return body;
    },
  };
}

// --- The adapter -------------------------------------------------------------

/**
 * What `handleX402PaymentRequest` hands the adapter, after it has already
 * done the one thing that matters: fetched the requirement itself
 * (`resourceUrl`) and resolved which mandate's instrument is paying
 * (`instrumentRef`, resolved from a real `Instrument` row -- see D-35,
 * mirrored exactly: the *row* is the source of truth, not a bare string an
 * HTTP caller supplied). There is no field here an agent's word alone can
 * populate.
 */
export interface X402Callback {
  instrumentRef: string;
  resourceUrl: string;
  requirement: X402PaymentRequirement;
}

/**
 * What actually gets signed. Deliberately excludes `authorization_id`:
 * `toResponse` produces the signature before the authorization row exists
 * (it only learns the row's id afterward, from `handleX402PaymentRequest`,
 * the same way `StripeIssuingAdapter.toResponse` never sees the row it
 * caused either) -- signing a value that gets mutated after the fact would
 * make every co-signature invalid the moment its id was filled in. The
 * security property that matters is "Waysafe ALLOWed exactly this payment
 * intent," not "this specific internal row id" -- the row id is carried on
 * `X402CoSignature` unsigned, for traceability back to the evidence event
 * only.
 */
export interface X402CoSignaturePayload {
  pay_to: string;
  asset: string;
  network: string;
  amount_atomic: string;
  resource: string;
  expires_at: string;
}

/**
 * Waysafe's half of a payment authorization, produced only against a real
 * ALLOW (`toResponse` returns `co_signature: null` for DENY and, per D-33
 * point 4, for STEP_UP too -- there is no channel to put a human in front
 * of this any more than there is on the sub-2-second card rail; the agent
 * is simply left with no way to pay). This is Ed25519-signed with a key
 * whose only job is attesting Waysafe's own decisions -- see the custody
 * comment below `X402Adapter` for why it is never the key that actually
 * moves funds.
 */
export interface X402CoSignature extends X402CoSignaturePayload {
  authorization_id: string;
  /** Base64 Ed25519 signature over the SHA-256 of the payload fields
   * above, canonically ordered -- see `signCoSignaturePayload`. */
  signature: string;
}

export interface X402EnforcementResponse {
  decision: string;
  reason_codes: string[];
  co_signature: X402CoSignature | null;
}

/** Deterministic key order so the same decision always hashes to the same
 * bytes -- `JSON.stringify` on an object literal already preserves
 * insertion order for string keys in V8, but writing the order out
 * explicitly here means that guarantee is never accidentally depended on
 * silently. */
function canonicalCoSignaturePayload(payload: X402CoSignaturePayload): string {
  const ordered: X402CoSignaturePayload = {
    pay_to: payload.pay_to,
    asset: payload.asset,
    network: payload.network,
    amount_atomic: payload.amount_atomic,
    resource: payload.resource,
    expires_at: payload.expires_at,
  };
  return JSON.stringify(ordered);
}

/** Exported so tests (and anything downstream that must check Waysafe's own
 * output before acting on it) can verify a co-signature without duplicating
 * the hashing scheme. */
export function coSignaturePayloadHash(payload: X402CoSignaturePayload): string {
  return createHash("sha256").update(canonicalCoSignaturePayload(payload)).digest("hex");
}

export function signCoSignaturePayload(privateKey: KeyObject, payload: X402CoSignaturePayload): string {
  return signEventHash(privateKey, coSignaturePayloadHash(payload));
}

/** Never throws -- a malformed signature fails closed (false), same
 * convention as `verifyEventSignature` itself. Deliberately ignores
 * `authorization_id` (never signed -- see `X402CoSignaturePayload`'s doc
 * comment) and `signature` itself when recomputing the hash. */
export function verifyCoSignature(publicKey: KeyObject, coSignature: X402CoSignature): boolean {
  const { signature, authorization_id: _authorizationId, ...payload } = coSignature;
  return verifyEventSignature(publicKey, coSignaturePayloadHash(payload), signature);
}

/**
 * `requirement.maxAmountRequired` is atomic units of `asset`, not USD
 * minor units -- MVP scope (money.ts: `SUPPORTED_CURRENCIES` is USD-only)
 * means this file only ever produces a `ProposedAction` in USD, so it must
 * convert. It does that conversion only when the requirement itself states
 * its own decimals (`extra.decimals`) -- guessing a token's decimals from
 * its address would mean silently trusting an unverified claim about which
 * asset this even is, exactly the kind of default D-8 (the compiler asks
 * rather than inventing a limit) already teaches this codebase not to
 * make. No decimals stated -> unparseable -> `parseRequest` returns null.
 * All-integer (BigInt) arithmetic throughout -- D-2 forbids `parseFloat`
 * on an amount, and this is exactly that rule applied to a second decimal
 * scale (asset decimals) instead of just currency minor units.
 */
function assetAtomicToCents(atomicAmount: string, assetDecimals: number): number | null {
  if (!/^\d+$/.test(atomicAmount)) return null;
  if (!Number.isInteger(assetDecimals) || assetDecimals < 2) return null;

  const scale = 10n ** BigInt(assetDecimals - 2); // asset's smallest unit -> USD cents
  const atomic = BigInt(atomicAmount);
  const cents = (atomic + scale / 2n) / scale; // round-half-up, no floats
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

function hostFromResourceUrl(resourceUrl: string): string | undefined {
  try {
    return new URL(resourceUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * D-40's merchant identity for x402: the `payTo` address plus the resource
 * host, exactly as the task frames it -- `payTo` is where the money
 * actually settles (the strongest signal, same reasoning `psp_account` and
 * `network_mid` already get), the resource host is corroborating context
 * (and can independently reach VERIFIED via the merchant directory, same
 * as any other domain). `requirement.description` is carried as `name` for
 * receipts only -- D-3 never lets a name satisfy an allowlist regardless
 * of source, so its trust doesn't matter here.
 */
function merchantAssertionFromRequirement(callback: X402Callback): MerchantAssertion {
  return {
    onchain_address: callback.requirement.payTo.toLowerCase(),
    domain: hostFromResourceUrl(callback.resourceUrl),
    name: callback.requirement.description,
  };
}

export class X402Adapter implements EnforcementAdapter<X402Callback, X402EnforcementResponse> {
  readonly name = "x402";

  constructor(private readonly signingKey: KeyObject) {}

  parseRequest(callback: X402Callback): EnforcementRequest | null {
    if (!callback.instrumentRef) return null;
    if (!callback.requirement.payTo) return null;

    const decimalsRaw = callback.requirement.extra?.["decimals"];
    const decimals = typeof decimalsRaw === "number" ? decimalsRaw : null;
    if (decimals === null) return null;

    const amount = assetAtomicToCents(callback.requirement.maxAmountRequired, decimals);
    if (amount === null) return null;

    return {
      instrumentRef: callback.instrumentRef,
      action: {
        amount,
        currency: "USD",
        merchant: merchantAssertionFromRequirement(callback),
        attestations: {},
      },
    };
  }

  toResponse(result: EngineResult, callback: X402Callback): X402EnforcementResponse {
    const base = {
      decision: result.decision,
      reason_codes: result.reasons.map((r) => r.code),
    };

    // D-33 point 4, mirrored: STEP_UP has no channel to put a human in
    // front of a decision here either -- the agent is simply waiting on
    // one synchronous response, same as Stripe's ~2-second window, just
    // with a different clock forcing the same shape of answer. DENY and
    // STEP_UP both produce no co-signature at all: nothing Waysafe signs
    // ever leaves this function except against a genuine ALLOW.
    if (result.decision !== Decision.ALLOW) {
      return { ...base, co_signature: null };
    }

    const expiresAt = new Date(
      Date.now() + (callback.requirement.maxTimeoutSeconds ?? 60) * 1000,
    ).toISOString();

    const payload: X402CoSignaturePayload = {
      pay_to: callback.requirement.payTo,
      asset: callback.requirement.asset,
      network: callback.requirement.network,
      amount_atomic: callback.requirement.maxAmountRequired,
      resource: callback.resourceUrl,
      expires_at: expiresAt,
    };

    return {
      ...base,
      co_signature: {
        ...payload,
        authorization_id: "", // filled by handleX402PaymentRequest once the row exists; never signed
        signature: signCoSignaturePayload(this.signingKey, payload),
      },
    };
  }
}

// --- Custody constraint (D-40, closed by D-41) --------------------------
//
// D-32's non-negotiable #9 requires Waysafe to be a *required signer*, never
// a custodian: its signature must be necessary but not sufficient to move
// the principal's funds. x402's standard flow (EIP-3009
// `transferWithAuthorization`, or a plain EOA signing a transfer) does not
// give this file a way to satisfy that on its own. Both are single-signature
// schemes by construction -- whoever holds *the* key that signs the transfer
// can move the funds alone, full stop. There is no way to make Waysafe "a
// required co-signer" on an ordinary EOA or a bare EIP-3009 authorization;
// the only two honest options are (a) Waysafe holds the payer's key, which
// makes it a custodian -- exactly what D-32 says it must never be -- or
// (b) the agent holds the key, which makes Waysafe advisory on this rail,
// exactly the OQ-10 hole D-32 was written to close.
//
// So this file does neither, and `X402CoSignature` is still deliberately
// NOT a complete, spendable x402 X-PAYMENT header -- it has no field that
// is a signed transfer authorization over the asset contract, because
// producing one would require a key capable of authorizing that transfer
// alone, and this codebase must never hold such a key (see
// `signCoSignaturePayload`: it signs with the *evidence-signing* key
// class -- a decision-attestation key, structurally incapable of moving
// funds, the same key class D-26 already uses to sign the evidence chain,
// though a *distinct* key from it in practice -- see x402-signing-key.ts).
// What `toResponse` returns on ALLOW remains Waysafe's off-chain half of a
// two-part authorization, kept for evidence traceability.
//
// **D-41 closes the gap D-40 left open** by actually deploying the 2-of-2
// account: a real Safe (`x402-safe.ts`, `@safe-global/protocol-kit`) per
// mandate, threshold 2, one owner the session key scoped to the mandate
// and held by the agent's runtime -- inert on its own, the same shape a
// Stripe-tokenized card already has (D-13) -- the other owner a genuinely
// new secp256k1 key, `WAYSAFE_SAFE_COSIGNER_KEY`. That second key is *not*
// the Ed25519 key `X402CoSignaturePayload` is signed with above: Safe
// owners are secp256k1 EVM addresses, and an Ed25519 key has no such
// address to be one. Two keys, two trust boundaries -- see
// `x402-safe.ts`'s file-level comment. The agent's session key alone
// cannot satisfy the Safe's `execTransaction` threshold; Waysafe's Safe
// co-signer key alone cannot either; only both together, proven live on
// Polygon Amoy by `x402.bypass.test.ts`'s now-real part 3.
//
// One further constraint D-41 checked on-chain rather than assumed:
// Amoy's test USDC does not support EIP-1271, so the Safe cannot satisfy
// `transferWithAuthorization` no matter how many owners sign it (see
// `X402_SAFE_SETTLEMENT_MODE` in x402-safe.ts for the on-chain evidence).
// The Safe settles instead by calling its own `execTransaction` to invoke
// the token's plain `transfer(to, amount)` -- genuinely 2-of-2-gated, and
// a real on-chain USDC payment, but not the specific mechanism a standard
// x402 "exact" scheme facilitator expects to verify. Wiring this adapter
// into a real facilitator flow remains deferred, same as D-40 left it;
// what D-41 changes is that the account backing it now actually exists
// and actually enforces the threshold, rather than being a documented
// TODO on a placeholder row.

// --- Provisioning ------------------------------------------------------------

/** What actually deploys the payer account -- injected so the offline test
 * suite (this file's own `x402.test.ts`, "no network, no key") can supply a
 * fake that returns instantly, while the live bypass test and any real
 * caller use `x402-safe.ts`'s `createOnChainSafeDeployer`, the same
 * injectable-dependency shape `X402Fetcher` already uses above for exactly
 * the same reason. */
export interface X402SafeDeployer {
  deploySafe(owners: { sessionKeyAddress: string; cosignerAddress: string }): Promise<{ safeAddress: string }>;
}

/**
 * Creates the `Instrument` row (D-32 item 3, D-35) that represents "the
 * payer account for this mandate on the x402 rail" -- one per mandate, same
 * cardinality `provisionCardForMandate` uses for the card rail. Unlike D-40's
 * version of this function, `external_ref` is now the real, deployed 2-of-2
 * Safe address `deployer.deploySafe` returns (D-41) -- never a placeholder
 * string, and never treated as spendable by anything in this codebase until
 * it demonstrably is one.
 */
export async function provisionX402InstrumentForMandate(
  repos: { instruments: InstrumentRepository },
  deployer: X402SafeDeployer,
  params: { organizationId: string; mandateId: string; sessionKeyAddress: string; cosignerAddress: string },
  now: Date,
): Promise<Instrument> {
  const deployment = await deployer.deploySafe({
    sessionKeyAddress: params.sessionKeyAddress,
    cosignerAddress: params.cosignerAddress,
  });
  const input: NewInstrument = {
    organizationId: params.organizationId,
    mandateId: params.mandateId,
    rail: "x402",
    externalRef: deployment.safeAddress,
  };
  return repos.instruments.createInstrument(input, now);
}

// --- Orchestration -----------------------------------------------------------

export interface X402EnforcementRepos {
  authorization: AuthorizationRepository;
  evidence: EvidenceRepository;
  instruments: InstrumentRepository;
}

/** Same narrowing as stripe-issuing.ts's `gateMandateStatus`, and for the
 * identical reason: there is no agent to bind or suspend on a rail-
 * initiated decision, only the mandate's own lifecycle. Kept as its own
 * copy rather than imported from stripe-issuing.ts -- that file is a card-
 * rail adapter and importing from it would make this one depend on a
 * sibling rail for no shared behavior beyond five lines, the same
 * deliberate non-sharing `probeStripeIssuingKey`'s doc comment already
 * explains for a different pair of functions. */
function gateMandateStatus(detail: MandateDetail | null): Reason[] | null {
  if (!detail) {
    return [
      {
        code: ReasonCode.DENY_NO_ACTIVE_MANDATE,
        message: "No mandate is associated with the instrument presented for this payment.",
      },
    ];
  }

  const statusReason: Partial<Record<MandateStatus, Reason>> = {
    EXPIRED: { code: ReasonCode.DENY_MANDATE_EXPIRED, message: "The mandate has expired." },
    REVOKED: { code: ReasonCode.DENY_MANDATE_REVOKED, message: "The mandate was revoked by the principal." },
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

export interface X402Decision {
  response: X402EnforcementResponse;
  mandateId: string | null;
}

/**
 * Runs one x402 payment request end to end, mirroring
 * `handleIssuingAuthorizationRequest`'s structure exactly (D-32/D-35):
 * resolve the Instrument, look up its mandate, gate the mandate's
 * lifecycle, evaluate the policy and persist the decision under the
 * mandate lock (D-4), and record an EvidenceEvent either way.
 *
 * The one structural difference from the card rail: there is no external
 * callback carrying a payment request to this function. `params` carries
 * only `instrumentRef` (which mandate is paying -- resolved from a real
 * `Instrument` row below, never trusted bare) and `resourceUrl` (where to
 * fetch payment requirements from -- a location, not a claim about what's
 * there). `fetcher` performs that fetch itself, and *its* result -- never
 * anything a caller of this function supplied directly -- is what
 * `resolveMerchant` sees, attested `"rail"`. This is THE ATTACK this file
 * exists to close; see the file-level comment.
 */
export async function handleX402PaymentRequest(
  repos: X402EnforcementRepos,
  adapter: EnforcementAdapter<X402Callback, X402EnforcementResponse>,
  fetcher: X402Fetcher,
  params: { instrumentRef: string; resourceUrl: string },
  now: Date,
): Promise<X402Decision> {
  const instrument = await repos.instruments.getInstrument(params.instrumentRef);
  if (!instrument) {
    const result: EngineResult = {
      decision: Decision.DENY,
      reasons: [
        {
          code: ReasonCode.DENY_NO_ACTIVE_MANDATE,
          message: "No instrument is registered for the payer reference presented.",
        },
      ],
    };
    // Nothing to attach evidence or an authorization row to -- same
    // no-instrument branch shape as handleIssuingAuthorizationRequest.
    const requirement: X402PaymentRequirement = {
      scheme: "exact",
      network: "unknown",
      maxAmountRequired: "0",
      resource: params.resourceUrl,
      payTo: "unknown",
      asset: "unknown",
    };
    return {
      response: adapter.toResponse(result, { instrumentRef: params.instrumentRef, resourceUrl: params.resourceUrl, requirement }),
      mandateId: null,
    };
  }

  const requirements = await fetcher.fetchPaymentRequirements(params.resourceUrl);

  // Unlike the missing-instrument case above, the mandate is already known
  // here -- so an empty `accepts` array flows through the normal pipeline
  // below (parseRequest returns null for this placeholder's un-set
  // `extra.decimals`, same as any other unparseable requirement) rather
  // than short-circuiting: the principal still gets a real, evidenced
  // DENY receipt instead of a silently dropped request.
  const requirement: X402PaymentRequirement = requirements.accepts[0] ?? {
    scheme: "exact",
    network: "unknown",
    maxAmountRequired: "0",
    resource: params.resourceUrl,
    payTo: "unknown",
    asset: "unknown",
  };

  const callback: X402Callback = { instrumentRef: params.instrumentRef, resourceUrl: params.resourceUrl, requirement };
  const parsed = adapter.parseRequest(callback);

  const mandateId = instrument.mandate_id;
  const detail = await repos.authorization.getMandateDetail(mandateId);
  const gateReasons = parsed ? gateMandateStatus(detail) : [
    {
      code: ReasonCode.DENY_MERCHANT_UNRESOLVED,
      message: "The resource's 402 response could not be parsed into a supported payment request.",
    },
  ];

  // D-40: the one rail-attested resolveMerchant() call in this file --
  // `requirement` came from Waysafe's own fetch (`fetcher`), never from
  // anything a caller of this function supplied, so "rail" is honest here
  // for the same reason it's honest in stripe-issuing.ts. Resolved even on
  // a gate failure so the persisted receipt always shows the merchant
  // involved, same convention as the card rail.
  const merchantAssertion = parsed?.action.merchant ?? merchantAssertionFromRequirement(callback);
  const merchant = resolveMerchant(merchantAssertion, repos.authorization.getMerchantDirectory(), "rail");

  const stored = await repos.authorization.withMandateLock(mandateId, async () => {
    let result: EngineResult;
    const ledgerEntries: NewLedgerEntry[] = [];

    if (gateReasons) {
      result = { decision: Decision.DENY, reasons: gateReasons };
    } else {
      const mandate = detail as MandateDetail;
      const spend = await repos.authorization.getSpendSnapshot(mandateId, mandate.policy.accounting, now);
      result = evaluate({ policy: mandate.policy, action: parsed!.action, merchant, spend, now });
      if (result.decision === Decision.ALLOW) {
        ledgerEntries.push({ type: "RESERVATION", amount: parsed!.action.amount });
      }
    }

    // D-33 point 4, mirrored: STEP_UP fails closed on this synchronous
    // rail too -- see toResponse's own comment. Persisted status collapses
    // STEP_UP into DENIED; decision/reasons still carry the real outcome.
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
      action: parsed?.action ?? {
        amount: 0,
        currency: "USD",
        merchant: merchantAssertion,
        attestations: {},
      },
      merchant,
      idempotencyKey: null,
      requestHash: null,
      externalRef: null,
      stepUpExpiresAt: null,
      now,
      ledgerEntries,
    });

    return { result, authorization: authorization_ };
  });

  await repos.evidence.withOrganizationLock(instrument.organization_id, () =>
    repos.evidence.appendEvent({
      organizationId: instrument.organization_id,
      type: "enforcement.x402.decision",
      subjectType: "authorization",
      subjectId: stored.authorization.id,
      payload: {
        decision: stored.result.decision,
        reason_codes: stored.result.reasons.map((r) => r.code),
        amount: parsed?.action.amount ?? null,
        currency: "USD",
        merchant: merchantAssertion,
        resource_url: params.resourceUrl,
        pay_to: requirement.payTo,
        asset: requirement.asset,
        network: requirement.network,
        instrument_id: instrument.id,
      },
      now,
    }),
  );

  const response = adapter.toResponse(stored.result, callback);
  if (response.co_signature) {
    response.co_signature.authorization_id = stored.authorization.id;
  }

  return { response, mandateId };
}
