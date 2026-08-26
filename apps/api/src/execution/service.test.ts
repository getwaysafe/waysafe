import { describe, expect, it } from "vitest";
import {
  createStaticDirectory,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  Decision,
  type Policy,
} from "@agentpay/core";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { authorize, resolveStepUp } from "../authorization/service.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { asExecutable } from "./executable.js";
import { executePayment } from "./service.js";
import { FakeAdapter } from "./test-support/fake-adapter.js";

const ORG = "org_test";
const PRINCIPAL = "prin_test";
const AGENT = "agt_test";
const NOW = new Date("2026-08-24T12:00:00.000Z");

const DIRECTORY = createStaticDirectory([{ domain: "staples.com", display_name: "Staples" }]);

function policyFrom(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "test",
    currency: "USD",
    merchants: {
      allow: [{ scheme: "domain", value: "staples.com", label: "Staples" }],
      deny: [],
      unlisted: "STEP_UP",
    },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-09-23T12:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

async function setup(policyOverrides: Record<string, unknown> = {}) {
  const authorization = new InMemoryAuthorizationRepository(DIRECTORY);
  const agentKeys = new InMemoryAgentKeyRepository();
  const evidence = new InMemoryEvidenceRepository();
  const { mandateId } = authorization.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy: policyFrom(policyOverrides),
    policyHash: "hash",
  });
  const key = await agentKeys.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);
  return { authorization, agentKeys, evidence, mandateId, apiKey: key.fullKey };
}

async function decide(ctx: Awaited<ReturnType<typeof setup>>, amount: number) {
  const result = await authorize(
    { authorization: ctx.authorization, agentKeys: ctx.agentKeys, evidence: ctx.evidence },
    {
      organizationId: ORG,
      request: {
        agent_id: AGENT,
        principal_id: PRINCIPAL,
        mandate_id: ctx.mandateId,
        action: {
          amount: toMinorUnits(amount, "USD"),
          currency: "USD",
          merchant: { domain: "staples.com" },
          attestations: {},
        },
        context: {},
      },
      now: NOW,
      apiKey: ctx.apiKey,
    },
  );
  if (result.kind !== "decided") throw new Error("unreachable");
  return result.authorization;
}

describe("executePayment", () => {
  it("executes an ALLOWed authorization: status becomes EXECUTED, ledger nets to zero, evidence recorded", async () => {
    const ctx = await setup();
    const auth = await decide(ctx, 83);
    expect(auth.decision).toBe(Decision.ALLOW);

    const before = await ctx.authorization.getSpendSnapshot(ctx.mandateId, policyFrom().accounting, NOW);
    const executable = asExecutable(auth);
    if (!executable) throw new Error("unreachable");

    const adapter = new FakeAdapter({ providerFee: 250 });
    const result = await executePayment(
      { authorization: ctx.authorization, evidence: ctx.evidence },
      executable,
      adapter,
      "pm_test_visa",
      NOW,
    );

    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") throw new Error("unreachable");
    expect(result.authorization.status).toBe("EXECUTED");
    expect(adapter.calls).toHaveLength(1);

    // The reservation already counted at decision time (D-4); execution
    // releases it and captures the same amount -- net zero change.
    const after = await ctx.authorization.getSpendSnapshot(ctx.mandateId, policyFrom().accounting, NOW);
    expect(after.month.amount).toBe(before.month.amount);

    const events = await ctx.evidence.listForOrganization(ORG);
    expect(events.map((e) => e.type)).toContain("execution.completed");
  });

  it("executes a STEP_UP_APPROVED authorization", async () => {
    const ctx = await setup({ merchants: { allow: [], deny: [], unlisted: "STEP_UP" } });
    const auth = await decide(ctx, 83);
    expect(auth.decision).toBe(Decision.STEP_UP);

    const approved = await resolveStepUp(ctx.authorization, ctx.mandateId, auth.id, "approved", NOW);
    expect(approved.status).toBe("STEP_UP_APPROVED");

    const executable = asExecutable(approved);
    if (!executable) throw new Error("unreachable");
    const result = await executePayment(
      { authorization: ctx.authorization, evidence: ctx.evidence },
      executable,
      new FakeAdapter(),
      "pm_test_visa",
      NOW,
    );
    expect(result.kind).toBe("executed");
  });

  it("THE ATTACK: an adapter rejection does not execute -- status is unchanged, no ledger effect", async () => {
    const ctx = await setup();
    const auth = await decide(ctx, 83);
    const executable = asExecutable(auth);
    if (!executable) throw new Error("unreachable");

    const before = await ctx.authorization.getSpendSnapshot(ctx.mandateId, policyFrom().accounting, NOW);
    const adapter = new FakeAdapter({ outcome: "failure", failureReason: "card_declined" });
    const result = await executePayment(
      { authorization: ctx.authorization, evidence: ctx.evidence },
      executable,
      adapter,
      "pm_test_visa",
      NOW,
    );

    expect(result.kind).toBe("rejected");
    const stored = await ctx.authorization.getAuthorization(auth.id);
    expect(stored?.status).toBe("AUTHORIZED");

    const after = await ctx.authorization.getSpendSnapshot(ctx.mandateId, policyFrom().accounting, NOW);
    expect(after.month.amount).toBe(before.month.amount);

    const events = await ctx.evidence.listForOrganization(ORG);
    expect(events.map((e) => e.type)).toContain("execution.rejected");
  });

  it("THE ATTACK: a second execution attempt is impossible -- asExecutable refuses the already-EXECUTED row before the adapter is ever called again", async () => {
    const ctx = await setup();
    const auth = await decide(ctx, 83);
    const executable = asExecutable(auth);
    if (!executable) throw new Error("unreachable");

    const adapter = new FakeAdapter();
    const first = await executePayment(
      { authorization: ctx.authorization, evidence: ctx.evidence },
      executable,
      adapter,
      "pm_test_visa",
      NOW,
    );
    expect(first.kind).toBe("executed");

    // Re-fetch and try to build a second ExecutableAuthorization from the
    // now-EXECUTED row -- the only legitimate way to obtain one, and it
    // must fail.
    const stored = await ctx.authorization.getAuthorization(auth.id);
    if (!stored) throw new Error("unreachable");
    expect(asExecutable(stored)).toBeNull();
    expect(adapter.calls).toHaveLength(1);
  });

  it("THE ATTACK: recordExecution refuses a non-executable status directly, even bypassing the type guard (defense in depth)", async () => {
    const ctx = await setup();
    const auth = await decide(ctx, 83);
    const executable = asExecutable(auth);
    if (!executable) throw new Error("unreachable");
    await executePayment(
      { authorization: ctx.authorization, evidence: ctx.evidence },
      executable,
      new FakeAdapter(),
      "pm_test_visa",
      NOW,
    );

    // The authorization is now EXECUTED. Calling the repository method
    // directly -- as if the type guard didn't exist -- must still be
    // refused by the repository's own runtime check.
    await expect(
      ctx.authorization.recordExecution(
        { authorizationId: auth.id, provider: "fake", providerReference: "ref", providerFee: 0 },
        NOW,
      ),
    ).rejects.toThrow(/not executable/);
  });
});
