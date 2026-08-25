import { describe, expect, it } from "vitest";
import { dayKey, monthKey, weekKey, windowKeys, zonedParts } from "./time.js";

describe("zonedParts", () => {
  it("renders a UTC instant in a non-UTC timezone", () => {
    // 2026-08-24T02:30:00Z is 2026-08-23T22:30 in America/New_York (EDT, UTC-4).
    const date = new Date("2026-08-24T02:30:00.000Z");
    const parts = zonedParts(date, "America/New_York");
    expect(parts).toEqual({
      year: 2026,
      month: 8,
      day: 23,
      hour: 22,
      minute: 30,
      weekday: 0, // Sunday
    });
  });

  it("normalizes ICU midnight-as-24 to hour 0", () => {
    const date = new Date("2026-08-24T04:00:00.000Z"); // midnight in America/New_York (EDT)
    const parts = zonedParts(date, "America/New_York");
    expect(parts.hour).toBe(0);
  });
});

describe("dayKey / monthKey", () => {
  it("uses the zone's calendar date, which can differ from UTC's", () => {
    const date = new Date("2026-08-24T02:30:00.000Z");
    expect(dayKey(date, "America/New_York")).toBe("2026-08-23");
    expect(dayKey(date, "UTC")).toBe("2026-08-24");
    expect(monthKey(date, "America/New_York")).toBe("2026-08");
  });

  it("rolls a month key at the zone's month boundary", () => {
    // 2026-09-01T02:00Z is 2026-08-31T22:00 in America/New_York.
    const date = new Date("2026-09-01T02:00:00.000Z");
    expect(monthKey(date, "America/New_York")).toBe("2026-08");
    expect(monthKey(date, "UTC")).toBe("2026-09");
  });
});

describe("weekKey", () => {
  it("assigns Monday through Sunday to the same ISO week", () => {
    // 2026-08-24 is a Monday; 2026-08-30 is the following Sunday.
    const monday = dayKeyToWeek("2026-08-24T12:00:00.000Z");
    const sunday = dayKeyToWeek("2026-08-30T12:00:00.000Z");
    expect(monday).toBe(sunday);
  });

  it("puts the next Monday in a new ISO week", () => {
    const sunday = dayKeyToWeek("2026-08-30T12:00:00.000Z");
    const nextMonday = dayKeyToWeek("2026-08-31T12:00:00.000Z");
    expect(sunday).not.toBe(nextMonday);
  });

  it("assigns the year's first Thursday's week as week 01", () => {
    // 2026-01-01 is a Thursday, so it must be in week 01 of 2026.
    expect(weekKey(new Date("2026-01-01T12:00:00.000Z"), "UTC")).toBe(
      "2026-W01",
    );
  });

  it("assigns a year-end Monday to next year's week 01 when appropriate", () => {
    // 2029-12-31 is a Monday; ISO week rules put it in week 01 of 2030
    // because that week's Thursday (2030-01-03) falls in 2030.
    expect(weekKey(new Date("2029-12-31T12:00:00.000Z"), "UTC")).toBe(
      "2030-W01",
    );
  });

  function dayKeyToWeek(iso: string): string {
    return weekKey(new Date(iso), "UTC");
  }
});

describe("windowKeys", () => {
  it("bundles all three keys for the same instant and zone", () => {
    const date = new Date("2026-08-24T12:00:00.000Z");
    const keys = windowKeys(date, "America/New_York");
    expect(keys).toEqual({
      day: dayKey(date, "America/New_York"),
      week: weekKey(date, "America/New_York"),
      month: monthKey(date, "America/New_York"),
    });
  });
});
