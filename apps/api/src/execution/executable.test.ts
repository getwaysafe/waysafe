import { describe, expect, it } from "vitest";
import type { AuthorizationStatus, Decision } from "@waysafe/core";
import type { StoredAuthorization } from "../authorization/types.js";
import { asExecutable, type ExecutableAuthorization } from "./executable.js";

function authorizationWith(status: AuthorizationStatus): StoredAuthorization {
  return {
    id: "auth_test",
    organization_id: "org_test",
    actor_kind: "agent",
    agent_id: "agt_test",
    instrument_id: null,
    principal_id: "prin_test",
    mandate_id: "mdt_test",
    mandate_version_id: "mdv_test",
    policy_hash: "hash",
    decision: "ALLOW" as Decision,
    status,
    reasons: [],
    action: {
      amount: 100,
      currency: "USD",
      merchant: {},
      attestations: {},
    },
    merchant: { trust: "VERIFIED", refs: [], resolution_source: "directory" },
    idempotency_key: null,
    request_hash: null,
    external_ref: null,
    step_up_expires_at: null,
    created_at: new Date().toISOString(),
    decided_at: new Date().toISOString(),
  };
}

describe("asExecutable", () => {
  it("accepts AUTHORIZED", () => {
    expect(asExecutable(authorizationWith("AUTHORIZED"))).not.toBeNull();
  });

  it("accepts STEP_UP_APPROVED", () => {
    expect(asExecutable(authorizationWith("STEP_UP_APPROVED"))).not.toBeNull();
  });

  it.each([
    "DENIED",
    "PENDING_STEP_UP",
    "STEP_UP_DECLINED",
    "EXPIRED",
  ] as AuthorizationStatus[])("THE ATTACK: rejects %s", (status) => {
    expect(asExecutable(authorizationWith(status))).toBeNull();
  });

  it("THE ATTACK: rejects EXECUTED -- this is what blocks double-execution", () => {
    expect(asExecutable(authorizationWith("EXECUTED"))).toBeNull();
  });

  it("THE ATTACK, at the type level: a raw StoredAuthorization cannot be passed where an ExecutableAuthorization is required", () => {
    const denied = authorizationWith("DENIED");

    function requiresExecutable(_exec: ExecutableAuthorization): void {}

    // @ts-expect-error -- StoredAuthorization is not ExecutableAuthorization,
    // no matter what its status field says at runtime. If this stops being
    // a type error, tsc fails the build on the unused @ts-expect-error, so
    // this proof can't silently rot.
    requiresExecutable(denied);
  });
});
