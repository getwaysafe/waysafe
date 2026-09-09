/**
 * Waysafe TypeScript SDK.
 *
 * A thin, typed HTTP client. Every method here is a direct wrapper around one
 * REST call -- nothing here is a framework, a UI, or a required flow. That is
 * deliberate (I-10): a developer building an approval screen, a step-up
 * prompt, or a passkey ceremony does it in their own UI, with their own
 * design system, and calls back into this SDK only to move data. Nothing in
 * this file assumes Node, a browser, or any particular framework beyond
 * `fetch` and `crypto.randomUUID`, both available in either.
 *
 *   const mandate  = await waysafe.compileMandate({ instruction });
 *   const decision = await waysafe.authorize({ agent_id, principal_id, action });
 *   if (waysafe.asExecutable(decision)) await waysafe.execute(...)
 *   const receipt  = await waysafe.verify(decision.authorization_id);
 *
 * See examples/quickstart.ts for the full, runnable journey -- compiling a
 * policy, creating and authenticating a mandate, authorizing, handling a
 * step-up, executing, and verifying -- against a real (or locally running)
 * Waysafe API.
 */

import type {
  ActorKind,
  AgentStatus,
  AuthorizationStatus,
  Decision,
  InstrumentStatus,
  MandateStatus,
  Policy,
  PrincipalType,
  ProposedAction,
  Reason,
  ReasonCode,
  ResolvedMerchant,
} from "@waysafe/core";
import type { ChainVerificationResult, EvidenceEvent } from "@waysafe/core";
import {
  loadEvidencePublicKey,
  verifyEvidenceChain as verifyEvidenceChainLocally,
} from "@waysafe/core";

// --- Errors -------------------------------------------------------------

/**
 * Base class for everything this SDK throws. `status` and `body` are the raw
 * HTTP status and parsed JSON body (when there was one) -- enough for a
 * caller that doesn't care about the specific subclass to still log or
 * report something useful.
 */
export class WaysafeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "WaysafeError";
  }
}

/** The request never reached the server (DNS, TCP, TLS, timeout). Distinct
 * from every other error here because it's the only one `authorize()`'s
 * built-in retry treats as safe to retry -- an HTTP error means the server
 * *did* receive and decide the request, and retrying that would either be a
 * no-op (idempotency) or wrong. */
export class NetworkError extends WaysafeError {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

/** 400 invalid_request: the request body failed schema validation. */
export class ValidationError extends WaysafeError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message, status, body);
    this.name = "ValidationError";
  }
}

/** 401: the API key is missing, forged, or revoked. */
export class UnauthorizedError extends WaysafeError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = "UnauthorizedError";
  }
}

/** 404: no row with this id exists in your organization. */
export class NotFoundError extends WaysafeError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = "NotFoundError";
  }
}

/** 404 no_active_mandate, from `authorize()`: the agent/principal/mandate
 * combination doesn't resolve to a mandate that could even be evaluated --
 * distinct from a DENY, which is a normal decision this SDK returns, not
 * throws. `reasons` explains why no mandate resolved. */
export class NoActiveMandateError extends WaysafeError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    readonly reasons: Reason[],
  ) {
    super(message, status, body);
    this.name = "NoActiveMandateError";
  }
}

/** 409 idempotency_conflict, from `authorize()`: this idempotency key was
 * already used for a *different* request body. `existing` is the decision
 * that key is actually bound to. A plain retry of the same call never hits
 * this -- the server recognizes it as a replay and returns the same decision
 * instead (see `AuthorizationDecision.replayed`). */
export class IdempotencyConflictError extends WaysafeError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    readonly existing: AuthorizationDecision,
  ) {
    super(message, status, body);
    this.name = "IdempotencyConflictError";
  }
}

/** 409, from `execute()` or `approveStepUp()`/`declineStepUp()`: the
 * authorization's current status doesn't allow the operation you asked for
 * (already executed, not pending step-up, etc). `authorizationStatus` is the
 * status that blocked it. */
export class AuthorizationStatusConflictError extends WaysafeError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    readonly authorizationStatus: AuthorizationStatus,
  ) {
    super(message, status, body);
    this.name = "AuthorizationStatusConflictError";
  }
}

/** 402 execution_rejected, from `execute()`: the payment rail itself
 * declined the charge (a card decline, an insufficient balance) -- the
 * authorization was valid, the money didn't move. */
export class ExecutionRejectedError extends WaysafeError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    readonly reason: string,
  ) {
    super(message, status, body);
    this.name = "ExecutionRejectedError";
  }
}

/** 400 unknown_rail, from `execute()`: the `rail` you asked for isn't
 * registered on this deployment. */
export class UnknownRailError extends WaysafeError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    readonly rail: string,
  ) {
    super(message, status, body);
    this.name = "UnknownRailError";
  }
}

// --- Options --------------------------------------------------------------

export interface WaysafeOptions {
  /** Base URL of the Waysafe API, e.g. https://api.waysafe.dev */
  baseUrl: string;
  /** Agent service credential, or an org credential for account-management
   * calls (createAgent, createMandate, list*, ...). Never a card credential,
   * never a model prompt. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

// --- compileMandate ---------------------------------------------------------

export interface CompileMandateRequest {
  /** Natural-language instruction from the principal. */
  instruction: string;
  timezone?: string;
  default_ttl_hours?: number;
}

export interface Clarification {
  path: string;
  question: string;
  suggested_default?: unknown;
  rationale: string;
}

export interface MandateConfirmation {
  summary: string;
  policy_hash: string;
  terms: string[];
  assumptions: string[];
  warnings: string[];
  expires_at: string;
}

export type CompileMandateResponse =
  | {
      status: "compiled";
      policy: Policy;
      policy_hash: string;
      confirmation: MandateConfirmation;
    }
  | {
      status: "needs_clarification";
      clarifications: Clarification[];
      draft?: unknown;
    };

// --- createMandate / authenticate -------------------------------------------

export interface CreateMandateRequest {
  principal_id: string;
  agent_ids: string[];
  /** A policy already validated by compileMandate() or validatePolicy(). */
  policy: unknown;
  intent_text: string;
  compiler_name?: string;
  compiler_model?: string;
  assumptions?: string[];
}

export interface CreatedMandate {
  mandate_id: string;
  mandate_version_id: string;
  policy_hash: string;
  status: MandateStatus;
}

export interface MandateAuthenticationOptions {
  mode: "register" | "authenticate";
  /** base64url. For `mode: "authenticate"` this is base64url(policy_hash) --
   * what the principal's passkey actually signs (D-20). */
  challenge: string;
  rp_id: string;
  origin: string;
  principal_id: string;
}

/**
 * `response` is whatever the principal's authenticator produced --
 * `PublicKeyCredential.toJSON()` from `navigator.credentials.create()` /
 * `.get()` in a browser, or an equivalent from `@simplewebauthn/browser`.
 * This SDK never constructs one itself and never depends on a WebAuthn
 * library (I-10): it only forwards the bytes the developer's own frontend
 * already produced.
 */
export interface VerifyMandateAuthenticationRequest {
  mode: "register" | "authenticate";
  challenge: string;
  response: unknown;
}

export type MandateAuthenticationResult =
  | { kind: "registered"; credentialId: string }
  | { kind: "activated" }
  | { kind: "rejected"; reason: string };

// --- authorize / execute / step-up ------------------------------------------

export interface AuthorizeRequest {
  agent_id: string;
  principal_id: string;
  /** Optional: pin the evaluation to a specific mandate. */
  mandate_id?: string;
  action: ProposedAction;
  /** Makes retries safe. If omitted, the SDK generates one and reuses it
   * for its own network-failure retries -- see `authorize()`. */
  idempotency_key?: string;
  /** Arbitrary caller context recorded on the receipt. */
  context?: Record<string, unknown>;
}

export interface AuthorizationDecision {
  authorization_id: string;
  organization_id: string;
  /** Who acted (D-35): "agent" for an SDK-driven authorize() call,
   * "instrument" for a rail-initiated one (e.g. a Stripe Issuing card, D-32)
   * -- exactly one of agent_id/instrument_id is set, matching this. */
  actor_kind: ActorKind;
  agent_id: string | null;
  instrument_id: string | null;
  principal_id: string;
  mandate_id: string;
  mandate_version_id: string;
  policy_hash: string;
  decision: Decision;
  status: AuthorizationStatus;
  reason_codes: ReasonCode[];
  reasons: Reason[];
  action: ProposedAction;
  merchant: ResolvedMerchant;
  idempotency_key: string | null;
  /**
   * Present only while `status` is `PENDING_STEP_UP`. Deliberately *not* a
   * URL to a hosted approval page (I-10): `authorization_id` and
   * `expires_at` are the only two things a developer's own approval UI
   * needs -- show the receipt, get a yes/no, call `approveStepUp` or
   * `declineStepUp`.
   */
  step_up: { authorization_id: string; expires_at: string } | null;
  created_at: string;
  decided_at: string;
  /** True if this call returned an existing decision for a reused
   * idempotency key rather than deciding a new one. */
  replayed: boolean;
}

export interface ExecuteParams {
  /** Payment adapter name, e.g. "stripe", "x402". */
  rail: string;
  paymentMethodRef: string;
}

const EXECUTABLE: unique symbol = Symbol("waysafe.executable");

/**
 * Mirrors the server's own `ExecutableAuthorization` brand
 * (apps/api/src/execution/executable.ts, D-22): the only way to obtain one
 * is `asExecutable()`, and it only returns non-null for `AUTHORIZED` or
 * `STEP_UP_APPROVED`. `execute()` accepts only this type, so passing a
 * DENIED or still-pending decision is a compile error here too, not just on
 * the server.
 */
export interface ExecutableDecision {
  readonly [EXECUTABLE]: true;
  readonly decision: AuthorizationDecision;
}

const EXECUTABLE_STATUSES: ReadonlySet<AuthorizationStatus> = new Set([
  "AUTHORIZED",
  "STEP_UP_APPROVED",
]);

/** The only constructor for `ExecutableDecision`. Null for any status that
 * isn't currently executable. */
export function asExecutable(decision: AuthorizationDecision): ExecutableDecision | null {
  if (!EXECUTABLE_STATUSES.has(decision.status)) return null;
  return { [EXECUTABLE]: true, decision };
}

// --- principals ---------------------------------------------------------------

export interface CreatePrincipalRequest {
  display_name: string;
  email?: string;
  /** Defaults to INDIVIDUAL. */
  type?: PrincipalType;
}

export interface PrincipalDetail {
  principal_id: string;
  organization_id: string;
  display_name: string;
  email: string | null;
  type: PrincipalType;
  created_at: string;
}

// --- agents / keys -----------------------------------------------------------

export interface CreateAgentRequest {
  name: string;
  description?: string;
}

export interface CreatedAgent {
  agent_id: string;
  name: string;
  status: AgentStatus;
}

export interface AgentSummary {
  agent_id: string;
  organization_id: string;
  name: string;
  status: AgentStatus;
  created_at: string;
}

export interface CreatedAgentKey {
  key_id: string;
  prefix: string;
  /** Shown once. Store it now; the SDK cannot retrieve it again. */
  api_key: string;
  created_at: string;
}

export interface AgentKeySummary {
  key_id: string;
  organization_id: string;
  /** Null for an org credential (D-18). */
  agent_id: string | null;
  prefix: string;
  name: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

// --- instruments (dashboard reads, D-35) --------------------------------------

/** A rail-specific spend instrument (e.g. a Stripe Issuing virtual card,
 * D-32/D-35) whose authority is a mandate's -- the actor a rail-initiated
 * `AuthorizationDecision` is attributed to when `actor_kind` is
 * `"instrument"`. `external_ref` is the rail's own reference (e.g. a Stripe
 * card id) -- treat it the way you'd treat a card number: mask it in any UI,
 * never display it in full. */
export interface InstrumentDetail {
  instrument_id: string;
  organization_id: string;
  mandate_id: string;
  rail: string;
  external_ref: string;
  status: InstrumentStatus;
  created_at: string;
}

// --- mandates (dashboard reads) ----------------------------------------------

export interface MandateListItem {
  mandate_id: string;
  organization_id: string;
  principal_id: string;
  status: MandateStatus;
  policy_hash: string;
  summary: string;
  created_at: string;
}

export interface MandateDetail extends MandateListItem {
  mandate_version_id: string;
  policy: Policy;
  intent_text: string;
  assumptions: string[];
  agent_ids: string[];
  authenticated_at: string | null;
}

// --- evidence ------------------------------------------------------------

export interface EvidenceRecord {
  id: string;
  organization_id: string;
  sequence: number;
  type: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  previous_hash: string | null;
  hash: string;
  /** Base64 Ed25519 signature over `hash` (D-26/OQ-8). Verify it yourself
   * with `verifyEvidenceIndependently` and the key from
   * `getEvidencePublicKey()` -- don't just trust this server's own
   * `verifyEvidenceChain()` judgment; that's the whole point of signing. */
  signature: string;
  created_at: string;
}

export interface EvidencePublicKey {
  algorithm: "Ed25519";
  /** Base64 SPKI. Feed straight into `verifyEvidenceIndependently`. */
  public_key: string;
}

/**
 * Verifies a chain the same way the server's own `GET /v1/evidence/verify`
 * does -- hash consistency plus every signature -- but locally, in your own
 * process, using nothing but `listEvidence()`'s events and
 * `getEvidencePublicKey()`'s key. This is the actual "verifiable by a third
 * party" guarantee D-26/OQ-8 exists for: `verifyEvidenceChain()` (the class
 * method) asks this server whether its own database checks out, which is
 * useful but still trusts this server to answer honestly. This function
 * trusts nothing but the Ed25519 math and a public key you've pinned
 * yourself -- pure, no network call, works from a completely different
 * process than the one that fetched the data.
 */
export function verifyEvidenceIndependently(
  events: EvidenceRecord[],
  publicKeyBase64: string,
): ChainVerificationResult {
  const publicKey = loadEvidencePublicKey(publicKeyBase64);
  const asEvidenceEvents: EvidenceEvent[] = events.map((e) => ({
    id: e.id,
    organization_id: e.organization_id,
    sequence: e.sequence,
    type: e.type,
    subject_type: e.subject_type,
    subject_id: e.subject_id,
    payload: e.payload,
    previous_hash: e.previous_hash,
    hash: e.hash,
    signature: e.signature,
    created_at: new Date(e.created_at),
  }));
  return verifyEvidenceChainLocally(asEvidenceEvents, publicKey);
}

// --- Wire shapes (private) ---------------------------------------------------

interface ReceiptWire {
  id: string;
  organization_id: string;
  actor_kind: ActorKind;
  agent_id: string | null;
  instrument_id: string | null;
  principal_id: string;
  mandate_id: string;
  mandate_version_id: string;
  policy_hash: string;
  decision: Decision;
  status: AuthorizationStatus;
  reasons: Reason[];
  action: ProposedAction;
  merchant: ResolvedMerchant;
  idempotency_key: string | null;
  step_up_expires_at: string | null;
  created_at: string;
  decided_at: string;
}

function toDecision(receipt: ReceiptWire, replayed: boolean): AuthorizationDecision {
  return {
    authorization_id: receipt.id,
    organization_id: receipt.organization_id,
    actor_kind: receipt.actor_kind,
    agent_id: receipt.agent_id,
    instrument_id: receipt.instrument_id,
    principal_id: receipt.principal_id,
    mandate_id: receipt.mandate_id,
    mandate_version_id: receipt.mandate_version_id,
    policy_hash: receipt.policy_hash,
    decision: receipt.decision,
    status: receipt.status,
    reason_codes: receipt.reasons.map((r) => r.code),
    reasons: receipt.reasons,
    action: receipt.action,
    merchant: receipt.merchant,
    idempotency_key: receipt.idempotency_key,
    step_up:
      receipt.status === "PENDING_STEP_UP" && receipt.step_up_expires_at
        ? { authorization_id: receipt.id, expires_at: receipt.step_up_expires_at }
        : null,
    created_at: receipt.created_at,
    decided_at: receipt.decided_at,
    replayed,
  };
}

function randomIdempotencyKey(): string {
  return `idk_${crypto.randomUUID()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function mapError(path: string, status: number, body: unknown): WaysafeError {
  const message = `waysafe ${path} failed with ${status}`;
  const errorCode = isRecord(body) ? body.error : undefined;

  switch (errorCode) {
    case "invalid_request":
      return new ValidationError(
        message,
        status,
        body,
        isRecord(body) && Array.isArray(body.issues) ? (body.issues as { path: string; message: string }[]) : [],
      );
    case "unauthorized":
      return new UnauthorizedError(message, status, body);
    case "not_found":
      return new NotFoundError(message, status, body);
    case "no_active_mandate":
      return new NoActiveMandateError(
        message,
        status,
        body,
        isRecord(body) && Array.isArray(body.reasons) ? (body.reasons as Reason[]) : [],
      );
    case "idempotency_conflict":
      return new IdempotencyConflictError(
        message,
        status,
        body,
        toDecision((body as { existing: ReceiptWire }).existing, true),
      );
    case "not_executable":
    case "not_pending_step_up":
      return new AuthorizationStatusConflictError(
        message,
        status,
        body,
        (isRecord(body) ? (body.status as AuthorizationStatus) : undefined) ?? "DENIED",
      );
    case "execution_rejected":
      return new ExecutionRejectedError(
        message,
        status,
        body,
        isRecord(body) && typeof body.reason === "string" ? body.reason : "unknown",
      );
    case "unknown_rail":
      return new UnknownRailError(
        message,
        status,
        body,
        isRecord(body) && typeof body.rail === "string" ? body.rail : "unknown",
      );
    default:
      return new WaysafeError(message, status, body);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// --- Client -----------------------------------------------------------------

export class Waysafe {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: WaysafeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  // --- Mandates: compile, create, authenticate -------------------------------

  /**
   * Compile a natural-language instruction into a policy.
   *
   * This does NOT create a mandate. A `compiled` result must be shown to the
   * principal and authenticated before it can authorize anything -- the
   * returned `confirmation.assumptions` are exactly the things the compiler
   * decided that the principal never said, and skipping that step is how an
   * agent ends up spending against a limit nobody agreed to.
   */
  async compileMandate(request: CompileMandateRequest): Promise<CompileMandateResponse> {
    const { body } = await this.request<CompileMandateResponse>("POST", "/v1/mandates/compile", {
      intent_text: request.instruction,
      timezone: request.timezone,
      default_ttl_hours: request.default_ttl_hours,
    });
    return body;
  }

  /** Validate a hand-authored policy document. */
  async validatePolicy(policy: unknown): Promise<{
    ok: boolean;
    issues: { path: string; message: string; severity: string }[];
    policy_hash?: string;
  }> {
    const { body } = await this.request<{
      ok: boolean;
      issues: { path: string; message: string; severity: string }[];
      policy_hash?: string;
    }>("POST", "/v1/policies/validate", policy);
    return body;
  }

  /** Registers the person (or org) a mandate delegates authority over.
   * `createMandate`'s `principal_id` must name a principal created here
   * first (OQ-9) -- there is no implicit creation on first reference. */
  async createPrincipal(request: CreatePrincipalRequest): Promise<PrincipalDetail> {
    const { body } = await this.request<PrincipalDetail>("POST", "/v1/principals", request);
    return body;
  }

  async getPrincipal(principalId: string): Promise<PrincipalDetail> {
    return this.get<PrincipalDetail>(`/v1/principals/${principalId}`);
  }

  /** Persists a compiled, confirmed policy as a Mandate, status
   * PENDING_AUTHENTICATION. Not yet usable by `authorize()` until the
   * principal authenticates it -- see `getMandateAuthenticationOptions`. */
  async createMandate(request: CreateMandateRequest): Promise<CreatedMandate> {
    const { body } = await this.request<CreatedMandate>("POST", "/v1/mandates", request);
    return body;
  }

  /** The full mandate: policy, intent text, assumptions, bound agents. */
  async getMandate(mandateId: string): Promise<MandateDetail> {
    return this.get<MandateDetail>(`/v1/mandates/${mandateId}`);
  }

  /** Most-recent-first. */
  async listMandates(options: { limit?: number } = {}): Promise<MandateListItem[]> {
    const { mandates } = await this.get<{ mandates: MandateListItem[] }>("/v1/mandates", {
      limit: options.limit,
    });
    return mandates;
  }

  /** So a dashboard receipt can show who acted (D-35) for an
   * `actor_kind: "instrument"` decision -- rail and a maskable
   * `external_ref`. Throws `NotFoundError` for an instrument that doesn't
   * exist or belongs to another organization; the server never distinguishes
   * the two (org-scoped, same as `getMandate`). */
  async getInstrument(instrumentId: string): Promise<InstrumentDetail> {
    return this.get<InstrumentDetail>(`/v1/instruments/${instrumentId}`);
  }

  /**
   * Whether the principal needs to register a first passkey or sign with one
   * already on file. Hand `challenge`/`rp_id`/`origin` to your own frontend
   * to drive `navigator.credentials.create()`/`.get()` (or
   * `@simplewebauthn/browser`), then pass what it returns to
   * `verifyMandateAuthentication` (I-10: this SDK never touches WebAuthn
   * itself).
   */
  async getMandateAuthenticationOptions(mandateId: string): Promise<MandateAuthenticationOptions> {
    const { body } = await this.request<MandateAuthenticationOptions>(
      "POST",
      `/v1/mandates/${mandateId}/authenticate/options`,
    );
    return body;
  }

  /** Completes whichever ceremony `getMandateAuthenticationOptions` started.
   * Only `mode: "authenticate"` activates the mandate (D-20). */
  async verifyMandateAuthentication(
    mandateId: string,
    request: VerifyMandateAuthenticationRequest,
  ): Promise<MandateAuthenticationResult> {
    const { body } = await this.request<MandateAuthenticationResult>(
      "POST",
      `/v1/mandates/${mandateId}/authenticate/verify`,
      request,
    );
    return body;
  }

  // --- Authorization, execution, step-up --------------------------------------

  /**
   * Ask whether an agent may take an action under a mandate.
   *
   * Idempotency is handled for you: if you don't pass `idempotency_key`, one
   * is generated and reused for every retry this call makes on its own (a
   * dropped connection, a timeout) -- so a network blip during `authorize()`
   * never risks a duplicate decision. Pass your own key if you need to
   * correlate retries you drive yourself (e.g. your job queue's retry).
   *
   * A `DENY` or `STEP_UP` decision is a normal, successful return value, not
   * an error -- this only throws for something that stopped the request from
   * being decided at all (validation, no matching mandate, an idempotency
   * key reused with a different body).
   */
  async authorize(request: AuthorizeRequest): Promise<AuthorizationDecision> {
    const idempotencyKey = request.idempotency_key ?? randomIdempotencyKey();
    const { status, body } = await this.requestWithRetry<ReceiptWire>("POST", "/v1/authorizations", {
      agent_id: request.agent_id,
      principal_id: request.principal_id,
      mandate_id: request.mandate_id,
      action: request.action,
      idempotency_key: idempotencyKey,
      context: request.context ?? {},
    });
    return toDecision(body, status === 200);
  }

  /**
   * Execute an authorized action against a payment rail.
   *
   * Only accepts an `ExecutableDecision` -- the value `asExecutable()`
   * returns for `AUTHORIZED` or `STEP_UP_APPROVED` decisions and `null` for
   * everything else. There is no way to pass a DENIED or still-pending
   * decision here that type-checks; the impossibility is structural, not a
   * runtime check you could route around.
   */
  async execute(decision: ExecutableDecision, params: ExecuteParams): Promise<AuthorizationDecision> {
    const { body } = await this.request<ReceiptWire>(
      "POST",
      `/v1/authorizations/${decision.decision.authorization_id}/execute`,
      { rail: params.rail, payment_method_ref: params.paymentMethodRef },
    );
    return toDecision(body, false);
  }

  /** Approve a pending step-up. Does not execute -- `execute()` (via
   * `asExecutable()`) is the separate, explicit step for that. */
  async approveStepUp(authorizationId: string): Promise<AuthorizationDecision> {
    return this.resolveStepUp(authorizationId, "approved");
  }

  /** Decline a pending step-up. Releases any budget the step-up held. */
  async declineStepUp(authorizationId: string): Promise<AuthorizationDecision> {
    return this.resolveStepUp(authorizationId, "declined");
  }

  private async resolveStepUp(
    authorizationId: string,
    outcome: "approved" | "declined",
  ): Promise<AuthorizationDecision> {
    const { body } = await this.request<ReceiptWire>(
      "POST",
      `/v1/authorizations/${authorizationId}/step-up`,
      { outcome },
    );
    return toDecision(body, false);
  }

  /**
   * Fetch the current state of an authorization -- the receipt. Use this to
   * confirm a decision after the fact: whether a step-up was answered,
   * whether an execution actually landed, or just to render a receipt view.
   * A pending step-up past its TTL is expired lazily by the server on this
   * call, same as any other read.
   */
  async verify(authorizationId: string): Promise<AuthorizationDecision> {
    const receipt = await this.get<ReceiptWire>(`/v1/authorizations/${authorizationId}`);
    return toDecision(receipt, false);
  }

  /** Most-recent-first. */
  async listAuthorizations(options: { limit?: number } = {}): Promise<AuthorizationDecision[]> {
    const { authorizations } = await this.get<{ authorizations: ReceiptWire[] }>("/v1/authorizations", {
      limit: options.limit,
    });
    return authorizations.map((r) => toDecision(r, false));
  }

  /** The reason-code dictionary: every code `authorize()` can return, with
   * operator-facing prose. Branch on `reason_codes`, not this text. */
  async listReasonCodes(): Promise<{ code: ReasonCode; description: string }[]> {
    const { reason_codes } = await this.get<{ reason_codes: { code: ReasonCode; description: string }[] }>(
      "/v1/reason-codes",
    );
    return reason_codes;
  }

  // --- Agents & keys -----------------------------------------------------------

  async createAgent(request: CreateAgentRequest): Promise<CreatedAgent> {
    const { body } = await this.request<CreatedAgent>("POST", "/v1/agents", request);
    return body;
  }

  async listAgents(): Promise<AgentSummary[]> {
    const { agents } = await this.get<{ agents: AgentSummary[] }>("/v1/agents");
    return agents;
  }

  /** Mints an agent API key. The full key is shown exactly once, in this
   * return value -- it is never retrievable again, from this SDK or
   * anywhere else. */
  async createAgentKey(agentId: string, request: { name: string }): Promise<CreatedAgentKey> {
    const { body } = await this.request<CreatedAgentKey>("POST", `/v1/agents/${agentId}/keys`, request);
    return body;
  }

  async revokeAgentKey(agentId: string, keyId: string): Promise<void> {
    await this.request("DELETE", `/v1/agents/${agentId}/keys/${keyId}`);
  }

  /** Every key in your organization -- agent keys and org credentials alike
   * (D-18: same table). Never includes the full key, only the prefix. */
  async listKeys(): Promise<AgentKeySummary[]> {
    const { keys } = await this.get<{ keys: AgentKeySummary[] }>("/v1/keys");
    return keys;
  }

  // --- Evidence ------------------------------------------------------------

  /** The evidence chain for your organization, optionally filtered to one
   * subject (a mandate id, an authorization id, ...). */
  async listEvidence(options: { subject?: string } = {}): Promise<EvidenceRecord[]> {
    const { events } = await this.get<{ events: EvidenceRecord[] }>("/v1/evidence", {
      subject: options.subject,
    });
    return events;
  }

  /**
   * Verifiable by a third party, not just tamper-evident (D-26, resolves
   * OQ-8): the server recomputes the chain from stored rows and checks
   * every event's signature against its own published public key.
   * `result.signed` is `true` only when that signature check ran and
   * passed. This is a convenience call that trusts the server's own
   * judgment about its own database -- for the stronger claim (verify
   * without trusting this server at all), use `listEvidence()` +
   * `getEvidencePublicKey()` with `verifyEvidenceIndependently`, which runs
   * the same check yourself, locally.
   */
  async verifyEvidenceChain(): Promise<ChainVerificationResult> {
    return this.get<ChainVerificationResult>("/v1/evidence/verify");
  }

  /** The Ed25519 public key every evidence event's `signature` is checked
   * against (D-26/OQ-8). No credential required -- a third party auditing a
   * receipt has none. Pin this value once verified out-of-band; a server
   * that could change it at will could sign anything. */
  async getEvidencePublicKey(): Promise<EvidencePublicKey> {
    return this.get<EvidencePublicKey>("/v1/evidence/public-key");
  }

  // --- Internal ----------------------------------------------------------------

  private async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const { body } = await this.request<T>("GET", `${path}${query ? buildQuery(query) : ""}`);
    return body;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
    } catch (err) {
      throw new NetworkError(`waysafe ${path} could not be reached: ${(err as Error).message}`, err);
    }

    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw mapError(path, response.status, body);
    }
    return { status: response.status, body: body as T };
  }

  /** Only `authorize()` uses this: it's the one call whose idempotency key
   * makes a same-request retry provably safe. Retries exactly the
   * `NetworkError` case (the request never reached the server) -- an actual
   * HTTP response, success or failure, is never retried here. */
  private async requestWithRetry<T>(
    method: "POST",
    path: string,
    payload: unknown,
    attempts = 3,
  ): Promise<{ status: number; body: T }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request<T>(method, path, payload);
      } catch (err) {
        if (!(err instanceof NetworkError) || attempt >= attempts - 1) throw err;
        await sleep(100 * 2 ** attempt);
      }
    }
  }
}

export type { Policy, Decision, ReasonCode, Reason, ProposedAction, ResolvedMerchant, ChainVerificationResult };
