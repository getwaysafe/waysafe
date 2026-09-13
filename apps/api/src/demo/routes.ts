/**
 * D-42: demo/proof-support routes for the recordable /demo page
 * (apps/dashboard/src/app/demo). Never mounted unless
 * `WAYSAFE_ENABLE_DEMO_ROUTES=1` -- see server.ts's own call site -- because
 * both routes here do something a real production route never should:
 *
 *  - `POST /v1/demo/mandates/:id/authenticate` activates a mandate using a
 *    synthetic, in-process WebAuthn authenticator instead of a real
 *    passkey ceremony driven by a browser. It calls exactly the same
 *    `webauthn/service.ts` functions (`beginRegistration`,
 *    `completeRegistration`, `beginMandateAuthentication`,
 *    `completeMandateAuthentication`) the real `/v1/mandates/:id/
 *    authenticate/*` routes use, and the real `@simplewebauthn/server`
 *    verification still runs against a genuine (if synthetic) P-256
 *    signature -- see `webauthn/test-support/virtual-authenticator.ts`'s
 *    own doc comment, and `examples/demo.ts`, which already does exactly
 *    this over two real HTTP round trips. Folding both round trips into one
 *    call here just avoids making the dashboard hold WebAuthn ceremony
 *    logic of its own for a scene that isn't about the ceremony.
 *
 *  - `POST /v1/demo/x402/bypass-proof` is `x402.bypass.test.ts`'s part 3
 *    negative cases, callable over HTTP so the live demo page can show the
 *    same real on-chain rejection the test suite already proves, without
 *    re-running `npm test` on camera. It performs no policy evaluation and
 *    moves no funds (every case is `simulateExecTransaction`'s `eth_call`,
 *    never a broadcast) -- see that test file for what property this is
 *    actually proving.
 *
 *  - `POST /v1/demo/enforcement/stripe-issuing` (D-44, for `/film`'s Act 2
 *    card lane) replays two hand-authored `issuing_authorization.request`-
 *    shaped payloads through the real `StripeIssuingAdapter` and
 *    `handleIssuingAuthorizationRequest` (`enforcement/stripe-issuing.ts`)
 *    -- the same code a live Stripe webhook would call. It is not a live
 *    Stripe call: this environment's Issuing financial account is still
 *    `status: "pending"` (D-37), so card provisioning here creates the
 *    Instrument row directly (the same shape `provisionCardForMandate`
 *    would produce) rather than calling Stripe's real API, and the
 *    authorization payloads are authored to match Stripe's real webhook
 *    shape rather than replayed from an actual captured webhook, since
 *    none exists yet against a live sandbox. Everything downstream of that
 *    payload -- merchant resolution, `evaluate()`, the adapter's response
 *    mapping -- is the real, unmodified code path. The page must label
 *    every result from this route "replayed Stripe authorization request
 *    -- live sandbox pending (D-37)"; never shown as a live Stripe scene.
 */

import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { z } from "zod";
import type { AuthorizationRepository } from "../authorization/types.js";
import type { EvidenceRepository } from "../evidence/types.js";
import type { InstrumentRepository } from "../instruments/types.js";
import type { WebauthnRepository } from "../webauthn/types.js";
import type { WebauthnConfig } from "../webauthn/webauthn.js";
import {
  beginMandateAuthentication,
  beginRegistration,
  completeMandateAuthentication,
  completeRegistration,
} from "../webauthn/service.js";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "../webauthn/test-support/virtual-authenticator.js";
import {
  addressFromPrivateKey,
  attachForgedSignature,
  buildUsdcTransfer,
  createAmoyPublicClient,
  signWithOneOwnerOnly,
  simulateExecTransaction,
} from "../enforcement/x402-safe.js";
import { StripeIssuingAdapter, handleIssuingAuthorizationRequest } from "../enforcement/stripe-issuing.js";
import type { Address, Hex } from "viem";

export interface DemoRoutesRepos {
  webauthnRepos: { webauthn: WebauthnRepository; authorization: AuthorizationRepository; evidence: EvidenceRepository };
  webauthnConfig: WebauthnConfig;
  instruments: InstrumentRepository;
}

const BypassProofBodySchema = z.object({
  instrument_id: z.string().min(1),
});

const CardReplayBodySchema = z.object({
  mandate_id: z.string().min(1),
});

/** Two recorded-shaped attempts, chosen to match `/film`'s Act 1 captions
 * exactly -- these are the same fabricated numbers dramatized there,
 * replayed here for real. Neither `network_id` is on the demo mandate's
 * allowlist (which names only an `onchain_address`, per
 * `lib/demo/policy.ts`), so both are expected to DENY on
 * `DENY_MERCHANT_NOT_ALLOWLISTED` -- a real decision, not a scripted one;
 * see `stripe-issuing.test.ts` for the same rule proven directly. */
const CARD_REPLAY_SCENARIOS = [
  { label: "$1,240.00 -- unknown merchant, card ending 4421", amountCents: 124_000, networkId: "unknown_merchant_9911" },
  { label: "$89.99 -- recurring, unknown", amountCents: 8_999, networkId: "unknown_recurring_2207" },
] as const;

export function registerDemoRoutes(app: FastifyInstance, repos: DemoRoutesRepos): void {
  /**
   * Activates a mandate end to end with a synthetic authenticator: a
   * registration ceremony (there is never a prior passkey for a
   * demo-freshly-created principal) followed immediately by the
   * authentication ceremony D-20 requires to activate the mandate. Returns
   * 409 if the mandate doesn't exist in this organization, or if either
   * ceremony is rejected (which would mean a real bug -- a synthetic
   * authenticator signing its own freshly-registered key should never fail
   * verification).
   */
  app.post("/v1/demo/mandates/:id/authenticate", async (request, reply) => {
    const { id: mandateId } = request.params as { id: string };
    const summary = await repos.webauthnRepos.authorization.getMandateSummary(mandateId);
    if (!summary || summary.organizationId !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const now = new Date();
    const authenticator = createVirtualAuthenticator();

    const registerOptions = await beginRegistration(repos.webauthnRepos, summary.principalId, now);
    const registration = await completeRegistration(
      repos.webauthnRepos,
      repos.webauthnConfig,
      {
        organizationId: summary.organizationId,
        principalId: summary.principalId,
        response: buildRegistrationResponse({
          authenticator,
          rpId: repos.webauthnConfig.rpId,
          origin: repos.webauthnConfig.origin,
          challenge: registerOptions.challenge,
        }),
        claimedChallenge: registerOptions.challenge,
      },
      now,
    );
    if (registration.kind !== "registered") {
      return reply.code(409).send({ error: "registration_rejected", reason: registration.reason });
    }

    const authOptions = await beginMandateAuthentication(repos.webauthnRepos, summary.principalId, summary.policyHash, now);
    const authentication = await completeMandateAuthentication(
      repos.webauthnRepos,
      repos.webauthnConfig,
      {
        organizationId: summary.organizationId,
        principalId: summary.principalId,
        mandateId: summary.mandateId,
        mandateVersionId: summary.mandateVersionId,
        policyHash: summary.policyHash,
        response: buildAuthenticationResponse({
          authenticator,
          rpId: repos.webauthnConfig.rpId,
          origin: repos.webauthnConfig.origin,
          challenge: authOptions.challenge,
        }),
        ip: request.ip,
      },
      now,
    );
    if (authentication.kind !== "activated") {
      return reply.code(409).send({ error: "authentication_rejected", reason: authentication.reason });
    }

    return reply.send({ activated: true, mandate_id: mandateId });
  });

  /**
   * The three on-chain rejection proofs `x402.bypass.test.ts` part 3
   * already runs offline against the real deployed Safe -- exposed here so
   * the live demo page can show the same chain-level rejection instead of
   * re-deriving it. Requires the same env `x402.bypass.test.ts` gates on;
   * 503s with a clear reason (never a silent fake pass) if it's missing.
   */
  app.post("/v1/enforcement/x402/bypass-proof", async (request, reply) => {
    const body = BypassProofBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }

    const rpcUrl = process.env.POLYGON_AMOY_RPC_URL;
    const cosignerPrivateKey = process.env.WAYSAFE_SAFE_COSIGNER_KEY as Hex | undefined;
    const sessionKeyPrivateKey = process.env.WAYSAFE_X402_TEST_SESSION_KEY as Hex | undefined;
    if (!rpcUrl || !cosignerPrivateKey || !sessionKeyPrivateKey) {
      return reply.code(503).send({
        error: "not_configured",
        message: "bypass proof needs POLYGON_AMOY_RPC_URL, WAYSAFE_SAFE_COSIGNER_KEY, and WAYSAFE_X402_TEST_SESSION_KEY.",
      });
    }

    const instrument = await repos.instruments.getInstrument(body.data.instrument_id);
    if (!instrument || instrument.organization_id !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const safeAddress = instrument.external_ref as Address;
    const cosignerAddress = addressFromPrivateKey(cosignerPrivateKey);
    const sessionKeyAddress = addressFromPrivateKey(sessionKeyPrivateKey);

    // Small, fixed, and never actually spent -- every case below is
    // simulated (eth_call), never broadcast, so this amount never leaves
    // the Safe.
    const TRANSFER_AMOUNT = 100_000n; // 0.1 USDC, 6 decimals
    const publicClient = await createAmoyPublicClient(rpcUrl);
    const transfer = buildUsdcTransfer(cosignerAddress, TRANSFER_AMOUNT);

    const sessionOnly = await signWithOneOwnerOnly({ rpcUrl, safeAddress, signerPrivateKey: sessionKeyPrivateKey, transaction: transfer });
    const sessionAloneResult = await simulateExecTransaction({ publicClient, safeAddress, safeTransaction: sessionOnly });

    const cosignerOnly = await signWithOneOwnerOnly({ rpcUrl, safeAddress, signerPrivateKey: cosignerPrivateKey, transaction: transfer });
    const forged = attachForgedSignature(cosignerOnly, sessionKeyAddress);
    const forgedResult = await simulateExecTransaction({ publicClient, safeAddress, safeTransaction: forged });

    return reply.send({
      safe_address: safeAddress,
      cases: [
        {
          name: "session_key_alone",
          description: "The stolen session key alone, threshold 2, only 1 signature present.",
          rejected: !sessionAloneResult.ok,
          revert_reason: sessionAloneResult.revertReason ?? null,
        },
        {
          name: "forged_envelope",
          description: "A genuine Waysafe co-signature plus a fabricated session-key signature.",
          rejected: !forgedResult.ok,
          revert_reason: forgedResult.revertReason ?? null,
        },
        {
          name: "session_key_no_waysafe",
          description: "A real session-key signature with no Waysafe signature at all.",
          rejected: !sessionAloneResult.ok,
          revert_reason: sessionAloneResult.revertReason ?? null,
        },
      ],
    });
  });

  /**
   * D-44: `/film`'s Act 2 card lane. See this file's own header comment
   * for why this replays hand-authored payloads rather than calling
   * Stripe's real API. Provisions a card Instrument row directly (no
   * Stripe call -- D-37's financial account is still pending), then runs
   * `CARD_REPLAY_SCENARIOS` through the real adapter and returns each
   * real `Decision`.
   */
  app.post("/v1/demo/enforcement/stripe-issuing", async (request, reply) => {
    const body = CardReplayBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }

    const summary = await repos.webauthnRepos.authorization.getMandateSummary(body.data.mandate_id);
    if (!summary || summary.organizationId !== request.auth!.organizationId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const now = new Date();
    const cardId = `ic_demo_${body.data.mandate_id}`;
    const instrument = await repos.instruments.createInstrument(
      {
        organizationId: summary.organizationId,
        mandateId: body.data.mandate_id,
        rail: "stripe_issuing",
        externalRef: cardId,
      },
      now,
    );

    const adapter = new StripeIssuingAdapter();
    const issuingRepos = {
      authorization: repos.webauthnRepos.authorization,
      evidence: repos.webauthnRepos.evidence,
      instruments: repos.instruments,
    };

    const attempts = [];
    for (const scenario of CARD_REPLAY_SCENARIOS) {
      const authorization = {
        id: `iauth_demo_${scenario.networkId}`,
        amount: scenario.amountCents,
        currency: "usd",
        merchant_data: { network_id: scenario.networkId, category_code: "5999", name: "UNKNOWN MERCHANT" },
        card: { id: cardId, metadata: { waysafe_instrument_id: instrument.id } },
        pending_request: { amount: scenario.amountCents },
      } as unknown as Stripe.Issuing.Authorization;

      const decision = await handleIssuingAuthorizationRequest(issuingRepos, adapter, authorization, now);
      attempts.push({
        label: scenario.label,
        amount_cents: scenario.amountCents,
        approved: decision.response.approved,
        reason_codes: decision.response.reason_codes,
        // D-45: the real Authorization row's id -- /film's Act 3 uses this
        // to find this exact decision's own EvidenceEvent (subject_id) for
        // a real receipt, rather than a placeholder.
        authorization_id: decision.authorizationId,
      });
    }

    return reply.send({
      instrument_id: instrument.id,
      // D-45: real, not placeholders -- /film's Act 3 receipt card cites
      // these directly.
      mandate_version_id: summary.mandateVersionId,
      policy_hash: summary.policyHash,
      attempts,
    });
  });
}
