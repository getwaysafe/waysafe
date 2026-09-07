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
import { authorize, resolveStepUp, sweepExpiredStepUps, type AuthorizeRepos } from "./service.js";

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
