import { describe, expect, it, vi } from "vitest";
import {
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  Decision,
  ReasonCode,
  createStaticDirectory,
  generateEvidenceSigningKeyPair,
  type Policy,
  type AuthorizationRequest,
} from "@waysafe/core";
import { InMemoryAuthorizationRepository } from "./in-memory-repository.js";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import {
  authorize,
  resolveStepUp,
  resolveStepUpAsApprover,
  sweepExpiredStepUps,
  type AuthorizeRepos,
} from "./service.js";
import { MandateCreationError } from "./types.js";

const ORG = "org_test";
const PRINCIPAL = "prin_test";
const AGENT = "agt_test";

const DIRECTORY = createStaticDirectory([
  { domain: "amazon.com", display_name: "Amazon" },
  { domain: "staples.com", display_name: "Staples" },
  { domain: "bestbuy.com", display_name: "Best Buy" },
]);

function policyFrom(overrides: Record<string, unknown>): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "test",
    currency: "USD",
    merchants: {
      allow: [
        { scheme: "domain", value: "amazon.com", label: "Amazon" },
        { scheme: "domain", value: "staples.com", label: "Staples" },
      ],
      deny: [],
      unlisted: "STEP_UP",
    },
    categories: {
      allow: ["office_supplies"],
      deny: ["gambling", "cash_advance", "crypto", "adult", "firearms"],
      deny_mcc: [],
      unlisted: "ALLOW",
    },
    cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
    step_up: { above_amount: toMinorUnits(150, "USD"), ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-09-23T12:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

const NOW = new Date("2026-08-24T12:00:00.000Z");

async function repoWithMandate(policy: Policy, overrides: Record<string, unknown> = {}) {
  const repo = new InMemoryAuthorizationRepository(DIRECTORY);
  const agentKeys = new InMemoryAgentKeyRepository();
  const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
  const seeded = repo.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy,
    policyHash: "test-hash",
    ...overrides,
  });
  const created = await agentKeys.createKey(
    { organizationId: ORG, agentId: AGENT, name: "test key" },
    NOW,
  );
  const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
  return { repo, repos, agentKeys, evidence, apiKey: created.fullKey, ...seeded };
}

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    agent_id: AGENT,
    principal_id: PRINCIPAL,
    action: {
      amount: toMinorUnits(83, "USD"),
      currency: "USD",
      merchant: { domain: "staples.com" },
      category: "office_supplies",
      attestations: {},
    },
    context: {},
    ...overrides,
  } as AuthorizationRequest;
}

describe("authorize() end-to-end", () => {
  it("ALLOWs Staples $83", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request(),
      now: NOW,
      apiKey,
    });
    expect(result.kind).toBe("decided");
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.ALLOW);
    expect(result.authorization.status).toBe("AUTHORIZED");
  });

  it("STEP_UPs Staples $203 (above the step-up threshold)", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(203, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.STEP_UP);
    expect(result.authorization.status).toBe("PENDING_STEP_UP");
    expect(result.authorization.step_up_expires_at).not.toBeNull();
  });

  it("STEP_UPs Best Buy $87 (verified but unlisted merchant)", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(87, "USD"),
          currency: "USD",
          merchant: { domain: "bestbuy.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.STEP_UP);
    expect(result.authorization.reasons.map((r) => r.code)).toEqual([
      ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
    ]);
  });

  it("DENYs $50 at an unapproved gambling merchant", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(50, "USD"),
          currency: "USD",
          merchant: { name: "Lucky Spin Casino", domain: "luckyspincasino.example" },
          category: "gambling",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.DENY);
    expect(result.authorization.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_CATEGORY_BLOCKED,
    ]);
  });
});

describe("D-34: merchant trust is a function of who attested it, not which field it's in", () => {
  it(
    "THE ATTACK: an agent asserting an allowlisted psp_account via the authorize path " +
      "is capped at STEP_UP with the unverified-merchant reason, not ALLOW",
    async () => {
      const policy = policyFrom({
        merchants: {
          allow: [{ scheme: "psp_account", value: "acct_real_staples" }],
          deny: [],
          unlisted: "STEP_UP",
        },
      });
      const { repos, apiKey } = await repoWithMandate(policy);
      const result = await authorize(repos, {
        organizationId: ORG,
        request: request({
          action: {
            amount: toMinorUnits(83, "USD"),
            currency: "USD",
            // The agent asserts a psp_account it does not actually
            // transact through -- no accompanying domain, so directory
            // corroboration can't verify it by a different path and mask
            // whether this fix actually holds.
            merchant: { psp_account: "acct_real_staples" },
            attestations: {},
          },
        }),
        now: NOW,
        apiKey,
      });
      if (result.kind !== "decided") throw new Error("unreachable");
      expect(result.authorization.decision).toBe(Decision.STEP_UP);
      expect(result.authorization.reasons.map((r) => r.code)).toEqual([
        ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
      ]);
    },
  );

  it(
    "THE ATTACK: an agent asserting an allowlisted network_mid via the authorize path " +
      "is capped at STEP_UP with the unverified-merchant reason, not ALLOW",
    async () => {
      const policy = policyFrom({
        merchants: {
          allow: [{ scheme: "network_mid", value: "visa_mid_real_staples" }],
          deny: [],
          unlisted: "STEP_UP",
        },
      });
      const { repos, apiKey } = await repoWithMandate(policy);
      const result = await authorize(repos, {
        organizationId: ORG,
        request: request({
          action: {
            amount: toMinorUnits(83, "USD"),
            currency: "USD",
            merchant: { network_mid: "visa_mid_real_staples" },
            attestations: {},
          },
        }),
        now: NOW,
        apiKey,
      });
      if (result.kind !== "decided") throw new Error("unreachable");
      expect(result.authorization.decision).toBe(Decision.STEP_UP);
      expect(result.authorization.reasons.map((r) => r.code)).toEqual([
        ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
      ]);
    },
  );
});

describe("D-35: an authorization can never be saved with both or neither actor set", () => {
  it("THE ATTACK: rejects neither agentId nor instrumentId set", async () => {
    const { repo, mandateId, mandateVersionId, policyHash } = await repoWithMandate(policyFrom({}));
    await expect(
      repo.saveAuthorization({
        id: "auth_bad_1",
        organizationId: ORG,
        actorKind: "agent",
        agentId: null,
        instrumentId: null,
        principalId: PRINCIPAL,
        mandateId,
        mandateVersionId,
        policyHash,
        decision: Decision.ALLOW,
        status: "AUTHORIZED",
        reasons: [{ code: ReasonCode.ALLOW_WITHIN_MANDATE, message: "ok" }],
        action: request().action,
        merchant: { trust: "VERIFIED", refs: [], resolution_source: "directory" },
        idempotencyKey: null,
        requestHash: null,
        stepUpExpiresAt: null,
        now: NOW,
        ledgerEntries: [],
      }),
    ).rejects.toThrow(/invalid actor/);
  });

  it("THE ATTACK: rejects both agentId and instrumentId set", async () => {
    const { repo, mandateId, mandateVersionId, policyHash } = await repoWithMandate(policyFrom({}));
    await expect(
      repo.saveAuthorization({
        id: "auth_bad_2",
        organizationId: ORG,
        actorKind: "instrument",
        agentId: AGENT,
        instrumentId: "inst_test",
        principalId: PRINCIPAL,
        mandateId,
        mandateVersionId,
        policyHash,
        decision: Decision.ALLOW,
        status: "AUTHORIZED",
        reasons: [{ code: ReasonCode.ALLOW_WITHIN_MANDATE, message: "ok" }],
        action: request().action,
        merchant: { trust: "VERIFIED", refs: [], resolution_source: "directory" },
        idempotencyKey: null,
        requestHash: null,
        stepUpExpiresAt: null,
        now: NOW,
        ledgerEntries: [],
      }),
    ).rejects.toThrow(/invalid actor/);
  });

  it("THE ATTACK: rejects actorKind disagreeing with which field is set", async () => {
    const { repo, mandateId, mandateVersionId, policyHash } = await repoWithMandate(policyFrom({}));
    await expect(
      repo.saveAuthorization({
        id: "auth_bad_3",
        organizationId: ORG,
        actorKind: "agent",
        agentId: null,
        instrumentId: "inst_test",
        principalId: PRINCIPAL,
        mandateId,
        mandateVersionId,
        policyHash,
        decision: Decision.ALLOW,
        status: "AUTHORIZED",
        reasons: [{ code: ReasonCode.ALLOW_WITHIN_MANDATE, message: "ok" }],
        action: request().action,
        merchant: { trust: "VERIFIED", refs: [], resolution_source: "directory" },
        idempotencyKey: null,
        requestHash: null,
        stepUpExpiresAt: null,
        now: NOW,
        ledgerEntries: [],
      }),
    ).rejects.toThrow(/invalid actor/);
  });

  it("accepts a valid instrument actor", async () => {
    const { repo, mandateId, mandateVersionId, policyHash } = await repoWithMandate(policyFrom({}));
    const saved = await repo.saveAuthorization({
      id: "auth_good_instrument",
      organizationId: ORG,
      actorKind: "instrument",
      agentId: null,
      instrumentId: "inst_test",
      principalId: PRINCIPAL,
      mandateId,
      mandateVersionId,
      policyHash,
      decision: Decision.ALLOW,
      status: "AUTHORIZED",
      reasons: [{ code: ReasonCode.ALLOW_WITHIN_MANDATE, message: "ok" }],
      action: request().action,
      merchant: { trust: "VERIFIED", refs: [], resolution_source: "directory" },
      idempotencyKey: null,
      requestHash: null,
      stepUpExpiresAt: null,
      now: NOW,
      ledgerEntries: [],
    });
    expect(saved.actor_kind).toBe("instrument");
    expect(saved.instrument_id).toBe("inst_test");
    expect(saved.agent_id).toBeNull();
  });
});

describe("the actor-state gate (outside the pure engine)", () => {
  it("denies when no mandate matches and does not persist anything", async () => {
    const repo = new InMemoryAuthorizationRepository(DIRECTORY);
    const agentKeys = new InMemoryAgentKeyRepository();
    const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const created = await agentKeys.createKey(
      { organizationId: ORG, agentId: AGENT, name: "test key" },
      NOW,
    );
    const result = await authorize(
      { authorization: repo, agentKeys, evidence },
      { organizationId: ORG, request: request(), now: NOW, apiKey: created.fullKey },
    );
    expect(result.kind).toBe("no_mandate");
    if (result.kind !== "no_mandate") throw new Error("unreachable");
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_NO_ACTIVE_MANDATE);
  });

  it("denies and persists against a revoked mandate", async () => {
    const { repos, apiKey, mandateId } = await repoWithMandate(policyFrom({}), {
      status: "REVOKED",
    });
    // Explicit mandate_id: a revoked mandate can never be found by the
    // implicit active-mandate lookup, which is the point of this test --
    // the agent already knows which (now-revoked) mandate it's citing.
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({ mandate_id: mandateId }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.DENY);
    expect(result.authorization.mandate_id).toBe(mandateId);
    expect(result.authorization.reasons[0]?.code).toBe(ReasonCode.DENY_MANDATE_REVOKED);
  });

  it("denies an unauthenticated mandate", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}), { authenticatedAt: null });
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request(),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.reasons[0]?.code).toBe(
      ReasonCode.DENY_MANDATE_NOT_AUTHENTICATED,
    );
  });

  it("denies a suspended agent", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}), {
      agentStatus: "SUSPENDED",
    });
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request(),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.reasons[0]?.code).toBe(ReasonCode.DENY_AGENT_SUSPENDED);
  });

  it("denies an agent not bound to the mandate", async () => {
    const { repos, apiKey, mandateId } = await repoWithMandate(policyFrom({}), {
      boundAgentIds: ["agt_someone_else"],
    });
    // Explicit mandate_id: the implicit lookup only finds mandates that
    // already bind this agent, so an unbound agent needs a cited mandate too.
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({ mandate_id: mandateId }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.reasons[0]?.code).toBe(ReasonCode.DENY_AGENT_NOT_BOUND);
  });

  it("denies a principal mismatch", async () => {
    const { repos, apiKey, mandateId } = await repoWithMandate(policyFrom({}));
    // Explicit mandate_id: the implicit lookup filters by principal, so a
    // mismatch needs a cited mandate to reach the mismatch check at all.
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({ principal_id: "prin_someone_else", mandate_id: mandateId }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.reasons[0]?.code).toBe(ReasonCode.DENY_PRINCIPAL_MISMATCH);
  });
});

describe("agent API keys (D-18)", () => {
  it("THE ATTACK: a revoked key does not authorize, even for an otherwise-ALLOW request", async () => {
    const { repos, agentKeys } = await repoWithMandate(policyFrom({}));
    const revocable = await agentKeys.createKey(
      { organizationId: ORG, agentId: AGENT, name: "revocable key" },
      NOW,
    );
    await agentKeys.revokeKey(revocable.id, ORG, NOW);

    const result = await authorize(repos, {
      organizationId: ORG,
      request: request(),
      now: NOW,
      apiKey: revocable.fullKey,
    });

    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.DENY);
    expect(result.authorization.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_AGENT_NOT_BOUND,
    ]);
  });

  it("THE ATTACK: an unknown/forged key does not authorize", async () => {
    const { repos } = await repoWithMandate(policyFrom({}));

    const result = await authorize(repos, {
      organizationId: ORG,
      request: request(),
      now: NOW,
      apiKey: "wsf_live_00000000forgedsecretvaluenotreal",
    });

    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.DENY);
    expect(result.authorization.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_AGENT_NOT_BOUND,
    ]);
  });

  it("THE ATTACK: a key that belongs to a different agent does not authorize the claimed agent_id", async () => {
    const { repos, agentKeys } = await repoWithMandate(policyFrom({}), {
      boundAgentIds: [AGENT, "agt_other"],
    });
    const otherKey = await agentKeys.createKey(
      { organizationId: ORG, agentId: "agt_other", name: "other agent's key" },
      NOW,
    );

    // request() claims AGENT, but the key presented belongs to agt_other.
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({ agent_id: AGENT }),
      now: NOW,
      apiKey: otherKey.fullKey,
    });

    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.DENY);
    expect(result.authorization.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_AGENT_NOT_BOUND,
    ]);
  });

  it("THE ATTACK: a key that belongs to a different organization does not authorize", async () => {
    const { repos, agentKeys } = await repoWithMandate(policyFrom({}));
    const foreignKey = await agentKeys.createKey(
      { organizationId: "org_other", agentId: AGENT, name: "wrong org's key" },
      NOW,
    );

    const result = await authorize(repos, {
      organizationId: ORG,
      request: request(),
      now: NOW,
      apiKey: foreignKey.fullKey,
    });

    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.decision).toBe(Decision.DENY);
    expect(result.authorization.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_AGENT_NOT_BOUND,
    ]);
  });

  it("writes an EvidenceEvent for both a successful and a rejected key check", async () => {
    const { repos, evidence, apiKey } = await repoWithMandate(policyFrom({}));

    await authorize(repos, { organizationId: ORG, request: request(), now: NOW, apiKey });
    await authorize(repos, {
      organizationId: ORG,
      request: request(),
      now: NOW,
      apiKey: "wsf_live_00000000forgedsecretvaluenotreal",
    });

    const events = await evidence.listForOrganization(ORG);
    const types = events.filter((e) => e.subject_type === "agent").map((e) => e.type);
    expect(types).toEqual(["agent_key.verified", "agent_key.rejected"]);
  });

  it("THE ATTACK: the check is not bypassable by calling the service directly -- evaluate() is never reached for a rejected key", async () => {
    const core = await import("@waysafe/core");
    const evaluateSpy = vi.spyOn(core, "evaluate");

    const { repos } = await repoWithMandate(policyFrom({}));
    // A request that would ALLOW if the key check didn't run first: real
    // mandate, real principal, merchant on the allowlist, amount within
    // every limit.
    await authorize(repos, {
      organizationId: ORG,
      request: request(),
      now: NOW,
      apiKey: "wsf_live_00000000forgedsecretvaluenotreal",
    });

    expect(evaluateSpy).not.toHaveBeenCalled();
    evaluateSpy.mockRestore();
  });

  it("sanity check for the spy above: evaluate() IS reached once the key is valid", async () => {
    const core = await import("@waysafe/core");
    const evaluateSpy = vi.spyOn(core, "evaluate");

    const { repos, apiKey } = await repoWithMandate(policyFrom({}));
    await authorize(repos, { organizationId: ORG, request: request(), now: NOW, apiKey });

    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    evaluateSpy.mockRestore();
  });
});

describe("idempotency", () => {
  it("replays the same result for the same key and body", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}));
    const req = request({ idempotency_key: "key-12345678" });
    const first = await authorize(repos, { organizationId: ORG, request: req, now: NOW, apiKey });
    const second = await authorize(repos, {
      organizationId: ORG,
      request: req,
      now: NOW,
      apiKey,
    });
    if (first.kind !== "decided" || second.kind !== "decided") throw new Error("unreachable");
    expect(second.authorization.id).toBe(first.authorization.id);
    expect(second.replayed).toBe(true);
  });

  it("rejects the same key with a different body instead of replaying", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}));
    const first = await authorize(repos, {
      organizationId: ORG,
      request: request({ idempotency_key: "key-12345678" }),
      now: NOW,
      apiKey,
    });
    const second = await authorize(repos, {
      organizationId: ORG,
      request: request({
        idempotency_key: "key-12345678",
        action: {
          amount: toMinorUnits(999, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    expect(second.kind).toBe("idempotency_conflict");
    if (first.kind !== "decided" || second.kind !== "idempotency_conflict") {
      throw new Error("unreachable");
    }
    expect(second.existing.id).toBe(first.authorization.id);
  });
});

describe("step-up lifecycle and the spend ledger", () => {
  it("reserves budget for a pending step-up when reserve_on_step_up is true", async () => {
    const { repo, repos, apiKey, mandateId } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(203, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    const entries = repo.ledgerEntriesFor(mandateId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "RESERVATION", amount: toMinorUnits(203, "USD") });
  });

  it("releases the reservation when a pending step-up is declined", async () => {
    const { repo, repos, apiKey, mandateId } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(203, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");

    const declined = await resolveStepUp(
      repo,
      mandateId,
      result.authorization.id,
      "declined",
      new Date(NOW.getTime() + 1000),
    );
    expect(declined.status).toBe("STEP_UP_DECLINED");

    const entries = repo.ledgerEntriesFor(mandateId);
    const net = entries.reduce((sum, e) => sum + e.amount, 0);
    expect(net).toBe(0);
  });

  it("releases the reservation when a pending step-up expires", async () => {
    const { repo, repos, apiKey, mandateId } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(203, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");

    const expired = await resolveStepUp(
      repo,
      mandateId,
      result.authorization.id,
      "expired",
      new Date(NOW.getTime() + 1000 * 60 * 20),
    );
    expect(expired.status).toBe("EXPIRED");
    const entries = repo.ledgerEntriesFor(mandateId);
    expect(entries.reduce((sum, e) => sum + e.amount, 0)).toBe(0);
  });

  it("D-31/OQ-9: sweepExpiredStepUps releases a reservation nobody ever asked about again", async () => {
    const { repo, repos, apiKey, mandateId } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(203, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(result.authorization.status).toBe("PENDING_STEP_UP");

    // Nothing reads or touches this authorization again -- no GET, no
    // execute, no approve/decline. Lazy expiry (server.ts's
    // expireIfNeeded) never runs. The sweep is the only thing that can
    // still release the hold.
    const later = new Date(NOW.getTime() + 1000 * 60 * 20);
    const count = await sweepExpiredStepUps(repo, later);

    expect(count).toBe(1);
    const authorization = await repo.getAuthorization(result.authorization.id);
    expect(authorization?.status).toBe("EXPIRED");
    const entries = repo.ledgerEntriesFor(mandateId);
    expect(entries.reduce((sum, e) => sum + e.amount, 0)).toBe(0);
  });

  it("D-31: sweepExpiredStepUps ignores a step-up that hasn't expired yet", async () => {
    const { repo, repos, apiKey } = await repoWithMandate(policyFrom({}));
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(203, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");

    const count = await sweepExpiredStepUps(repo, NOW);

    expect(count).toBe(0);
    const authorization = await repo.getAuthorization(result.authorization.id);
    expect(authorization?.status).toBe("PENDING_STEP_UP");
  });

  it("does not reserve for a pending step-up when reserve_on_step_up is false", async () => {
    const { repo, repos, apiKey, mandateId } = await repoWithMandate(
      policyFrom({ accounting: { reserve_on_step_up: false } }),
    );
    const result = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(203, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (result.kind !== "decided") throw new Error("unreachable");
    expect(repo.ledgerEntriesFor(mandateId)).toHaveLength(0);
  });

  it("counts prior reservations against the monthly cumulative limit", async () => {
    const { repos, apiKey } = await repoWithMandate(policyFrom({}));
    await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(450, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    const second = await authorize(repos, {
      organizationId: ORG,
      request: request({
        action: {
          amount: toMinorUnits(60, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          category: "office_supplies",
          attestations: {},
        },
      }),
      now: NOW,
      apiKey,
    });
    if (second.kind !== "decided") throw new Error("unreachable");
    expect(second.authorization.decision).toBe(Decision.DENY);
    expect(second.authorization.reasons[0]?.code).toBe(
      ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED,
    );
  });
});

describe("concurrency: two authorizations that each pass alone but not together", () => {
  it("serializes on the mandate lock so only one survives the monthly limit", async () => {
    // No step_up.above_amount here: the point is to isolate the cumulative
    // limit race, not have the $450 leg step up on the amount threshold too.
    const { repos, apiKey } = await repoWithMandate(policyFrom({ step_up: { ttl_seconds: 900 } }));
    // $450 and $60 each pass against a fresh $500 monthly cap, but together
    // they're $510 -- over the limit. Fired concurrently, only one may win.
    const [a, b] = await Promise.all([
      authorize(repos, {
        organizationId: ORG,
        request: request({
          action: {
            amount: toMinorUnits(450, "USD"),
            currency: "USD",
            merchant: { domain: "staples.com" },
            category: "office_supplies",
            attestations: {},
          },
        }),
        now: NOW,
        apiKey,
      }),
      authorize(repos, {
        organizationId: ORG,
        request: request({
          action: {
            amount: toMinorUnits(60, "USD"),
            currency: "USD",
            merchant: { domain: "staples.com" },
            category: "office_supplies",
            attestations: {},
          },
        }),
        now: NOW,
        apiKey,
      }),
    ]);

    if (a.kind !== "decided" || b.kind !== "decided") throw new Error("unreachable");
    const decisions = [a.authorization.decision, b.authorization.decision];
    const allows = decisions.filter((d) => d === Decision.ALLOW);
    const denies = decisions.filter((d) => d === Decision.DENY);
    expect(allows).toHaveLength(1);
    expect(denies).toHaveLength(1);
  });

  it("never lets ten concurrent step-up reservations exceed the monthly limit together", async () => {
    const { repos, apiKey } = await repoWithMandate(
      policyFrom({
        cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
        step_up: { above_amount: toMinorUnits(90, "USD"), ttl_seconds: 900 },
      }),
    );
    // Ten concurrent $90 step-ups against a $500 cap: at most 5 can reserve
    // ($450) before the sixth's projected total ($540) exceeds the limit.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        authorize(repos, {
          organizationId: ORG,
          request: request({
            action: {
              amount: toMinorUnits(90, "USD"),
              currency: "USD",
              merchant: { domain: "staples.com" },
              category: "office_supplies",
              attestations: {},
            },
          }),
          now: NOW,
          apiKey,
        }),
      ),
    );
    const decided = results.filter((r) => r.kind === "decided");
    const stepUps = decided.filter((r) => r.kind === "decided" && r.authorization.decision === Decision.STEP_UP);
    expect(stepUps.length).toBeLessThanOrEqual(5);
  });
});

// --- D-62: approver mandates ------------------------------------------------

const APPROVER_MANDATE_ID = "mdt_test_approver";
const APPROVER_AGENT = "agt_approver";
const APPROVER_PRINCIPAL = "prin_approver";

/** Two mandates in one repo: the original (PRINCIPAL/AGENT, as elsewhere in
 * this file) with `escalation.approvers` naming the approver mandate, and
 * the approver itself. Both ACTIVE and authenticated -- `seedMandate`
 * bypasses `createMandate` entirely, matching every other fixture in this
 * file; the D-62 cycle check is exercised separately, directly against
 * `createMandate`, below. */
async function setupApproverScenario(
  options: {
    originalPolicyOverrides?: Record<string, unknown>;
    approverPolicyOverrides?: Record<string, unknown>;
  } = {},
) {
  const repo = new InMemoryAuthorizationRepository(DIRECTORY);
  const agentKeys = new InMemoryAgentKeyRepository();
  const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);

  const approverPolicy = policyFrom({
    // A real approver's own threshold is well above what it's approving,
    // by default -- otherwise the "within bounds" case would itself
    // trip the approver's own step-up threshold (its default, inherited
    // from policyFrom(), is $150) and every test would exercise rule 4's
    // STEP_UP branch instead of ALLOW. Individual tests override this to
    // exercise DENY/STEP_UP deliberately.
    step_up: { above_amount: toMinorUnits(2000, "USD"), ttl_seconds: 900 },
    cumulative_limits: [{ window: "month", max_amount: toMinorUnits(2000, "USD") }],
    ...options.approverPolicyOverrides,
  });
  const approver = repo.seedMandate({
    mandateId: APPROVER_MANDATE_ID,
    organizationId: ORG,
    principalId: APPROVER_PRINCIPAL,
    agentId: APPROVER_AGENT,
    policy: approverPolicy,
    policyHash: "approver-hash",
  });
  const approverKey = await agentKeys.createKey(
    { organizationId: ORG, agentId: APPROVER_AGENT, name: "approver key" },
    NOW,
  );

  const originalPolicy = policyFrom({
    escalation: { approvers: [APPROVER_MANDATE_ID] },
    ...options.originalPolicyOverrides,
  });
  const original = repo.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy: originalPolicy,
    policyHash: "original-hash",
  });
  const originalKey = await agentKeys.createKey(
    { organizationId: ORG, agentId: AGENT, name: "test key" },
    NOW,
  );

  const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };
  return {
    repo,
    repos,
    agentKeys,
    evidence,
    apiKey: originalKey.fullKey,
    mandateId: original.mandateId,
    approverMandateId: approver.mandateId,
    approverApiKey: approverKey.fullKey,
  };
}

async function triggerStepUp(repos: AuthorizeRepos, apiKey: string, amountUsd = 203) {
  const result = await authorize(repos, {
    organizationId: ORG,
    request: request({
      action: {
        amount: toMinorUnits(amountUsd, "USD"),
        currency: "USD",
        merchant: { domain: "staples.com" },
        category: "office_supplies",
        attestations: {},
      },
    }),
    now: NOW,
    apiKey,
  });
  if (result.kind !== "decided") throw new Error("unreachable");
  expect(result.authorization.status).toBe("PENDING_STEP_UP");
  return result.authorization;
}

function newMandateInput(overrides: Record<string, unknown>): Parameters<InMemoryAuthorizationRepository["createMandate"]>[0] {
  return {
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentIds: [],
    policy: policyFrom({}),
    policyHash: "h",
    intentText: "t",
    compilerName: "manual",
    assumptions: [],
    ...overrides,
  } as Parameters<InMemoryAuthorizationRepository["createMandate"]>[0];
}

describe("D-62: resolving a step-up as an approver mandate", () => {
  it("approves within bounds: evaluate() ALLOW against the approver's mandate, and it costs real budget there (Addition B)", async () => {
    const { repo, repos, apiKey, approverMandateId, approverApiKey } = await setupApproverScenario();
    const stepUp = await triggerStepUp(repos, apiKey);

    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.authorization.status).toBe("STEP_UP_APPROVED");

    const entries = repo.ledgerEntriesFor(approverMandateId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "RESERVATION", amount: toMinorUnits(203, "USD") });

    const events = await repos.evidence.listForOrganization(ORG);
    expect(events.some((e) => e.type === "step_up.approved" && e.subject_id === approverMandateId)).toBe(
      true,
    );
  });

  it("declines when the approver's own policy caps below the amount -- the approver's own DENY_ code surfaces", async () => {
    const { repos, apiKey, approverMandateId, approverApiKey } = await setupApproverScenario({
      approverPolicyOverrides: { per_transaction_max: toMinorUnits(100, "USD") },
    });
    const stepUp = await triggerStepUp(repos, apiKey); // $203

    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.authorization.status).toBe("STEP_UP_DECLINED");

    const events = await repos.evidence.listForOrganization(ORG);
    const declineEvent = events.find((e) => e.type === "step_up.declined");
    expect(declineEvent?.payload).toMatchObject({
      reasons: [expect.objectContaining({ code: "DENY_TRANSACTION_LIMIT_EXCEEDED" })],
    });
  });

  it("declines when the approver's own evaluate() also returns STEP_UP -- single-level, cannot escalate further", async () => {
    const { repos, apiKey, approverMandateId, approverApiKey } = await setupApproverScenario({
      approverPolicyOverrides: { step_up: { above_amount: toMinorUnits(100, "USD"), ttl_seconds: 900 } },
    });
    const stepUp = await triggerStepUp(repos, apiKey); // $203, above the approver's own $100 threshold too

    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.authorization.status).toBe("STEP_UP_DECLINED");

    const events = await repos.evidence.listForOrganization(ORG);
    const declineEvent = events.find((e) => e.type === "step_up.declined");
    expect(declineEvent?.payload).toMatchObject({
      reasons: [expect.objectContaining({ code: "DENY_APPROVER_ESCALATION_NOT_SUPPORTED" })],
    });
  });

  it("D-59: rejects an agent resolving its own step-up (rule 1) -- the step-up stays pending for a real approver", async () => {
    const { repo, repos, apiKey, mandateId } = await setupApproverScenario();
    const stepUp = await triggerStepUp(repos, apiKey);

    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp,
      approverAgentId: AGENT,
      approverPrincipalId: PRINCIPAL,
      approverMandateId: mandateId,
      apiKey,
      now: NOW,
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.reasons[0]?.code).toBe("DENY_STEP_UP_SELF_APPROVAL");

    const current = await repo.getAuthorization(stepUp.id);
    expect(current?.status).toBe("PENDING_STEP_UP");
  });

  it("rejects a mandate not in the approvers list (rule 2) -- the step-up stays pending", async () => {
    const { repo, repos, apiKey } = await setupApproverScenario();
    const stepUp = await triggerStepUp(repos, apiKey);

    repo.seedMandate({
      mandateId: "mdt_stranger",
      organizationId: ORG,
      principalId: "prin_stranger",
      agentId: "agt_stranger",
      policy: policyFrom({}),
      policyHash: "stranger-hash",
    });
    const strangerKey = await repos.agentKeys.createKey(
      { organizationId: ORG, agentId: "agt_stranger", name: "k" },
      NOW,
    );

    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp,
      approverAgentId: "agt_stranger",
      approverPrincipalId: "prin_stranger",
      approverMandateId: "mdt_stranger",
      apiKey: strangerKey.fullKey,
      now: NOW,
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.reasons[0]?.code).toBe("DENY_MANDATE_NOT_AN_APPROVER");

    const current = await repo.getAuthorization(stepUp.id);
    expect(current?.status).toBe("PENDING_STEP_UP");
  });

  it("Addition B: denies once the approver's own cumulative cap from prior approvals is exceeded", async () => {
    const { repos, apiKey, approverMandateId, approverApiKey } = await setupApproverScenario({
      approverPolicyOverrides: {
        cumulative_limits: [{ window: "month", max_amount: toMinorUnits(250, "USD") }],
      },
    });

    const first = await triggerStepUp(repos, apiKey, 203);
    const firstOutcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp: first,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    if (firstOutcome.kind !== "resolved") throw new Error("unreachable");
    expect(firstOutcome.authorization.status).toBe("STEP_UP_APPROVED");

    const second = await triggerStepUp(repos, apiKey, 160);
    const secondOutcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp: second,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    if (secondOutcome.kind !== "resolved") throw new Error("unreachable");
    expect(secondOutcome.authorization.status).toBe("STEP_UP_DECLINED");

    const events = await repos.evidence.listForOrganization(ORG);
    const declines = events.filter((e) => e.type === "step_up.declined");
    expect(declines.at(-1)?.payload).toMatchObject({
      reasons: [expect.objectContaining({ code: "DENY_CUMULATIVE_LIMIT_EXCEEDED" })],
    });
  });

  it("D-31: an approver resolving after the step-up TTL already expired gets the expired outcome, never a re-evaluation", async () => {
    const { repo, repos, apiKey, mandateId, approverMandateId, approverApiKey } =
      await setupApproverScenario();
    const stepUp = await triggerStepUp(repos, apiKey);

    const later = new Date(NOW.getTime() + 1000 * 60 * 20); // past ttl_seconds: 900
    await sweepExpiredStepUps(repo, later);
    const expiredStored = await repo.getAuthorization(stepUp.id);
    expect(expiredStored?.status).toBe("EXPIRED");

    const outcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp: expiredStored!,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: later,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.authorization.status).toBe("EXPIRED");
    // No ledger entry -- nothing was actually approved.
    expect(repo.ledgerEntriesFor(approverMandateId)).toHaveLength(0);
  });
});

describe("D-62 Addition A: approver cycles are rejected at mandate creation", () => {
  it("rejects a mandate naming itself as its own approver (the degenerate 1-cycle)", async () => {
    const repo = new InMemoryAuthorizationRepository(DIRECTORY);
    const agent = await repo.createAgent({ organizationId: ORG, name: "test agent" }, NOW);

    await expect(
      repo.createMandate(
        newMandateInput({
          id: "mdt_self",
          agentIds: [agent.agentId],
          policy: policyFrom({ escalation: { approvers: ["mdt_self"] } }),
        }),
        NOW,
      ),
    ).rejects.toThrow(MandateCreationError);
  });

  it("rejects a mutual pair: creating B while A already names B (the 2-cycle)", async () => {
    const repo = new InMemoryAuthorizationRepository(DIRECTORY);
    const agent = await repo.createAgent({ organizationId: ORG, name: "test agent" }, NOW);

    const a = await repo.createMandate(
      newMandateInput({
        id: "mdt_a",
        agentIds: [agent.agentId],
        policy: policyFrom({ escalation: { approvers: ["mdt_b"] } }),
      }),
      NOW,
    );
    expect(a.mandateId).toBe("mdt_a");

    await expect(
      repo.createMandate(
        newMandateInput({
          id: "mdt_b",
          agentIds: [agent.agentId],
          policy: policyFrom({ escalation: { approvers: ["mdt_a"] } }),
        }),
        NOW,
      ),
    ).rejects.toThrow(MandateCreationError);
  });

  it("does NOT reject a 3-cycle at creation (A names B, B names C, C names A) -- a deliberate, documented gap", async () => {
    const repo = new InMemoryAuthorizationRepository(DIRECTORY);
    const agent = await repo.createAgent({ organizationId: ORG, name: "test agent" }, NOW);
    const mk = (id: string, approves: string) =>
      repo.createMandate(
        newMandateInput({
          id,
          agentIds: [agent.agentId],
          policy: policyFrom({ escalation: { approvers: [approves] } }),
        }),
        NOW,
      );

    await mk("mdt_x", "mdt_y");
    await mk("mdt_y", "mdt_z");
    await expect(mk("mdt_z", "mdt_x")).resolves.toMatchObject({ mandateId: "mdt_z" });
  });

  it("Addition A+B together: a real runtime 3-cycle is bounded by each approver's own cap, not unlimited", async () => {
    const repo = new InMemoryAuthorizationRepository(DIRECTORY);
    const agentKeys = new InMemoryAgentKeyRepository();
    const evidence = new InMemoryEvidenceRepository(generateEvidenceSigningKeyPair().privateKey);
    const repos: AuthorizeRepos = { authorization: repo, agentKeys, evidence };

    // X needs a LOW step-up threshold so its own authorize() calls
    // actually escalate (policyFrom()'s default, $150, is fine). Y and Z
    // need a HIGH one so, acting as approvers, their own evaluate() call
    // returns ALLOW/DENY on the cumulative dimension being tested here,
    // not STEP_UP on the amount dimension.
    const originatorPolicy = (approves: string) =>
      policyFrom({
        escalation: { approvers: [approves] },
        cumulative_limits: [{ window: "month", max_amount: toMinorUnits(2000, "USD") }],
      });
    const approverPolicy = (approves: string) =>
      policyFrom({
        escalation: { approvers: [approves] },
        step_up: { above_amount: toMinorUnits(2000, "USD"), ttl_seconds: 900 },
        cumulative_limits: [{ window: "month", max_amount: toMinorUnits(250, "USD") }],
      });

    const agentFor = async (label: string) => {
      const agent = await repo.createAgent({ organizationId: ORG, name: label }, NOW);
      const key = await agentKeys.createKey({ organizationId: ORG, agentId: agent.agentId, name: label }, NOW);
      return { agentId: agent.agentId, apiKey: key.fullKey };
    };

    const agentX = await agentFor("x");
    const agentY = await agentFor("y");
    const agentZ = await agentFor("z");

    await repo.createMandate(
      { id: "mdt_x", organizationId: ORG, principalId: "prin_x", agentIds: [agentX.agentId], policy: originatorPolicy("mdt_y"), policyHash: "h", intentText: "t", compilerName: "manual", assumptions: [] },
      NOW,
    );
    await repo.createMandate(
      { id: "mdt_y", organizationId: ORG, principalId: "prin_y", agentIds: [agentY.agentId], policy: approverPolicy("mdt_z"), policyHash: "h", intentText: "t", compilerName: "manual", assumptions: [] },
      NOW,
    );
    await repo.createMandate(
      { id: "mdt_z", organizationId: ORG, principalId: "prin_z", agentIds: [agentZ.agentId], policy: approverPolicy("mdt_x"), policyHash: "h", intentText: "t", compilerName: "manual", assumptions: [] },
      NOW,
    );
    for (const id of ["mdt_x", "mdt_y", "mdt_z"]) {
      const summary = await repo.getMandateSummary(id);
      await repo.activateMandate(id, summary!.mandateVersionId, "203.0.113.10", NOW);
    }

    const stepUpOnX = async (amountUsd: number) => {
      const result = await authorize(repos, {
        organizationId: ORG,
        request: {
          agent_id: agentX.agentId,
          principal_id: "prin_x",
          action: {
            amount: toMinorUnits(amountUsd, "USD"),
            currency: "USD",
            merchant: { domain: "staples.com" },
            category: "office_supplies",
            attestations: {},
          },
          context: {},
        } as AuthorizationRequest,
        now: NOW,
        apiKey: agentX.apiKey,
      });
      if (result.kind !== "decided") throw new Error("unreachable");
      return result.authorization;
    };

    // Y is X's approver. First $203 approval: within Y's own $250 cap.
    const first = await stepUpOnX(203);
    const firstOutcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp: first,
      approverAgentId: agentY.agentId,
      approverPrincipalId: "prin_y",
      approverMandateId: "mdt_y",
      apiKey: agentY.apiKey,
      now: NOW,
    });
    if (firstOutcome.kind !== "resolved") throw new Error("unreachable");
    expect(firstOutcome.authorization.status).toBe("STEP_UP_APPROVED");

    // A second approval would bring Y's own approval spend to $363 --
    // over Y's own $250 cap. The cycle (Y could chain to Z, Z to X) never
    // gets a chance to run: Y's own real budget stops it here, on the
    // second hop, regardless of what X or Z's own state is.
    const second = await stepUpOnX(160);
    const secondOutcome = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp: second,
      approverAgentId: agentY.agentId,
      approverPrincipalId: "prin_y",
      approverMandateId: "mdt_y",
      apiKey: agentY.apiKey,
      now: NOW,
    });
    if (secondOutcome.kind !== "resolved") throw new Error("unreachable");
    expect(secondOutcome.authorization.status).toBe("STEP_UP_DECLINED");
  });
});

describe("D-62 Addition C: single-use and idempotent resolution", () => {
  it("a retry with the same approver replays the recorded outcome -- never charges the ledger twice", async () => {
    const { repo, repos, apiKey, approverMandateId, approverApiKey } = await setupApproverScenario();
    const stepUp = await triggerStepUp(repos, apiKey);

    const first = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    if (first.kind !== "resolved") throw new Error("unreachable");

    // Simulates a retry after a lost response: the same approver, resolving
    // the same (now already-resolved) authorization again.
    const fresh = (await repo.getAuthorization(stepUp.id))!;
    const second = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp: fresh,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    if (second.kind !== "resolved") throw new Error("unreachable");
    expect(second.authorization.status).toBe(first.authorization.status);
    expect(repo.ledgerEntriesFor(approverMandateId)).toHaveLength(1);
  });

  it("a second, different approver resolving an already-approved step-up gets the recorded outcome, not a re-evaluation", async () => {
    const { repo, repos, apiKey, approverMandateId, approverApiKey } = await setupApproverScenario({
      originalPolicyOverrides: { escalation: { approvers: [APPROVER_MANDATE_ID, "mdt_second"] } },
    });
    repo.seedMandate({
      mandateId: "mdt_second",
      organizationId: ORG,
      principalId: "prin_second",
      agentId: "agt_second",
      policy: policyFrom({}),
      policyHash: "second-hash",
    });
    const secondKey = await repos.agentKeys.createKey(
      { organizationId: ORG, agentId: "agt_second", name: "k" },
      NOW,
    );

    const stepUp = await triggerStepUp(repos, apiKey);
    const first = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    if (first.kind !== "resolved") throw new Error("unreachable");
    expect(first.authorization.status).toBe("STEP_UP_APPROVED");

    const fresh = (await repo.getAuthorization(stepUp.id))!;
    const second = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp: fresh,
      approverAgentId: "agt_second",
      approverPrincipalId: "prin_second",
      approverMandateId: "mdt_second",
      apiKey: secondKey.fullKey,
      now: NOW,
    });
    if (second.kind !== "resolved") throw new Error("unreachable");
    expect(second.authorization.status).toBe("STEP_UP_APPROVED");
    // The second approver never actually approved anything.
    expect(repo.ledgerEntriesFor("mdt_second")).toHaveLength(0);
  });

  it("an approver attempting to resolve an already-declined step-up gets the declined outcome", async () => {
    const { repo, repos, apiKey, approverMandateId, approverApiKey } = await setupApproverScenario({
      approverPolicyOverrides: { per_transaction_max: toMinorUnits(100, "USD") },
    });
    const stepUp = await triggerStepUp(repos, apiKey); // $203, over the approver's $100 cap

    const first = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    if (first.kind !== "resolved") throw new Error("unreachable");
    expect(first.authorization.status).toBe("STEP_UP_DECLINED");

    const fresh = (await repo.getAuthorization(stepUp.id))!;
    const second = await resolveStepUpAsApprover(repos, {
      organizationId: ORG,
      stepUp: fresh,
      approverAgentId: APPROVER_AGENT,
      approverPrincipalId: APPROVER_PRINCIPAL,
      approverMandateId,
      apiKey: approverApiKey,
      now: NOW,
    });
    if (second.kind !== "resolved") throw new Error("unreachable");
    expect(second.authorization.status).toBe("STEP_UP_DECLINED");
  });
});

describe("D-62 Addition D: concurrency", () => {
  it("two approvers resolving simultaneously settle atomically -- first writer wins, the loser gets the recorded outcome", async () => {
    const { repo, repos, apiKey, approverMandateId, approverApiKey } = await setupApproverScenario({
      originalPolicyOverrides: { escalation: { approvers: [APPROVER_MANDATE_ID, "mdt_second"] } },
    });
    repo.seedMandate({
      mandateId: "mdt_second",
      organizationId: ORG,
      principalId: "prin_second",
      agentId: "agt_second",
      policy: policyFrom({}),
      policyHash: "second-hash",
    });
    const secondKey = await repos.agentKeys.createKey(
      { organizationId: ORG, agentId: "agt_second", name: "k" },
      NOW,
    );
    const stepUp = await triggerStepUp(repos, apiKey);

    const [a, b] = await Promise.all([
      resolveStepUpAsApprover(repos, {
        organizationId: ORG,
        stepUp,
        approverAgentId: APPROVER_AGENT,
        approverPrincipalId: APPROVER_PRINCIPAL,
        approverMandateId,
        apiKey: approverApiKey,
        now: NOW,
      }),
      resolveStepUpAsApprover(repos, {
        organizationId: ORG,
        stepUp,
        approverAgentId: "agt_second",
        approverPrincipalId: "prin_second",
        approverMandateId: "mdt_second",
        apiKey: secondKey.fullKey,
        now: NOW,
      }),
    ]);

    expect(a.kind).toBe("resolved");
    expect(b.kind).toBe("resolved");
    if (a.kind !== "resolved" || b.kind !== "resolved") throw new Error("unreachable");
    expect(a.authorization.status).toBe(b.authorization.status);
    expect(a.authorization.status).toBe("STEP_UP_APPROVED");

    // Exactly one of the two approver mandates actually paid for it.
    const chargedApprover = repo.ledgerEntriesFor(approverMandateId).length;
    const chargedSecond = repo.ledgerEntriesFor("mdt_second").length;
    expect(chargedApprover + chargedSecond).toBe(1);

    // A single resolution legitimately writes two "step_up.approved"
    // events -- one per mandate involved (rule 6). What must be true is
    // that only ONE approver's id ever appears across them: the actual
    // winner's, never both.
    const events = await repos.evidence.listForOrganization(ORG);
    const approvalEvents = events.filter((e) => e.type === "step_up.approved");
    const approversInvolved = new Set(
      approvalEvents.map((e) => (e.payload as { approver_mandate_id: string }).approver_mandate_id),
    );
    expect(approversInvolved.size).toBe(1);
  });

  it("approval racing TTL expiry settles atomically -- the approver call never throws or double-decides", async () => {
    const { repo, repos, apiKey, approverMandateId, approverApiKey, mandateId } =
      await setupApproverScenario();
    const stepUp = await triggerStepUp(repos, apiKey);
    const later = new Date(NOW.getTime() + 1000 * 60 * 20); // past ttl_seconds: 900

    const [approvalSettled, expirySettled] = await Promise.allSettled([
      resolveStepUpAsApprover(repos, {
        organizationId: ORG,
        stepUp,
        approverAgentId: APPROVER_AGENT,
        approverPrincipalId: APPROVER_PRINCIPAL,
        approverMandateId,
        apiKey: approverApiKey,
        now: later,
      }),
      // The TTL-expiry primitive (D-31): per its own documented contract,
      // it throws if it loses the race and the row is no longer
      // PENDING_STEP_UP by the time its lock is acquired -- unchanged by
      // D-62, and not something this test is asking to change.
      resolveStepUp(repo, mandateId, stepUp.id, "expired", later),
    ]);

    // The new approver path never throws, win or lose (Addition D).
    expect(approvalSettled.status).toBe("fulfilled");
    if (approvalSettled.status !== "fulfilled") throw new Error("unreachable");
    const outcome = approvalSettled.value;
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(["STEP_UP_APPROVED", "EXPIRED"]).toContain(outcome.authorization.status);

    if (expirySettled.status === "fulfilled") {
      expect(expirySettled.value.status).toBe("EXPIRED");
      expect(outcome.authorization.status).toBe("EXPIRED");
    } else {
      expect(outcome.authorization.status).toBe("STEP_UP_APPROVED");
    }
  });
});
