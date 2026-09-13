import { describe, expect, it } from "vitest";
import { balancesAtMs, buildAct1Notifications, NOTIFICATION_TIMES_MS } from "./act1-timeline";
import { ATTACKER_NOTIFICATIONS, STARTING_CARD_BALANCE_CENTS, STARTING_WALLET_USDC_ATOMIC } from "./constants";

describe("/film Act 1 timeline (D-44)", () => {
  it("is fixed and deterministic -- same call, same result, no seed involved", () => {
    expect(buildAct1Notifications()).toEqual(buildAct1Notifications());
  });

  it("carries every notification from constants.ts, in order, with strictly increasing times", () => {
    const notifications = buildAct1Notifications();
    expect(notifications).toHaveLength(ATTACKER_NOTIFICATIONS.length);
    notifications.forEach((n, i) => {
      expect(n.rail).toBe(ATTACKER_NOTIFICATIONS[i]!.rail);
      expect(n.atMs).toBe(NOTIFICATION_TIMES_MS[i]);
      if (i > 0) expect(n.atMs).toBeGreaterThan(notifications[i - 1]!.atMs);
    });
  });

  it("the gaps between notifications shrink -- 'faster and faster', not evenly spaced", () => {
    const [t0, t1, t2] = NOTIFICATION_TIMES_MS;
    expect(t1 - t0).toBeGreaterThan(t2 - t1);
  });

  it("starts at the full starting balance before any notification fires", () => {
    expect(balancesAtMs(0)).toEqual({
      cardCents: STARTING_CARD_BALANCE_CENTS,
      walletAtomic: STARTING_WALLET_USDC_ATOMIC,
    });
  });

  it("both balances reach exactly zero once every notification has fired", () => {
    const balances = balancesAtMs(NOTIFICATION_TIMES_MS[NOTIFICATION_TIMES_MS.length - 1]!);
    expect(balances.cardCents).toBe(0);
    expect(balances.walletAtomic).toBe(0n);
  });

  it("deducts only the card balance on a card notification, only the wallet on a stablecoin one", () => {
    const beforeFirst = balancesAtMs(NOTIFICATION_TIMES_MS[0]! - 1);
    const afterFirst = balancesAtMs(NOTIFICATION_TIMES_MS[0]!);
    expect(afterFirst.cardCents).toBeLessThan(beforeFirst.cardCents);
    expect(afterFirst.walletAtomic).toBe(beforeFirst.walletAtomic);

    const beforeSecond = balancesAtMs(NOTIFICATION_TIMES_MS[1]! - 1);
    const afterSecond = balancesAtMs(NOTIFICATION_TIMES_MS[1]!);
    expect(afterSecond.walletAtomic).toBeLessThan(beforeSecond.walletAtomic);
    expect(afterSecond.cardCents).toBe(beforeSecond.cardCents);
  });

  it("never goes negative for an elapsed time far past the last notification", () => {
    const balances = balancesAtMs(999_999);
    expect(balances.cardCents).toBe(0);
    expect(balances.walletAtomic).toBe(0n);
  });
});
