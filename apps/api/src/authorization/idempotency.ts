/**
 * Idempotency key replay safety.
 *
 * `idempotency_key` is unique per organization (D: schema
 * `@@unique([organizationId, idempotencyKey])`). Reusing a key replays the
 * stored result *only if the request body is byte-for-byte the request that
 * created it* — otherwise it's rejected, because silently returning a stale
 * decision for a different amount or merchant is a worse failure mode than an
 * error.
 */

import { createHash } from "node:crypto";
import type { AuthorizationRequest } from "@bles/core";

/** SHA-256 over the request fields that determine the decision. */
export function hashAuthorizationRequest(request: AuthorizationRequest): string {
  const canonical = {
    agent_id: request.agent_id,
    principal_id: request.principal_id,
    mandate_id: request.mandate_id ?? null,
    action: sortKeysDeep(request.action),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}
