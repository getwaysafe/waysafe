/**
 * Domain model.
 *
 * The PRD names eight objects but does not say who owns them. Tenancy is the
 * one thing that is genuinely expensive to retrofit, so it is decided here:
 *
 *   Organization  (a developer account; the tenant boundary)
 *     ├── Agent        many per org
 *     ├── Principal    many per org
 *     └── Mandate      binds ONE principal to ONE OR MORE agents
 *
 * Every row in the system carries an `organization_id`. Nothing is queried
 * without it. An Agent may serve many Principals, but only through a mandate
 * that names it — there is no ambient authority.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MerchantAssertionSchema } from "./merchant.js";
import { MinorUnitsSchema, CurrencySchema } from "./money.js";
import { PolicySchema } from "./policy.js";

// --- Identifiers ------------------------------------------------------------

/** Prefixed, opaque, sortable identifiers. Prefix tells you the type at a glance. */
export const ID_PREFIX = {
  organization: "org",
  principal: "prin",
  agent: "agt",
  mandate: "mdt",
  mandate_version: "mdv",
  authorization: "auth",
  transaction: "txn",
  evidence: "ev",
  step_up: "stp",
  api_key: "key",
  webauthn_challenge: "wch",
  passkey_credential: "pkc",
  instrument: "inst",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

// Crockford base32: no I/L/O/U, so an id can't be misread or accidentally spell a slur.
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeBase32(value: number, length: number): string {
  let n = value;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out = BASE32[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/**
 * A prefixed, opaque, time-sortable id: `{prefix}_{10-char timestamp}{16-char random}`.
 * Lexicographic order matches creation order, like a ULID.
 */
export function generateId(prefix: IdPrefix): string {
  const time = encodeBase32(Date.now(), 10);
  const random = Array.from(randomBytes(16), (b) => BASE32[b % 32]).join("");
  return `${prefix}_${time}${random}`;
}

// --- Lifecycle enums --------------------------------------------------------

export const MandateStatus = {
  /** Compiled but not yet confirmed by the principal. Cannot authorize anything. */
  DRAFT: "DRAFT",
  /** Awaiting the principal's passkey authentication. */
  PENDING_AUTHENTICATION: "PENDING_AUTHENTICATION",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  /** Replaced by a newer version of the same mandate. */
  SUPERSEDED: "SUPERSEDED",
} as const;

export type MandateStatus = (typeof MandateStatus)[keyof typeof MandateStatus];

export const AgentStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const PrincipalType = {
  INDIVIDUAL: "INDIVIDUAL",
  ORGANIZATION: "ORGANIZATION",
} as const;

export type PrincipalType = (typeof PrincipalType)[keyof typeof PrincipalType];

export const InstrumentStatus = {
  ACTIVE: "ACTIVE",
  REVOKED: "REVOKED",
} as const;

export type InstrumentStatus = (typeof InstrumentStatus)[keyof typeof InstrumentStatus];

/**
 * Who acted on an authorization decision (D-35). The actor-state gate
 * (D-13/D-18) and D-3's merchant-trust attestation source (D-34) both ask
 * "who is on the other end of this request" -- this is the same question for
 * *who the authorization itself is attributed to*. An agent-initiated
 * decision (`authorize()`, D-13) is attributed to the Agent whose key was
 * verified. A rail-initiated decision (D-32) has no agent at all -- the
 * instrument itself (a card, D-32 item 3) carries the mandate's authority --
 * so the actor is the Instrument, never a null. Exactly one of
 * `agent_id`/`instrument_id` is ever set, matching this discriminator; see
 * the DB CHECK constraint noted on `packages/db/prisma/schema.prisma`'s
 * `ActorKind` enum.
 */
export const ActorKind = {
  AGENT: "agent",
  INSTRUMENT: "instrument",
} as const;

export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

export const AuthorizationStatus = {
  /** Terminal: ALLOW was returned and the authorization can be executed. */
  AUTHORIZED: "AUTHORIZED",
  /** Terminal: DENY. */
  DENIED: "DENIED",
  /** Waiting on a human. Holds budget if the policy reserves on step-up. */
  PENDING_STEP_UP: "PENDING_STEP_UP",
  /** The human approved; equivalent to AUTHORIZED from here on. */
  STEP_UP_APPROVED: "STEP_UP_APPROVED",
  /** The human declined. Terminal. */
  STEP_UP_DECLINED: "STEP_UP_DECLINED",
  /** Nobody answered before ttl_seconds elapsed. Terminal, releases budget. */
  EXPIRED: "EXPIRED",
  /** Executed against a payment rail. Terminal. */
  EXECUTED: "EXECUTED",
} as const;

export type AuthorizationStatus =
  (typeof AuthorizationStatus)[keyof typeof AuthorizationStatus];

export const TransactionStatus = {
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
} as const;

export type TransactionStatus =
  (typeof TransactionStatus)[keyof typeof TransactionStatus];

// --- The proposed action ----------------------------------------------------

/**
 * What an agent asks permission to do. This is the payload of
 * `authorize(agent, principal, action, context)`.
 */
export const ProposedActionSchema = z.object({
  /** Integer minor units. See money.ts — never a decimal. */
  amount: MinorUnitsSchema,
  currency: CurrencySchema,
  merchant: MerchantAssertionSchema,
  /** Category slug the agent believes applies, e.g. "office_supplies". */
  category: z.string().min(1).optional(),
  /** Free-text description of what is being bought, for the receipt. */
  description: z.string().max(2000).optional(),
  /**
   * Agent attestations about the purchase — "refundable": true, "stops": 0.
   * Evaluated against policy constraints and recorded as *claims*, not facts.
   */
  attestations: z.record(z.union([z.string(), z.number(), z.boolean()])).default(
    {},
  ),
});

export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const AuthorizationRequestSchema = z.object({
  agent_id: z.string().min(1),
  principal_id: z.string().min(1),
  /** Optional: pin the evaluation to a specific mandate. */
  mandate_id: z.string().min(1).optional(),
  action: ProposedActionSchema,
  /** Caller-supplied key making retries safe. Required in production. */
  idempotency_key: z.string().min(8).max(255).optional(),
  /** Arbitrary caller context recorded on the receipt. */
  context: z.record(z.unknown()).default({}),
});

export type AuthorizationRequest = z.infer<typeof AuthorizationRequestSchema>;

// --- Entities ---------------------------------------------------------------

export interface Organization {
  id: string;
  name: string;
  created_at: Date;
}

export interface Principal {
  id: string;
  organization_id: string;
  /** Display name; for an org principal, the company name. */
  display_name: string;
  email: string | null;
  type: PrincipalType;
  created_at: Date;
}

export interface Agent {
  id: string;
  organization_id: string;
  name: string;
  status: AgentStatus;
  /** Free-form description of what the agent does; shown on step-up prompts. */
  description: string | null;
  created_at: Date;
}

/**
 * A rail-specific spend instrument (D-32 item 3, D-35) -- e.g. a Stripe
 * Issuing virtual card -- whose authority *is* a mandate's, made portable
 * onto that rail. One per mandate for now. This is the actor a
 * rail-initiated `AuthorizationRecord` is attributed to (`ActorKind.INSTRUMENT`).
 */
export interface Instrument {
  id: string;
  organization_id: string;
  mandate_id: string;
  /** Adapter name, matching EnforcementAdapter.name -- "stripe_issuing" for now. */
  rail: string;
  /** The rail's own reference for this instrument, e.g. a Stripe card id. */
  external_ref: string;
  status: InstrumentStatus;
  created_at: Date;
}

/**
 * A Mandate is a stable handle. Its *content* lives in immutable
 * MandateVersions, so an authorization can always cite the exact bytes that
 * authorized it even after the principal edits the mandate.
 */
export interface Mandate {
  id: string;
  organization_id: string;
  principal_id: string;
  status: MandateStatus;
  current_version_id: string | null;
  created_at: Date;
}

export interface MandateVersion {
  id: string;
  mandate_id: string;
  /** Monotonic, starting at 1. */
  version: number;
  /** The original natural-language instruction, verbatim. */
  intent_text: string;
  /** The compiled, validated policy. Immutable once written. */
  policy: z.infer<typeof PolicySchema>;
  /** SHA-256 over canonicalizePolicy(policy). What the principal signs. */
  policy_hash: string;
  /** Agent ids this version delegates to. */
  agent_ids: string[];
  /** Populated when the principal authenticates this version with a passkey. */
  authenticated_at: Date | null;
  authentication_evidence_id: string | null;
  created_at: Date;
}

export interface AuthorizationRecord {
  id: string;
  organization_id: string;
  /** Who acted (D-35). Exactly one of agent_id/instrument_id is set,
   * matching this discriminator -- see ActorKind. */
  actor_kind: ActorKind;
  agent_id: string | null;
  instrument_id: string | null;
  principal_id: string;
  mandate_id: string;
  mandate_version_id: string;
  /** Denormalized so the decision is legible without a join. */
  policy_hash: string;
  status: AuthorizationStatus;
  decision: "ALLOW" | "DENY" | "STEP_UP";
  reason_codes: string[];
  action: ProposedAction;
  idempotency_key: string | null;
  /** A rail's own reference for this decision, e.g. a Stripe Issuing
   * authorization id (D-35) -- null for an agent-actor authorization. */
  external_ref: string | null;
  step_up_expires_at: Date | null;
  created_at: Date;
  decided_at: Date;
}

export interface TransactionRecord {
  id: string;
  organization_id: string;
  authorization_id: string;
  status: TransactionStatus;
  amount: number;
  currency: string;
  /** Adapter name: "stripe", "x402", ... */
  provider: string;
  provider_reference: string | null;
  created_at: Date;
}

/**
 * Append-only, hash-chained, signed event log. `previous_hash` links each
 * event to the one before it within an organization, so tampering is
 * detectable; `signature` (base64, Ed25519 over `hash`) is what makes it
 * verifiable by a third party who doesn't have to trust the database it
 * came from -- see DECISIONS.md D-26 / OQ-8.
 */
export interface EvidenceEvent {
  id: string;
  organization_id: string;
  sequence: number;
  type: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  previous_hash: string | null;
  hash: string;
  signature: string;
  created_at: Date;
}
