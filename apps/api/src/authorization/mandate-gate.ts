/**
 * "Is this mandate still allowed to spend?" -- in one place (D-73).
 *
 * `gateMandateStatus` lived privately in `enforcement/stripe-issuing.ts`,
 * where the card rail needed it. D-73 needed the same question answered on
 * the step-up approval path, and a second copy of a table mapping mandate
 * status to reason code is exactly the kind of duplication that drifts
 * silently -- one copy gains a status the other never hears about. Moved
 * here verbatim instead, so both callers read one table.
 *
 * Expiry is deliberately a separate function rather than folded in.
 * `MandateStatus.EXPIRED` is a *row* that something has already marked
 * expired; a policy's own `expires_at` passing is a *clock* fact that nothing
 * has written down yet. The engine already denies on the latter
 * (`evaluateExpiry`, same `DENY_MANDATE_EXPIRED` code), so the card rail
 * keeps calling only `gateMandateStatus` and its behaviour is unchanged --
 * an expired policy there still reaches `evaluate()` and is denied with the
 * same code it always was. The approval path has no `evaluate()` call against
 * the *original* mandate's policy, which is why it needs this explicitly.
 */

import { ReasonCode, type MandateStatus, type Reason } from "@waysafe/core";
import type { MandateDetail } from "./types.js";

/**
 * Reasons this mandate cannot authorize spend, or `null` if it can.
 *
 * Moved from `stripe-issuing.ts` unchanged, including the `DENY_NO_ACTIVE_MANDATE`
 * fallback for a status the table does not name -- so a status added to the
 * enum later fails closed rather than passing silently.
 */
export function gateMandateStatus(detail: MandateDetail | null): Reason[] | null {
  if (!detail) {
    return [
      {
        code: ReasonCode.DENY_NO_ACTIVE_MANDATE,
        message: "No mandate is associated with the instrument presented for this authorization.",
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

/**
 * Reasons this mandate's own policy has lapsed as of `now`, or `null`.
 *
 * The same `expires_at` check and the same reason code the engine applies
 * (`evaluateExpiry`), available to a caller that does not run the engine
 * against this mandate's policy -- which the approval path does not: it runs
 * `evaluate()` against the *approver's* policy, so the original mandate's own
 * expiry would otherwise never be consulted again after the step-up was
 * raised.
 */
export function gateMandateExpiry(detail: MandateDetail | null, now: Date): Reason[] | null {
  if (!detail) return null; // absence is `gateMandateStatus`'s answer to give
  if (now.getTime() < new Date(detail.policy.expires_at).getTime()) return null;
  return [
    {
      code: ReasonCode.DENY_MANDATE_EXPIRED,
      message: `The mandate expired at ${detail.policy.expires_at}.`,
      policy_path: "/expires_at",
      detail: { expires_at: detail.policy.expires_at, now: now.toISOString() },
    },
  ];
}
