import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  createStaticDirectory,
  parsePolicy,
  POLICY_SCHEMA_VERSION,
  toMinorUnits,
  type Policy,
} from "@bles/core";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { authorize } from "../authorization/service.js";
import { asExecutable } from "../execution/executable.js";
import { executePayment } from "../execution/service.js";
import { FakeAdapter } from "../execution/test-support/fake-adapter.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryProviderEventRepository } from "./in-memory-repository.js";
import { handleStripeWebhook } from "./service.js";

const ORG = "org_test";
const PRINCIPAL = "prin_test";
const AGENT = "agt_test";
const NOW = new Date("2026-08-24T12:00:00.000Z");
const DIRECTORY = createStaticDirectory([{ domain: "staples.com", display_name: "Staples" }]);

function policyFrom(): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "test",
    currency: "USD",
    merchants: { allow: [{ scheme: "domain", value: "staples.com", label: "Staples" }], deny: [], unlisted: "STEP_UP" },
    categories: { allow: [], deny: [], deny_mcc: [], unlisted: "ALLOW" },
    cumulative_limits: [],
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-09-23T12:00:00.000Z",
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

async function setupExecutedAuthorization() {
  const authorization = new InMemoryAuthorizationRepository(DIRECTORY);
  const agentKeys = new InMemoryAgentKeyRepository();
  const evidence = new InMemoryEvidenceRepository();
  const providerEvents = new InMemoryProviderEventRepository();
  const { mandateId } = authorization.seedMandate({
    organizationId: ORG,
    principalId: PRINCIPAL,
    agentId: AGENT,
    policy: policyFrom(),
    policyHash: "hash",
  });
  const key = await agentKeys.createKey({ organizationId: ORG, agentId: AGENT, name: "bot" }, NOW);

  const decided = await authorize(
    { authorization, agentKeys, evidence },
    {
      organizationId: ORG,
      request: {
        agent_id: AGENT,
        principal_id: PRINCIPAL,
        mandate_id: mandateId,
        action: { amount: toMinorUnits(83, "USD"), currency: "USD", merchant: { domain: "staples.com" }, attestations: {} },
        context: {},
      },
      now: NOW,
      apiKey: key.fullKey,
    },
  );
  if (decided.kind !== "decided") throw new Error("unreachable");

  const executable = asExecutable(decided.authorization);
  if (!executable) throw new Error("unreachable");
  const executed = await executePayment({ authorization, evidence }, executable, new FakeAdapter(), "pm_test", NOW);
  if (executed.kind !== "executed") throw new Error("unreachable");

  return { authorization, evidence, providerEvents, mandateId, authorizationId: executed.authorization.id };
}

function refundEvent(id: string, authorizationId: string, amountRefunded: number): Stripe.Event {
  return {
    id,
    object: "event",
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_test_123",
        object: "charge",
        amount_refunded: amountRefunded,
        metadata: { bles_authorization_id: authorizationId },
      },
    },
  } as unknown as Stripe.Event;
}

describe("handleStripeWebhook", () => {
  it("applies a refund as a CREDIT ledger entry", async () => {
    const ctx = await setupExecutedAuthorization();
    const result = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      refundEvent("evt_1", ctx.authorizationId, toMinorUnits(83, "USD")),
      NOW,
    );

    expect(result).toEqual({ kind: "applied", effect: "refund" });
    const events = await ctx.evidence.listForOrganization(ORG);
    expect(events.map((e) => e.type)).toContain("refund.applied");
  });

  it("THE ATTACK: the same provider event delivered twice produces exactly one ledger effect", async () => {
    const ctx = await setupExecutedAuthorization();
    const event = refundEvent("evt_2", ctx.authorizationId, toMinorUnits(83, "USD"));

    const first = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      event,
      NOW,
    );
    const second = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      event,
      new Date(NOW.getTime() + 1000),
    );

    expect(first).toEqual({ kind: "applied", effect: "refund" });
    expect(second).toEqual({ kind: "duplicate" });

    const evidenceEvents = await ctx.evidence.listForOrganization(ORG);
    expect(evidenceEvents.filter((e) => e.type === "refund.applied")).toHaveLength(1);
  });

  it("ignores an event type it doesn't handle, without erroring", async () => {
    const ctx = await setupExecutedAuthorization();
    const event = {
      id: "evt_3",
      object: "event",
      type: "customer.created",
      data: { object: {} },
    } as unknown as Stripe.Event;

    const result = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      event,
      NOW,
    );
    expect(result.kind).toBe("ignored");
  });

  it("ignores a refund with no matching authorization instead of throwing", async () => {
    const ctx = await setupExecutedAuthorization();
    const result = await handleStripeWebhook(
      { providerEvents: ctx.providerEvents, authorization: ctx.authorization, evidence: ctx.evidence },
      refundEvent("evt_4", "auth_does_not_exist", 1000),
      NOW,
    );
    expect(result).toEqual({ kind: "ignored", reason: "no such authorization: auth_does_not_exist" });
  });
});
