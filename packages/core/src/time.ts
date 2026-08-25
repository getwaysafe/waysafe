/**
 * Timezone-aware calendar windows.
 *
 * A policy's cumulative limits and time-of-day rules are defined in the
 * policy's own timezone (`accounting.timezone`), not the server's. Everything
 * here derives calendar facts — day, ISO week, month, weekday, clock time —
 * from a UTC instant plus an IANA zone, with no external date library.
 *
 * Window keys (`dayKey`, `weekKey`, `monthKey`) are precomputed from these
 * functions at ledger-write time, per D-4, so a window's membership never
 * shifts under a stored row.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday, matching TimeWindowSchema.days_of_week. */
  weekday: number;
}

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = PARTS_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    PARTS_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar date and clock time of `date` as observed in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  const year = get("year");
  const month = get("month");
  const day = get("day");
  // Some ICU implementations render midnight as "24" under hour12:false.
  const hour = get("hour") % 24;
  const minute = get("minute");

  // Weekday depends only on the civil (year, month, day) triple, not on the
  // wall-clock time or the zone's UTC offset, so deriving it from a
  // UTC-anchored construction of that date is safe and avoids a second
  // Intl call.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return { year, month, day, hour, minute, weekday };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** "YYYY-MM-DD" in the given timezone. */
export function dayKey(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "YYYY-MM" in the given timezone. */
export function monthKey(date: Date, timeZone: string): string {
  const { year, month } = zonedParts(date, timeZone);
  return `${year}-${pad(month)}`;
}

/**
 * "YYYY-Www", ISO-8601 week (Monday start, week 1 contains the year's first
 * Thursday), computed against the civil date in the given timezone.
 */
export function weekKey(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);

  // Thursday of the current ISO week.
  const anchor = new Date(Date.UTC(year, month - 1, day));
  const isoDayNr = (anchor.getUTCDay() + 6) % 7; // Monday=0 ... Sunday=6
  anchor.setUTCDate(anchor.getUTCDate() - isoDayNr + 3);

  const isoYear = anchor.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstIsoDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIsoDayNr + 3);

  const week =
    1 +
    Math.round(
      (anchor.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );

  return `${isoYear}-W${pad(week)}`;
}

export interface WindowKeys {
  day: string;
  week: string;
  month: string;
}

export function windowKeys(date: Date, timeZone: string): WindowKeys {
  return {
    day: dayKey(date, timeZone),
    week: weekKey(date, timeZone),
    month: monthKey(date, timeZone),
  };
}
