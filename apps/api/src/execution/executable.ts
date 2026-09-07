/**
 * Makes it a compile error to execute a DENIED or PENDING_STEP_UP
 * authorization -- not a runtime guard clause a later edit could
 * accidentally route around.
 *
 * `ExecutableAuthorization` is branded with a property keyed by a
 * module-private `unique symbol`. TypeScript's structural typing normally
 * lets any code construct a value shaped like an interface just by
 * matching its fields; a symbol that is never exported closes that hole --
 * there is no way to write `{ [EXECUTABLE]: true, ... }` from outside this
 * file, because the symbol itself isn't nameable outside it. `asExecutable`
 * is the only function that can produce one, and it only does so for
 * `AUTHORIZED` or `STEP_UP_APPROVED` -- exactly the two states Week 4's
 * exit criteria says are allowed to reach a rail. Every other status
 * (`DENIED`, `PENDING_STEP_UP`, `STEP_UP_DECLINED`, `EXPIRED`, and -- this
 * is what blocks double-execution -- `EXECUTED` itself) returns `null`.
 *
 * `executePayment` (service.ts) accepts only `ExecutableAuthorization`, so
 * passing a raw `StoredAuthorization` there, DENIED or not, doesn't
 * typecheck. See `executable.test.ts` for a `@ts-expect-error`-anchored
 * proof: `tsc` fails the build if that line ever stops being a type error.
 */

import type { AuthorizationStatus } from "@waysafe/core";
import type { StoredAuthorization } from "../authorization/types.js";

const EXECUTABLE: unique symbol = Symbol("executable");

export interface ExecutableAuthorization {
  readonly [EXECUTABLE]: true;
  readonly authorization: StoredAuthorization;
}

const EXECUTABLE_STATUSES: ReadonlySet<AuthorizationStatus> = new Set([
  "AUTHORIZED",
  "STEP_UP_APPROVED",
]);

/** The only constructor. Null for any status that isn't currently executable. */
export function asExecutable(authorization: StoredAuthorization): ExecutableAuthorization | null {
  if (!EXECUTABLE_STATUSES.has(authorization.status)) return null;
  return { [EXECUTABLE]: true, authorization };
}
