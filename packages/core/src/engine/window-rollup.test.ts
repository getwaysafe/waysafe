/**
 * D-87: the counting rule itself, offline.
 *
 * The R3 cases in `apps/api/src/review2.adversarial.test.ts` prove this
 * through real HTTP and real Postgres, which is what makes them evidence.
 * They are also slow and Postgres-gated. This file pins the rule directly so
 * a change to it fails in the offline pass, within a second, naming the case.
 */

import { describe, expect, it } from "vitest";
import { rollUpWindow, type LedgerRollupEntry } from "./window-rollup.js";

const ACCOUNTING = { refunds_credit_budget: false } as const;
const CREDITING = { refunds_credit_budget: true } as const;

const e = (
  transactionKey: string,
  type: LedgerRollupEntry["type"],
  amount: number,
): LedgerRollupEntry => ({ transactionKey, type, amount });

describe("rollUpWindow (D-87)", () => {
  it("counts a pending reservation", () => {
    expect(rollUpWindow([e("a", "RESERVATION", 1000)], ACCOUNTING)).toEqual({
      amount: 1000,
      count: 1,
    });
  });

  it("still counts a transaction after it settles", () => {
    // RELEASE + CAPTURE is what settlement writes. The old rule computed
    // count as reservations minus releases and returned 0 here, so every
    // completed payment gave its max_count slot back.
    const entries = [e("a", "RESERVATION", 1000), e("a", "RELEASE", -1000), e("a", "CAPTURE", 1000)];
    expect(rollUpWindow(entries, ACCOUNTING)).toEqual({ amount: 1000, count: 1 });
  });

  it("does not count a reservation released WITHOUT a capture", () => {
    // A reversal, an expiry, a declined step-up, a failed execution.
    const entries = [e("a", "RESERVATION", 1000), e("a", "RELEASE", -1000)];
    expect(rollUpWindow(entries, ACCOUNTING)).toEqual({ amount: 0, count: 0 });
  });

  it("counts a capture with no prior reservation", () => {
    // A force capture (D-84): the one case the old rule could not see at all.
    expect(rollUpWindow([e("a", "CAPTURE", 700)], ACCOUNTING)).toEqual({ amount: 700, count: 1 });
  });

  it("counts one transaction once across several ledger rows", () => {
    // D-79's revisions: two Authorization rows, one external authorization.
    const entries = [
      e("ipi_1", "RESERVATION", 1000),
      e("ipi_1", "RESERVATION", 1500),
      e("ipi_1", "RELEASE", -2500),
      e("ipi_1", "CAPTURE", 2500),
    ];
    expect(rollUpWindow(entries, ACCOUNTING)).toEqual({ amount: 2500, count: 1 });
  });

  it("counts distinct transactions separately", () => {
    const entries = [e("a", "RESERVATION", 100), e("b", "CAPTURE", 200)];
    expect(rollUpWindow(entries, ACCOUNTING)).toEqual({ amount: 300, count: 2 });
  });

  it("excludeFromCount drops one transaction from count but never from amount", () => {
    const entries = [e("a", "RESERVATION", 1000), e("b", "RESERVATION", 500)];
    expect(rollUpWindow(entries, ACCOUNTING, { excludeFromCount: "a" })).toEqual({
      amount: 1500,
      count: 1,
    });
  });

  it("a refund never changes the count, whichever way it credits the budget", () => {
    const entries = [
      e("a", "RESERVATION", 1000),
      e("a", "RELEASE", -1000),
      e("a", "CAPTURE", 1000),
      e("a", "CREDIT", -1000),
    ];
    // A refunded payment still happened.
    expect(rollUpWindow(entries, ACCOUNTING)).toEqual({ amount: 1000, count: 1 });
    expect(rollUpWindow(entries, CREDITING)).toEqual({ amount: 0, count: 1 });
  });

  it("never returns a negative count", () => {
    // A RELEASE whose RESERVATION fell in another window (D-72 makes this
    // rare rather than impossible). The old rule clamped with Math.max; this
    // one cannot go negative by construction, and the assertion says so.
    expect(rollUpWindow([e("a", "RELEASE", -1000)], ACCOUNTING).count).toBe(0);
  });
});
