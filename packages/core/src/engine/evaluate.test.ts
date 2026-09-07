import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { emptySpendSnapshot, type EngineInput, type SpendSnapshot } from "./types.js";
import { parsePolicy, POLICY_SCHEMA_VERSION, type Policy } from "../policy.js";
import { toMinorUnits } from "../money.js";
import {
  createStaticDirectory,
  merchantRefKey,
  resolveMerchant,
  type MerchantAssertion,
} from "../merchant.js";
import { ReasonCode, Decision } from "../reason-codes.js";
import type { ProposedAction } from "../domain.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");

// A small directory standing in for Week 4's real Stripe/merchant lookups.
const DIRECTORY = createStaticDirectory([
  { domain: "amazon.com", display_name: "Amazon" },
  { domain: "staples.com", display_name: "Staples", mcc: "5943" },
  { domain: "bestbuy.com", display_name: "Best Buy", mcc: "5732" },
]);

function policyFrom(overrides: Record<string, unknown>): Policy {
  const result = parsePolicy({
    schema_version: POLICY_SCHEMA_VERSION,
    summary: "test",
    currency: "USD",
    merchants: { allow: [], deny: [], unlisted: "STEP_UP" },
    categories: {
      allow: [],
      deny: ["gambling", "cash_advance", "crypto", "adult", "firearms"],
      deny_mcc: [],
      unlisted: "ALLOW",
    },
    step_up: { ttl_seconds: 900 },
    accounting: {},
    expires_at: "2026-09-23T12:00:00.000Z",
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(
      `test policy failed to parse: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.policy;
}

// The PRD §11 policy, "ask me before" reading (OQ-1: procurement-demo).
// No per-transaction ceiling; a $150 step-up threshold instead.
const PROCUREMENT_ASK = policyFrom({
  cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
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
    unlisted: "STEP_UP",
  },
  step_up: { above_amount: toMinorUnits(150, "USD"), ttl_seconds: 900 },
});

// The PRD §11 policy, literal "never" reading (OQ-1: procurement-strict).
// A hard $150 per-transaction ceiling; no step-up threshold at all.
const PROCUREMENT_STRICT = policyFrom({
  per_transaction_max: toMinorUnits(150, "USD"),
  cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
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
    unlisted: "STEP_UP",
  },
  step_up: { ttl_seconds: 900 },
});

function action(
  amountUsd: number,
  merchant: MerchantAssertion,
  overrides: Partial<ProposedAction> = {},
): ProposedAction {
  return {
    amount: toMinorUnits(amountUsd, "USD"),
    currency: "USD",
    merchant: merchant as never,
    attestations: {},
    ...overrides,
  } as ProposedAction;
}

function run(
  policy: Policy,
  proposedAction: ProposedAction,
  opts: { spend?: SpendSnapshot; now?: Date; merchantSource?: "agent" | "rail" } = {},
) {
  // D-34: this suite represents the authorize() path -- a ProposedAction the
  // caller of authorize() submitted -- so "agent" is the honest default.
  // Only a handful of tests below explicitly pass "rail" to prove the one
  // legitimate case (a payment rail's own callback) still verifies.
  const merchant = resolveMerchant(
    proposedAction.merchant,
    DIRECTORY,
    opts.merchantSource ?? "agent",
  );
  const input: EngineInput = {
    policy,
    action: proposedAction,
    merchant,
    spend: opts.spend ?? emptySpendSnapshot(),
    now: opts.now ?? NOW,
  };
  return evaluate(input);
}

// --- The four PRD §11 demo cases --------------------------------------------

describe("PRD demo cases", () => {
  it("Staples $83 -> ALLOW", () => {
    const result = run(
      PROCUREMENT_ASK,
      action(83, { domain: "staples.com" }, { category: "office_supplies" }),
    );
    expect(result.decision).toBe(Decision.ALLOW);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.ALLOW_WITHIN_MANDATE,
    ]);
  });

  it("Staples $203 -> STEP_UP under the 'ask me before' reading", () => {
    const result = run(
      PROCUREMENT_ASK,
      action(203, { domain: "staples.com" }, { category: "office_supplies" }),
    );
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons.map((r) => r.code)).toContain(
      ReasonCode.STEP_UP_AMOUNT_THRESHOLD,
    );
  });

  it("Staples $203 -> DENY under the literal 'never' reading", () => {
    const result = run(
      PROCUREMENT_STRICT,
      action(203, { domain: "staples.com" }, { category: "office_supplies" }),
    );
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED,
    ]);
  });

  it("Best Buy $87 -> STEP_UP (verified merchant, not on the allowlist)", () => {
    const result = run(
      PROCUREMENT_ASK,
      action(87, { domain: "bestbuy.com" }, { category: "office_supplies" }),
    );
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
    ]);
  });

  it("$50 at an unapproved gambling merchant -> DENY, category beats merchant step-up", () => {
    const result = run(
      PROCUREMENT_ASK,
      action(
        50,
        { name: "Lucky Spin Casino", domain: "luckyspincasino.example" },
        { category: "gambling" },
      ),
    );
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_CATEGORY_BLOCKED,
    ]);
  });
});

// --- Adversarial merchant identity -------------------------------------------

describe("adversarial merchant assertions", () => {
  it("a merchant asserted by name only can never produce ALLOW", () => {
    const result = run(
      PROCUREMENT_ASK,
      action(83, { name: "Staples" }, { category: "office_supplies" }),
    );
    expect(result.decision).toBe(Decision.STEP_UP);
    // Two independently true facts about the same merchant, in evaluation
    // order: not on the allowlist (unlisted:"STEP_UP"), AND not verifiably
    // who it claims to be (a bare name never verifies). Both are always
    // surfaced now -- see the "D-3 ceiling" tests below for the cases where
    // only one of the two applies.
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
      ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
    ]);
  });

  it("a lookalike domain does not match the allowlist and cannot reach ALLOW", () => {
    const result = run(
      PROCUREMENT_ASK,
      action(
        83,
        { domain: "staples.com.checkout-secure.io" },
        { category: "office_supplies" },
      ),
    );
    expect(result.decision).toBe(Decision.STEP_UP);
    // Same two-fact pattern: an unlisted domain that also never resolved to
    // a verified identity (it isn't in the directory either).
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
      ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
    ]);
  });

  it("a subdomain of an allowlisted domain still matches and verifies", () => {
    const result = run(
      PROCUREMENT_ASK,
      action(83, { domain: "shop.staples.com" }, { category: "office_supplies" }),
    );
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("an assertion with no usable identity at all is DENY, not STEP_UP", () => {
    const result = run(PROCUREMENT_ASK, action(20, {}, { category: "office_supplies" }));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_MERCHANT_UNRESOLVED,
    ]);
  });

  it(
    "THE ATTACK: D-34 (was 'a PSP account id is VERIFIED even off-directory, and can satisfy " +
      "an allowlist' -- that was the bug) -- an agent-attested psp_account alone caps at STEP_UP, not ALLOW",
    () => {
      // D-34: this test used to assert ALLOW here, because resolveMerchant()
      // trusted the `psp_account` *field* regardless of who supplied it.
      // POST /v1/authorizations' ProposedAction.merchant is agent-supplied,
      // so an agent typing a real psp_account it doesn't actually transact
      // through got the exact same free pass a bare `name` claim already
      // can't get (D-3). No accompanying domain here on purpose -- adding
      // one back in would let directory corroboration verify the merchant
      // by a different path and mask the point this test exists to prove.
      const policy = policyFrom({
        merchants: {
          allow: [{ scheme: "psp_account", value: "acct_staples_1" }],
          deny: [],
          unlisted: "STEP_UP",
        },
      });
      const result = run(policy, action(83, { psp_account: "acct_staples_1" }));
      expect(result.decision).toBe(Decision.STEP_UP);
      expect(result.reasons.map((r) => r.code)).toEqual([ReasonCode.STEP_UP_MERCHANT_UNVERIFIED]);
    },
  );

  it("D-34: the same PSP account id, rail-attested, IS verified and reaches ALLOW", () => {
    // The legitimate counterpart to the attack above: a payment rail's own
    // callback (not an agent's claim) asserting a psp_account is exactly
    // the corroboration D-3's table always meant for this scheme.
    const policy = policyFrom({
      merchants: {
        allow: [{ scheme: "psp_account", value: "acct_staples_1" }],
        deny: [],
        unlisted: "STEP_UP",
      },
    });
    const result = run(policy, action(83, { psp_account: "acct_staples_1" }), {
      merchantSource: "rail",
    });
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("THE ATTACK: D-34 -- an agent-attested network_mid alone caps at STEP_UP, not ALLOW", () => {
    // Same attack, the other field D-33 made VERIFIED-eligible. An agent
    // asserting a real card-network merchant id it never actually
    // transacted through must not reach ALLOW just because the field
    // happens to be one a rail could have legitimately supplied.
    const policy = policyFrom({
      merchants: {
        allow: [{ scheme: "network_mid", value: "visa_mid_staples_1" }],
        deny: [],
        unlisted: "STEP_UP",
      },
    });
    const result = run(policy, action(83, { network_mid: "visa_mid_staples_1" }));
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons.map((r) => r.code)).toEqual([ReasonCode.STEP_UP_MERCHANT_UNVERIFIED]);
  });

  it("D-34: the same network_mid, rail-attested (e.g. Stripe Issuing's webhook), IS verified and reaches ALLOW", () => {
    const policy = policyFrom({
      merchants: {
        allow: [{ scheme: "network_mid", value: "visa_mid_staples_1" }],
        deny: [],
        unlisted: "STEP_UP",
      },
    });
    const result = run(policy, action(83, { network_mid: "visa_mid_staples_1" }), {
      merchantSource: "rail",
    });
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("an explicitly denylisted merchant is blocked even though verified", () => {
    const policy = policyFrom({
      merchants: {
        allow: [],
        deny: [{ scheme: "domain", value: "staples.com" }],
        unlisted: "ALLOW",
      },
    });
    const result = run(policy, action(10, { domain: "staples.com" }));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_MERCHANT_BLOCKED,
    ]);
  });

  it("a denylist match needs no verification -- a mere claim is disqualifying", () => {
    const policy = policyFrom({
      merchants: {
        allow: [],
        deny: [{ scheme: "name", value: "Shady Corp" }],
        unlisted: "ALLOW",
      },
    });
    const result = run(policy, action(10, { name: "Shady Corp" }));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_MERCHANT_BLOCKED,
    ]);
  });

  it("an unverified merchant cannot reach ALLOW even when unlisted policy is ALLOW", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    });
    const result = run(policy, action(10, { domain: "unknown-shop.example" }));
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
    ]);
  });
});

// The D-3 amendment: the unverified-merchant cap is a ceiling on top of
// `unlisted`, not a replacement for it. `unlisted` is always evaluated
// first; the cap can only push the *decision* up toward DENY, never down
// past what `unlisted` already decided -- but the cap's own reason
// (STEP_UP_MERCHANT_UNVERIFIED) is now always attached too whenever the
// merchant isn't VERIFIED, alongside whatever `unlisted` produced, since
// both are independently true facts a receipt should carry. It only
// disappears from the final result the same way any STEP_UP-tier reason
// does: when `unlisted` already forced a DENY, and DENY > STEP_UP drops
// every STEP_UP-tier reason at the top of `evaluate()`.
describe("D-3 ceiling: unverified trust vs. the unlisted disposition", () => {
  // luckyspin.example is not in DIRECTORY, so this stays ASSERTED, not VERIFIED.
  const unverified = { domain: "unknown-shop.example" };
  // bestbuy.com is in DIRECTORY, so this is VERIFIED but still off the allowlist.
  const verified = { domain: "bestbuy.com" };

  it("unverified + unlisted DENY -> DENY", () => {
    const policy = policyFrom({ merchants: { allow: [], deny: [], unlisted: "DENY" } });
    const result = run(policy, action(10, unverified));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_MERCHANT_NOT_ALLOWLISTED,
    ]);
  });

  it("unverified + unlisted STEP_UP -> STEP_UP, carrying BOTH reasons, in evaluation order", () => {
    const policy = policyFrom({ merchants: { allow: [], deny: [], unlisted: "STEP_UP" } });
    const result = run(policy, action(10, unverified));
    expect(result.decision).toBe(Decision.STEP_UP);
    // Both facts are true and both belong on the receipt: not on the
    // allowlist (unlisted's own reason, evaluated first) AND not verified
    // (the D-3 cap, evaluated second) -- not just whichever one "wins."
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
      ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
    ]);
  });

  it("unverified + unlisted ALLOW -> STEP_UP (the D-3 cap)", () => {
    const policy = policyFrom({ merchants: { allow: [], deny: [], unlisted: "ALLOW" } });
    const result = run(policy, action(10, unverified));
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.STEP_UP_MERCHANT_UNVERIFIED,
    ]);
  });

  it("verified + unlisted DENY -> DENY", () => {
    const policy = policyFrom({ merchants: { allow: [], deny: [], unlisted: "DENY" } });
    const result = run(policy, action(10, verified));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_MERCHANT_NOT_ALLOWLISTED,
    ]);
  });

  it("verified + unlisted STEP_UP -> STEP_UP", () => {
    const policy = policyFrom({ merchants: { allow: [], deny: [], unlisted: "STEP_UP" } });
    const result = run(policy, action(10, verified));
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.STEP_UP_MERCHANT_NOT_ALLOWLISTED,
    ]);
  });

  it("verified + unlisted ALLOW -> ALLOW", () => {
    const policy = policyFrom({ merchants: { allow: [], deny: [], unlisted: "ALLOW" } });
    const result = run(policy, action(10, verified));
    expect(result.decision).toBe(Decision.ALLOW);
  });
});

// --- Individual dimensions ---------------------------------------------------

describe("per-transaction and cumulative limits", () => {
  it("denies over the per-transaction max", () => {
    const policy = policyFrom({ per_transaction_max: toMinorUnits(100, "USD") });
    const result = run(policy, action(101, { domain: "staples.com" }));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED);
  });

  it("sums prior spend plus the proposed action against the cumulative limit", () => {
    const policy = policyFrom({
      cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    });
    const spend: SpendSnapshot = {
      ...emptySpendSnapshot(),
      month: { amount: toMinorUnits(450, "USD"), count: 3 },
    };
    const result = run(policy, action(60, { domain: "staples.com" }), { spend });
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED);
  });

  it("stays within a cumulative limit that isn't exceeded", () => {
    const policy = policyFrom({
      cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    });
    const spend: SpendSnapshot = {
      ...emptySpendSnapshot(),
      month: { amount: toMinorUnits(400, "USD"), count: 3 },
    };
    const result = run(policy, action(60, { domain: "staples.com" }), { spend });
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("enforces a max transaction count as a velocity limit", () => {
    const policy = policyFrom({
      cumulative_limits: [
        { window: "day", max_amount: toMinorUnits(10000, "USD"), max_count: 3 },
      ],
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    });
    const spend: SpendSnapshot = {
      ...emptySpendSnapshot(),
      day: { amount: 0, count: 3 },
    };
    const result = run(policy, action(10, { domain: "staples.com" }), { spend });
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_VELOCITY_LIMIT_EXCEEDED);
  });

  it("triggers a cumulative step-up threshold before the hard limit is hit", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      step_up: {
        above_cumulative: { window: "month", amount: toMinorUnits(400, "USD") },
        ttl_seconds: 900,
      },
    });
    const spend: SpendSnapshot = {
      ...emptySpendSnapshot(),
      month: { amount: toMinorUnits(380, "USD"), count: 1 },
    };
    const result = run(policy, action(30, { domain: "staples.com" }), { spend });
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons[0]?.code).toBe(ReasonCode.STEP_UP_CUMULATIVE_THRESHOLD);
  });
});

describe("category rules", () => {
  it("denies a category on the denylist regardless of merchant trust", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    });
    const result = run(
      policy,
      action(50, { domain: "staples.com" }, { category: "crypto" }),
    );
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_CATEGORY_BLOCKED);
  });

  it("denies via deny_mcc using a directory-sourced MCC", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      categories: {
        allow: [],
        deny: [],
        deny_mcc: ["5732"], // Best Buy's directory MCC
        unlisted: "ALLOW",
      },
    });
    const result = run(
      policy,
      action(50, { domain: "bestbuy.com" }, { category: "electronics" }),
    );
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_CATEGORY_BLOCKED);
    expect(result.reasons[0]?.detail?.mcc_source).toBe("directory");
  });

  it("denies via deny_mcc on an agent-asserted MCC alone -- a claim of a blocked MCC is disqualifying (D-14)", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      categories: {
        allow: [],
        deny: [],
        deny_mcc: ["7995"],
        unlisted: "ALLOW",
      },
    });
    // unknown-shop.example is not in DIRECTORY -- the only source for this
    // MCC is the agent's own claim.
    const result = run(policy, action(50, { domain: "unknown-shop.example", mcc: "7995" }));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_CATEGORY_BLOCKED);
    expect(result.reasons[0]?.detail?.mcc_source).toBe("assertion");
  });

  it("steps up an unlisted category when the policy says to ask", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      categories: {
        allow: ["office_supplies"],
        deny: [],
        deny_mcc: [],
        unlisted: "STEP_UP",
      },
    });
    const result = run(
      policy,
      action(50, { domain: "staples.com" }, { category: "electronics" }),
    );
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons[0]?.code).toBe(ReasonCode.STEP_UP_CATEGORY_NOT_ALLOWLISTED);
  });

  it("treats a missing category the same as an unlisted one", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      categories: {
        allow: ["office_supplies"],
        deny: [],
        deny_mcc: [],
        unlisted: "DENY",
      },
    });
    const result = run(policy, action(50, { domain: "staples.com" }));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_CATEGORY_NOT_ALLOWLISTED);
  });
});

describe("currency", () => {
  it("denies a currency the policy does not permit", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      currency: "USD",
    });
    const result = run(policy, {
      amount: 1000,
      currency: "EUR" as never,
      merchant: { domain: "staples.com" } as never,
      attestations: {},
    } as ProposedAction);
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_CURRENCY_NOT_PERMITTED);
  });
});

describe("expiry", () => {
  it("denies once the policy's expires_at has passed", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      expires_at: "2026-08-01T00:00:00.000Z",
    });
    const result = run(policy, action(10, { domain: "staples.com" }), {
      now: new Date("2026-08-02T00:00:00.000Z"),
    });
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_MANDATE_EXPIRED);
  });
});

describe("time window", () => {
  it("denies outside the permitted days of week", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      time_window: { days_of_week: [1, 2, 3, 4, 5] }, // weekdays only
    });
    // 2026-08-23 is a Sunday.
    const result = run(policy, action(10, { domain: "staples.com" }), {
      now: new Date("2026-08-23T12:00:00.000Z"),
    });
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_OUTSIDE_TIME_WINDOW);
  });

  it("denies outside the permitted clock hours, in the policy timezone", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      accounting: { timezone: "America/New_York" },
      time_window: { start_time: "09:00", end_time: "17:00" },
    });
    // 2026-08-24T02:00Z is 22:00 the prior day in America/New_York (EDT).
    const result = run(policy, action(10, { domain: "staples.com" }), {
      now: new Date("2026-08-24T02:00:00.000Z"),
    });
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_OUTSIDE_TIME_WINDOW);
  });

  it("allows inside the time window", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      accounting: { timezone: "America/New_York" },
      time_window: { start_time: "09:00", end_time: "17:00" },
    });
    // 2026-08-24T16:00Z is 12:00 in America/New_York (EDT).
    const result = run(policy, action(10, { domain: "staples.com" }), {
      now: new Date("2026-08-24T16:00:00.000Z"),
    });
    expect(result.decision).toBe(Decision.ALLOW);
  });

  describe("overnight window (start_time > end_time wraps past midnight)", () => {
    const overnightPolicy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      accounting: { timezone: "UTC" },
      time_window: { start_time: "22:00", end_time: "06:00" },
    });

    it("allows shortly after the start time, before midnight", () => {
      const result = run(overnightPolicy, action(10, { domain: "staples.com" }), {
        now: new Date("2026-08-24T23:00:00.000Z"),
      });
      expect(result.decision).toBe(Decision.ALLOW);
    });

    it("allows shortly before the end time, after midnight", () => {
      const result = run(overnightPolicy, action(10, { domain: "staples.com" }), {
        now: new Date("2026-08-24T02:00:00.000Z"),
      });
      expect(result.decision).toBe(Decision.ALLOW);
    });

    it("denies mid-afternoon, outside the overnight window", () => {
      const result = run(overnightPolicy, action(10, { domain: "staples.com" }), {
        now: new Date("2026-08-24T12:00:00.000Z"),
      });
      expect(result.decision).toBe(Decision.DENY);
      expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_OUTSIDE_TIME_WINDOW);
    });
  });
});

describe("constraints", () => {
  it("denies a missing required attestation", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      constraints: [
        { key: "refundable", operator: "equals", value: true, required: true },
      ],
    });
    const result = run(policy, action(10, { domain: "staples.com" }));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_CONSTRAINT_NOT_SATISFIED);
  });

  it("allows a satisfied required attestation", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      constraints: [
        { key: "refundable", operator: "equals", value: true, required: true },
      ],
    });
    const result = run(
      policy,
      action(10, { domain: "staples.com" }, { attestations: { refundable: true } }),
    );
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("does not block on a failed non-required constraint", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      constraints: [
        { key: "nonstop", operator: "equals", value: true, required: false },
      ],
    });
    const result = run(policy, action(10, { domain: "staples.com" }));
    expect(result.decision).toBe(Decision.ALLOW);
  });
});

describe("step_up_on_first_use", () => {
  it("steps up the first transaction with a merchant even if allowlisted", () => {
    const policy = policyFrom({
      merchants: {
        allow: [{ scheme: "domain", value: "staples.com" }],
        deny: [],
        unlisted: "STEP_UP",
        step_up_on_first_use: true,
      },
    });
    const result = run(policy, action(10, { domain: "staples.com" }));
    expect(result.decision).toBe(Decision.STEP_UP);
    expect(result.reasons[0]?.code).toBe(ReasonCode.STEP_UP_FIRST_TIME_MERCHANT);
  });

  it("allows a repeat transaction with a previously seen merchant", () => {
    const policy = policyFrom({
      merchants: {
        allow: [{ scheme: "domain", value: "staples.com" }],
        deny: [],
        unlisted: "STEP_UP",
        step_up_on_first_use: true,
      },
    });
    const spend: SpendSnapshot = {
      ...emptySpendSnapshot(),
      seenMerchants: new Set([merchantRefKey({ scheme: "domain", value: "staples.com" })]),
    };
    const result = run(policy, action(10, { domain: "staples.com" }), { spend });
    expect(result.decision).toBe(Decision.ALLOW);
  });
});

describe("precedence", () => {
  it("DENY beats STEP_UP when both would independently apply", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "STEP_UP" }, // unverified merchant -> STEP_UP
      categories: {
        allow: [],
        deny: ["gambling"],
        deny_mcc: [],
        unlisted: "STEP_UP",
      },
    });
    const result = run(
      policy,
      action(10, { domain: "unknown-shop.example" }, { category: "gambling" }),
    );
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.every((r) => r.code.startsWith("DENY_"))).toBe(true);
  });

  it("returns only the winning tier's reasons, not lower-precedence ones", () => {
    const policy = policyFrom({
      per_transaction_max: toMinorUnits(5, "USD"),
      merchants: { allow: [], deny: [], unlisted: "STEP_UP" },
    });
    const result = run(policy, action(10, { domain: "unknown-shop.example" }));
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reasons.map((r) => r.code)).toEqual([
      ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED,
    ]);
  });
});

// Every reason message a human actually reads must show money the way a
// human reads money ($203.00), never the wire-format integer (20300) the
// engine compares internally. `detail` and every value on the wire stay
// raw minor units -- only `message` formats.
describe("reason messages format money, never bare minor units", () => {
  it("DENY_TRANSACTION_LIMIT_EXCEEDED formats the per-transaction maximum", () => {
    const policy = policyFrom({ per_transaction_max: toMinorUnits(150, "USD") });
    const result = run(policy, action(203, { domain: "staples.com" }));
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_TRANSACTION_LIMIT_EXCEEDED);
    expect(result.reasons[0]?.message).toBe(
      "The amount exceeds the per-transaction maximum of $150.00.",
    );
    // detail stays raw minor units -- only the human-readable message formats.
    expect(result.reasons[0]?.detail).toEqual({
      amount: toMinorUnits(203, "USD"),
      max: toMinorUnits(150, "USD"),
    });
  });

  it("DENY_CUMULATIVE_LIMIT_EXCEEDED formats both the projected total and the limit", () => {
    const policy = policyFrom({
      cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    });
    const spend: SpendSnapshot = {
      ...emptySpendSnapshot(),
      month: { amount: toMinorUnits(450, "USD"), count: 3 },
    };
    const result = run(policy, action(60, { domain: "staples.com" }), { spend });
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_CUMULATIVE_LIMIT_EXCEEDED);
    expect(result.reasons[0]?.message).toBe(
      "The action would bring month spend to $510.00, over the limit of $500.00.",
    );
  });

  it("STEP_UP_AMOUNT_THRESHOLD formats the threshold", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      step_up: { above_amount: toMinorUnits(150, "USD"), ttl_seconds: 900 },
    });
    const result = run(policy, action(150, { domain: "staples.com" }));
    expect(result.reasons[0]?.code).toBe(ReasonCode.STEP_UP_AMOUNT_THRESHOLD);
    expect(result.reasons[0]?.message).toBe(
      "The amount is at or above the mandate's step-up threshold of $150.00.",
    );
  });

  it("STEP_UP_CUMULATIVE_THRESHOLD formats both the projected total and the threshold", () => {
    const policy = policyFrom({
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
      step_up: {
        above_cumulative: { window: "month", amount: toMinorUnits(400, "USD") },
        ttl_seconds: 900,
      },
    });
    const spend: SpendSnapshot = {
      ...emptySpendSnapshot(),
      month: { amount: toMinorUnits(380, "USD"), count: 1 },
    };
    const result = run(policy, action(30, { domain: "staples.com" }), { spend });
    expect(result.reasons[0]?.code).toBe(ReasonCode.STEP_UP_CUMULATIVE_THRESHOLD);
    expect(result.reasons[0]?.message).toBe(
      "Projected month spend of $410.00 is at or above the step-up threshold of $400.00.",
    );
  });

  it("DENY_VELOCITY_LIMIT_EXCEEDED is a transaction count, not money -- stays a bare integer", () => {
    const policy = policyFrom({
      cumulative_limits: [{ window: "day", max_amount: toMinorUnits(10000, "USD"), max_count: 3 }],
      merchants: { allow: [], deny: [], unlisted: "ALLOW" },
    });
    const spend: SpendSnapshot = { ...emptySpendSnapshot(), day: { amount: 0, count: 3 } };
    const result = run(policy, action(10, { domain: "staples.com" }), { spend });
    expect(result.reasons[0]?.code).toBe(ReasonCode.DENY_VELOCITY_LIMIT_EXCEEDED);
    expect(result.reasons[0]?.message).toBe(
      "The action would bring the day transaction count to 4, over the limit of 3.",
    );
  });

  it("no reason message, across every reason code that carries a minor-unit amount, contains the bare integer", () => {
    // One scenario per money-bearing reason code, each with a distinct,
    // easy-to-spot raw minor-unit value (in the tens of thousands) that
    // must never appear literally in the message -- only its formatted
    // dollar form may.
    const scenarios: { result: ReturnType<typeof run>; rawMinorUnits: number[] }[] = [
      {
        result: run(
          policyFrom({ per_transaction_max: toMinorUnits(150, "USD") }),
          action(203, { domain: "staples.com" }),
        ),
        rawMinorUnits: [toMinorUnits(150, "USD"), toMinorUnits(203, "USD")],
      },
      {
        result: run(
          policyFrom({
            cumulative_limits: [{ window: "month", max_amount: toMinorUnits(500, "USD") }],
            merchants: { allow: [], deny: [], unlisted: "ALLOW" },
          }),
          action(60, { domain: "staples.com" }),
          {
            spend: {
              ...emptySpendSnapshot(),
              month: { amount: toMinorUnits(450, "USD"), count: 3 },
            },
          },
        ),
        rawMinorUnits: [toMinorUnits(500, "USD"), toMinorUnits(510, "USD")],
      },
      {
        result: run(
          policyFrom({
            merchants: { allow: [], deny: [], unlisted: "ALLOW" },
            step_up: { above_amount: toMinorUnits(150, "USD"), ttl_seconds: 900 },
          }),
          action(150, { domain: "staples.com" }),
        ),
        rawMinorUnits: [toMinorUnits(150, "USD")],
      },
      {
        result: run(
          policyFrom({
            merchants: { allow: [], deny: [], unlisted: "ALLOW" },
            step_up: {
              above_cumulative: { window: "month", amount: toMinorUnits(400, "USD") },
              ttl_seconds: 900,
            },
          }),
          action(30, { domain: "staples.com" }),
          {
            spend: {
              ...emptySpendSnapshot(),
              month: { amount: toMinorUnits(380, "USD"), count: 1 },
            },
          },
        ),
        rawMinorUnits: [toMinorUnits(400, "USD"), toMinorUnits(410, "USD")],
      },
    ];

    for (const { result, rawMinorUnits } of scenarios) {
      expect(result.reasons.length).toBeGreaterThan(0);
      for (const reason of result.reasons) {
        for (const raw of rawMinorUnits) {
          expect(reason.message).not.toMatch(new RegExp(`\\b${raw}\\b`));
        }
        // Every money-bearing message must show at least one properly
        // formatted dollar amount instead.
        expect(reason.message).toMatch(/\$\d[\d,]*\.\d{2}/);
      }
    }
  });
});
