/**
 * D-44: the honesty boundary for Act 2 and Act 3's server-sourced
 * decisions. Unlike `/story`, which calls the real `evaluate()` directly
 * in the browser (`@waysafe/core/browser`) and can stub that import
 * directly in a test, `/film`'s card and stablecoin decisions run inside
 * `apps/api` (the real Stripe Issuing adapter, the real x402/Safe path) --
 * this browser page only ever sees their HTTP responses. The equivalent
 * invariant here is narrower but just as load-bearing: these normalizer
 * functions are the *only* path `FilmClient.tsx` uses to turn a fetch
 * response into something rendered, and every one of them throws rather
 * than defaulting when the field that actually carries the real decision
 * is missing or the wrong shape. A caller cannot get a `CardAttemptResult`,
 * `StablecoinPayResult`, or `StablecoinRejection` out of a malformed
 * response by silently falling back to some assumed outcome -- see
 * `api-decisions.test.ts`'s "refuses to render" cases, which assert
 * exactly that failure mode for a payload with its decision field
 * stripped out.
 */

export interface CardAttemptResult {
  label: string;
  amountCents: number;
  decision: "ALLOW" | "DENY";
  reasonCodes: string[];
  /** The real Authorization row's id (D-45) -- the join key for finding
   * this exact decision's own EvidenceEvent in the fetched chain, for the
   * real Act 3 receipt. */
  authorizationId: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`refusing to render: expected a string at "${field}", got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`refusing to render: expected a number at "${field}", got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`refusing to render: expected a string array at "${field}", got ${JSON.stringify(value)}`);
  }
  return value;
}

/** `raw` is one entry of `POST /v1/demo/enforcement/stripe-issuing`'s
 * `attempts` array (proxied by `/api/demo/card`) -- the real
 * `StripeIssuingAdapter`'s response, never invented here. `approved` is
 * the one field that actually carries `evaluate()`'s decision; there is no
 * branch that produces a `CardAttemptResult` without reading it. */
export function normalizeCardAttempt(raw: unknown): CardAttemptResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("refusing to render: card attempt result is not an object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.approved !== "boolean") {
    throw new Error('refusing to render: card attempt result has no real "approved" decision field');
  }
  return {
    label: requireString(r.label, "label"),
    amountCents: requireNumber(r.amount_cents, "amount_cents"),
    decision: r.approved ? "ALLOW" : "DENY",
    reasonCodes: requireStringArray(r.reason_codes, "reason_codes"),
    authorizationId: requireString(r.authorization_id, "authorization_id"),
  };
}

export interface CardReplayResult {
  mandateVersionId: string;
  policyHash: string;
  attempts: CardAttemptResult[];
}

/** `raw` is `POST /v1/demo/enforcement/stripe-issuing`'s full response body
 * (proxied by `/api/demo/card`). `mandate_version_id`/`policy_hash` are the
 * real mandate's own values (D-45) -- the Act 3 receipt cites these
 * directly rather than a placeholder, so this throws just like
 * `normalizeCardAttempt` does when either is missing. */
export function normalizeCardReplayResult(raw: unknown): CardReplayResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("refusing to render: card replay result is not an object");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.attempts)) {
    throw new Error('refusing to render: card replay result has no "attempts" array');
  }
  return {
    mandateVersionId: requireString(r.mandate_version_id, "mandate_version_id"),
    policyHash: requireString(r.policy_hash, "policy_hash"),
    attempts: r.attempts.map(normalizeCardAttempt),
  };
}

export interface StablecoinPayResult {
  decision: "ALLOW" | "DENY" | "STEP_UP";
  reasonCodes: string[];
  settlementTxHash: string | null;
}

const VALID_DECISIONS = new Set(["ALLOW", "DENY", "STEP_UP"]);

/** `raw` is `POST /v1/enforcement/x402`'s response body, proxied by
 * `/api/demo/pay` -- `decision` is `evaluate()`'s own output, per
 * `packages/core/src/reason-codes.ts`'s `Decision` union; this function
 * only accepts the three real values and throws on anything else, so a
 * response body that lost or mangled that field can never be rendered as
 * if it said ALLOW. */
export function normalizeStablecoinPayResult(raw: unknown): StablecoinPayResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("refusing to render: stablecoin pay result is not an object");
  }
  const r = raw as Record<string, unknown>;
  const decision = requireString(r.decision, "decision");
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error(`refusing to render: unrecognized decision "${decision}"`);
  }
  const settlement = r.settlement as Record<string, unknown> | null | undefined;
  const txHash = settlement && typeof settlement.tx_hash === "string" ? settlement.tx_hash : null;
  return {
    decision: decision as StablecoinPayResult["decision"],
    reasonCodes: requireStringArray(r.reason_codes, "reason_codes"),
    settlementTxHash: txHash,
  };
}

export interface StablecoinRejection {
  name: string;
  description: string;
  rejected: boolean;
  revertReason: string | null;
}

/** `raw` is one entry of `POST /v1/enforcement/x402/bypass-proof`'s
 * `cases` array, proxied by `/api/demo/bypass` -- `rejected` is a real
 * `eth_call` result against the deployed Safe (D-41), never a client-side
 * guess about what the chain would do. */
export function normalizeStablecoinRejection(raw: unknown): StablecoinRejection {
  if (!raw || typeof raw !== "object") {
    throw new Error("refusing to render: stablecoin rejection case is not an object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.rejected !== "boolean") {
    throw new Error('refusing to render: rejection case has no real "rejected" outcome field');
  }
  return {
    name: requireString(r.name, "name"),
    description: requireString(r.description, "description"),
    rejected: r.rejected,
    revertReason: typeof r.revert_reason === "string" ? r.revert_reason : null,
  };
}
