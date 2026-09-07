/**
 * Unit tests against a fake `fetch` -- no real server. Exercises the SDK's
 * own logic: error-code-to-exception mapping, the idempotency-key retry
 * behavior of `authorize()`, and the `asExecutable()` brand. The full
 * end-to-end journey against a real, listening server is
 * integration.test.ts; this file is deliberately narrow and fast.
 */

import { describe, expect, it, vi } from "vitest";
import type { AuthorizationStatus, Decision } from "@waysafe/core";
import {
  computeEventHash,
  exportPublicKeyBase64,
  generateEvidenceSigningKeyPair,
  signEventHash,
} from "@waysafe/core";
import {
  Waysafe,
  WaysafeError,
  AuthorizationStatusConflictError,
  ExecutionRejectedError,
  IdempotencyConflictError,
  NetworkError,
  NoActiveMandateError,
  NotFoundError,
  UnauthorizedError,
  UnknownRailError,
  ValidationError,
  asExecutable,
  verifyEvidenceIndependently,
  type AuthorizationDecision,
  type EvidenceRecord,
  type ExecutableDecision,
} from "./index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function receiptWith(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "auth_test",
    organization_id: "org_test",
    agent_id: "agt_test",
    principal_id: "prin_test",
    mandate_id: "mdt_test",
    mandate_version_id: "mdv_test",
    policy_hash: "hash",
    decision: "ALLOW" as Decision,
    status: "AUTHORIZED" as AuthorizationStatus,
    reasons: [{ code: "ALLOW_WITHIN_MANDATE", message: "ok" }],
    action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
    merchant: { trust: "VERIFIED", refs: [], resolution_source: "directory" },
    idempotency_key: "idk_test",
    step_up_expires_at: null,
    created_at: "2026-08-24T12:00:00.000Z",
    decided_at: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

function clientWith(fetchImpl: typeof globalThis.fetch) {
  return new Waysafe({ baseUrl: "https://api.example.test", apiKey: "wsf_live_testkey", fetch: fetchImpl });
}

describe("authorize()", () => {
  it("sends the Bearer credential and returns a decoded decision", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init: init! });
      return jsonResponse(201, receiptWith());
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const decision = await client.authorize({
      agent_id: "agt_test",
      principal_id: "prin_test",
      action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
    });

    expect(decision.authorization_id).toBe("auth_test");
    expect(decision.decision).toBe("ALLOW");
    expect(decision.reason_codes).toEqual(["ALLOW_WITHIN_MANDATE"]);
    expect(decision.replayed).toBe(false);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/authorizations");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer wsf_live_testkey");
  });

  it("generates an idempotency key when the caller doesn't supply one", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return jsonResponse(201, receiptWith());
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await client.authorize({
      agent_id: "agt_test",
      principal_id: "prin_test",
      action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
    });

    expect(typeof sentBody!.idempotency_key).toBe("string");
    expect((sentBody!.idempotency_key as string).length).toBeGreaterThanOrEqual(8);
  });

  it("preserves a caller-supplied idempotency key instead of generating one", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return jsonResponse(201, receiptWith());
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await client.authorize({
      agent_id: "agt_test",
      principal_id: "prin_test",
      action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
      idempotency_key: "my_own_key_123",
    });

    expect(sentBody!.idempotency_key).toBe("my_own_key_123");
  });

  it("reports replayed:true when the server answers with 200 (an existing decision), not 201", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, receiptWith()));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const decision = await client.authorize({
      agent_id: "agt_test",
      principal_id: "prin_test",
      action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
    });

    expect(decision.replayed).toBe(true);
  });

  it("THE ATTACK: a dropped connection is retried with the exact same idempotency key, not a fresh one", async () => {
    let attempts = 0;
    const seenKeys: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      seenKeys.push(body.idempotency_key);
      attempts += 1;
      if (attempts < 3) throw new TypeError("fetch failed");
      return jsonResponse(201, receiptWith());
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const decision = await client.authorize({
      agent_id: "agt_test",
      principal_id: "prin_test",
      action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
    });

    expect(attempts).toBe(3);
    expect(new Set(seenKeys).size).toBe(1);
    expect(decision.decision).toBe("ALLOW");
  });

  it("THE ATTACK: gives up after 3 attempts and surfaces a NetworkError, not an infinite retry", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(
      client.authorize({
        agent_id: "agt_test",
        principal_id: "prin_test",
        action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("THE ATTACK: a real HTTP error (not a network failure) is never retried -- retrying a validation error can't fix it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: "invalid_request", issues: [{ path: "/action/amount", message: "required" }] }),
    );
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(
      client.authorize({
        agent_id: "agt_test",
        principal_id: "prin_test",
        action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws NoActiveMandateError with the reasons on a 404 no_active_mandate", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, {
        error: "no_active_mandate",
        reasons: [{ code: "DENY_NO_ACTIVE_MANDATE", message: "no mandate" }],
      }),
    );
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const error = await client
      .authorize({
        agent_id: "agt_test",
        principal_id: "prin_test",
        action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoActiveMandateError);
    expect((error as NoActiveMandateError).reasons[0]!.code).toBe("DENY_NO_ACTIVE_MANDATE");
  });

  it("THE ATTACK: an idempotency key reused with a different request body throws IdempotencyConflictError carrying the existing decision, not a silently wrong answer", async () => {
    const existing = receiptWith({ id: "auth_original", action: { amount: 100, currency: "USD", merchant: {}, attestations: {} } });
    const fetchImpl = vi.fn(async () => jsonResponse(409, { error: "idempotency_conflict", existing }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const error = await client
      .authorize({
        agent_id: "agt_test",
        principal_id: "prin_test",
        action: { amount: 999, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
        idempotency_key: "reused_key",
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).existing.authorization_id).toBe("auth_original");
  });

  it("throws UnauthorizedError on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized", message: "bad key" }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(
      client.authorize({
        agent_id: "agt_test",
        principal_id: "prin_test",
        action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("falls back to the base WaysafeError for an unrecognized error shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "internal_error" }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const error = await client
      .authorize({
        agent_id: "agt_test",
        principal_id: "prin_test",
        action: { amount: 500, currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaysafeError);
    expect(error).not.toBeInstanceOf(ValidationError);
  });
});

describe("asExecutable() / execute()", () => {
  function decisionWith(status: AuthorizationStatus): AuthorizationDecision {
    return {
      authorization_id: "auth_test",
      organization_id: "org_test",
      agent_id: "agt_test",
      principal_id: "prin_test",
      mandate_id: "mdt_test",
      mandate_version_id: "mdv_test",
      policy_hash: "hash",
      decision: "ALLOW" as Decision,
      status,
      reason_codes: [],
      reasons: [],
      action: { amount: 500, currency: "USD", merchant: {}, attestations: {} },
      merchant: { trust: "VERIFIED", refs: [], resolution_source: "directory" },
      idempotency_key: null,
      step_up: null,
      created_at: "2026-08-24T12:00:00.000Z",
      decided_at: "2026-08-24T12:00:00.000Z",
      replayed: false,
    };
  }

  it("accepts AUTHORIZED and STEP_UP_APPROVED", () => {
    expect(asExecutable(decisionWith("AUTHORIZED"))).not.toBeNull();
    expect(asExecutable(decisionWith("STEP_UP_APPROVED"))).not.toBeNull();
  });

  it.each(["DENIED", "PENDING_STEP_UP", "STEP_UP_DECLINED", "EXPIRED"] as AuthorizationStatus[])(
    "THE ATTACK: rejects %s",
    (status) => {
      expect(asExecutable(decisionWith(status))).toBeNull();
    },
  );

  it("THE ATTACK: rejects EXECUTED -- this is what blocks double-execution", () => {
    expect(asExecutable(decisionWith("EXECUTED"))).toBeNull();
  });

  it("THE ATTACK, at the type level: a raw AuthorizationDecision cannot be passed where an ExecutableDecision is required", () => {
    const denied = decisionWith("DENIED");
    function requiresExecutable(_exec: ExecutableDecision): void {}

    // @ts-expect-error -- AuthorizationDecision is not ExecutableDecision, no
    // matter what its status field says at runtime. If this stops being a
    // type error, tsc fails the build on the unused @ts-expect-error, so
    // this proof can't silently rot.
    requiresExecutable(denied);
  });

  it("executes against the given rail and returns the updated decision", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), body: JSON.parse(init!.body as string) });
      return jsonResponse(200, receiptWith({ status: "EXECUTED" }));
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const executable = asExecutable(decisionWith("AUTHORIZED"))!;
    const result = await client.execute(executable, { rail: "stripe", paymentMethodRef: "pm_test" });

    expect(result.status).toBe("EXECUTED");
    expect(calls[0]!.url).toBe("https://api.example.test/v1/authorizations/auth_test/execute");
    expect(calls[0]!.body).toEqual({ rail: "stripe", payment_method_ref: "pm_test" });
  });

  it("throws ExecutionRejectedError on 402 execution_rejected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(402, { error: "execution_rejected", reason: "card_declined" }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);
    const executable = asExecutable(decisionWith("AUTHORIZED"))!;

    const error = await client.execute(executable, { rail: "stripe", paymentMethodRef: "pm_test" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutionRejectedError);
    expect((error as ExecutionRejectedError).reason).toBe("card_declined");
  });

  it("THE ATTACK: a double-execute attempt (already EXECUTED server-side) throws AuthorizationStatusConflictError with the blocking status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(409, { error: "not_executable", status: "EXECUTED" }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);
    const executable = asExecutable(decisionWith("AUTHORIZED"))!;

    const error = await client.execute(executable, { rail: "stripe", paymentMethodRef: "pm_test" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorizationStatusConflictError);
    expect((error as AuthorizationStatusConflictError).authorizationStatus).toBe("EXECUTED");
  });

  it("throws UnknownRailError on 400 unknown_rail", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "unknown_rail", rail: "carrier_pigeon" }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);
    const executable = asExecutable(decisionWith("AUTHORIZED"))!;

    const error = await client.execute(executable, { rail: "carrier_pigeon", paymentMethodRef: "pm_test" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownRailError);
    expect((error as UnknownRailError).rail).toBe("carrier_pigeon");
  });
});

describe("approveStepUp() / declineStepUp()", () => {
  it("approve posts outcome:approved and returns the updated decision", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return jsonResponse(200, receiptWith({ status: "STEP_UP_APPROVED" }));
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const result = await client.approveStepUp("auth_test");
    expect(sentBody).toEqual({ outcome: "approved" });
    expect(result.status).toBe("STEP_UP_APPROVED");
    expect(asExecutable(result)).not.toBeNull();
  });

  it("decline posts outcome:declined", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return jsonResponse(200, receiptWith({ status: "STEP_UP_DECLINED" }));
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const result = await client.declineStepUp("auth_test");
    expect(sentBody).toEqual({ outcome: "declined" });
    expect(asExecutable(result)).toBeNull();
  });

  it("THE ATTACK: answering a step-up twice throws AuthorizationStatusConflictError, not a silent no-op", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: "not_pending_step_up", status: "STEP_UP_DECLINED" }),
    );
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const error = await client.approveStepUp("auth_test").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorizationStatusConflictError);
  });
});

describe("verify()", () => {
  it("fetches the receipt for an authorization id", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse(200, receiptWith());
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const decision = await client.verify("auth_test");
    expect(decision.authorization_id).toBe("auth_test");
    expect(calls).toEqual(["GET https://api.example.test/v1/authorizations/auth_test"]);
  });

  it("throws NotFoundError for an unknown authorization id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: "not_found" }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.verify("auth_does_not_exist")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("dashboard reads: query strings and wire mapping", () => {
  it("listMandates sends ?limit= only when provided", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(url.toString());
      return jsonResponse(200, { mandates: [] });
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await client.listMandates();
    await client.listMandates({ limit: 25 });

    expect(calls[0]).toBe("https://api.example.test/v1/mandates");
    expect(calls[1]).toBe("https://api.example.test/v1/mandates?limit=25");
  });

  it("listEvidence sends ?subject= only when provided", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(url.toString());
      return jsonResponse(200, { events: [] });
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await client.listEvidence({ subject: "mdt_test" });
    expect(calls[0]).toBe("https://api.example.test/v1/evidence?subject=mdt_test");
  });

  it("listAuthorizations maps each receipt through the same decoder as authorize()", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { authorizations: [receiptWith(), receiptWith({ id: "auth_2" })] }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const list = await client.listAuthorizations();
    expect(list.map((d) => d.authorization_id)).toEqual(["auth_test", "auth_2"]);
  });

  it("verifyEvidenceChain passes the ok/brokenAtSequence/signed shape straight through", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: false, brokenAtSequence: 4, reason: "hash_mismatch" }));
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const result = await client.verifyEvidenceChain();
    expect(result).toEqual({ ok: false, brokenAtSequence: 4, reason: "hash_mismatch" });
  });

  it("getEvidencePublicKey requires no credential path and passes the key straight through", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(url.toString());
      return jsonResponse(200, { algorithm: "Ed25519", public_key: "deadbeef" });
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const result = await client.getEvidencePublicKey();
    expect(calls[0]).toBe("https://api.example.test/v1/evidence/public-key");
    expect(result).toEqual({ algorithm: "Ed25519", public_key: "deadbeef" });
  });
});

describe("verifyEvidenceIndependently (D-26/OQ-8): local verification, no server trust required", () => {
  const KEY_PAIR = generateEvidenceSigningKeyPair();
  const PUBLIC_KEY_BASE64 = exportPublicKeyBase64(KEY_PAIR.publicKey);

  function signedChain(length: number): EvidenceRecord[] {
    const events: EvidenceRecord[] = [];
    let previousHash: string | null = null;

    for (let i = 0; i < length; i++) {
      const sequence = i + 1;
      const createdAt = new Date(2026, 0, 1, 0, 0, sequence).toISOString();
      const payload = { note: `event ${sequence}` };
      const hash = computeEventHash({
        organization_id: "org_test",
        sequence,
        type: "test.event",
        subject_type: "test",
        subject_id: `subject_${sequence}`,
        payload,
        previous_hash: previousHash,
        created_at: createdAt,
      });
      events.push({
        id: `ev_${sequence}`,
        organization_id: "org_test",
        sequence,
        type: "test.event",
        subject_type: "test",
        subject_id: `subject_${sequence}`,
        payload,
        previous_hash: previousHash,
        hash,
        signature: signEventHash(KEY_PAIR.privateKey, hash),
        created_at: createdAt,
      });
      previousHash = hash;
    }
    return events;
  }

  it("verifies a genuinely signed chain fetched as wire JSON (string dates, no Date objects)", () => {
    const events = signedChain(4);
    expect(verifyEvidenceIndependently(events, PUBLIC_KEY_BASE64)).toEqual({ ok: true, signed: true });
  });

  it("THE ATTACK: a chain signed under a different key fails, even though every hash and link is self-consistent", () => {
    const events = signedChain(3);
    const otherKey = exportPublicKeyBase64(generateEvidenceSigningKeyPair().publicKey);
    const result = verifyEvidenceIndependently(events, otherKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("THE ATTACK: a tampered payload with a stale signature is caught without ever calling this server again", () => {
    const events = signedChain(3);
    events[1]!.payload = { note: "forged after the fact" };
    const result = verifyEvidenceIndependently(events, PUBLIC_KEY_BASE64);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSequence).toBe(2);
    expect(result.reason).toBe("hash_mismatch");
  });
});

describe("write helpers pass method, path, and body through unmodified", () => {
  it("createMandate", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: init!.method!, url: url.toString(), body: JSON.parse(init!.body as string) });
      return jsonResponse(201, { mandate_id: "mdt_x", mandate_version_id: "mdv_x", policy_hash: "h", status: "PENDING_AUTHENTICATION" });
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const request = { principal_id: "prin_1", agent_ids: ["agt_1"], policy: {}, intent_text: "test" };
    const created = await client.createMandate(request);

    expect(calls[0]).toEqual({ method: "POST", url: "https://api.example.test/v1/mandates", body: request });
    expect(created.mandate_id).toBe("mdt_x");
  });

  it("createAgentKey", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { key_id: "key_1", prefix: "wsf_live_abcd", api_key: "wsf_live_abcd1234secret", created_at: "2026-08-24T12:00:00.000Z" }),
    );
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const created = await client.createAgentKey("agt_1", { name: "prod bot" });
    expect(created.api_key).toBe("wsf_live_abcd1234secret");
  });

  it("revokeAgentKey issues a DELETE and resolves with no return value", async () => {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: init!.method!, url: url.toString() });
      return new Response(null, { status: 204 });
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    await client.revokeAgentKey("agt_1", "key_1");
    expect(calls[0]).toEqual({ method: "DELETE", url: "https://api.example.test/v1/agents/agt_1/keys/key_1" });
  });

  it("getMandateAuthenticationOptions / verifyMandateAuthentication", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(url.toString());
      if (url.toString().endsWith("/options")) {
        return jsonResponse(200, { mode: "register", challenge: "chal", rp_id: "localhost", origin: "http://localhost:3000", principal_id: "prin_1" });
      }
      return jsonResponse(200, { kind: "registered", credentialId: "cred_1" });
    });
    const client = clientWith(fetchImpl as unknown as typeof globalThis.fetch);

    const options = await client.getMandateAuthenticationOptions("mdt_1");
    expect(options.mode).toBe("register");

    const result = await client.verifyMandateAuthentication("mdt_1", {
      mode: "register",
      challenge: options.challenge,
      response: { fake: "response" },
    });
    expect(result).toEqual({ kind: "registered", credentialId: "cred_1" });
  });
});

describe("no API key configured", () => {
  it("omits the Authorization header entirely rather than sending 'Bearer undefined'", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(init!);
      return jsonResponse(200, { reason_codes: [] });
    });
    const client = new Waysafe({ baseUrl: "https://api.example.test", fetch: fetchImpl as unknown as typeof globalThis.fetch });

    await client.listReasonCodes();
    expect((calls[0]!.headers as Record<string, string>).authorization).toBeUndefined();
  });
});
