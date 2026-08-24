/**
 * Money in AgentPay is ALWAYS an integer number of minor units, never a float.
 *
 * The PRD's example request used `"amount": 687`, which is ambiguous between
 * $687.00 and $6.87. That ambiguity is resolved here and enforced by the schema:
 * every amount crossing an AgentPay boundary is minor units (cents for USD).
 *
 * $687.00 -> 68700
 * $6.87   ->   687
 */

import { z } from "zod";

/** ISO-4217 codes AgentPay accepts. MVP is USD-only; the enum is the extension point. */
export const SUPPORTED_CURRENCIES = ["USD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const CurrencySchema = z.enum(SUPPORTED_CURRENCIES);

/** Number of minor units per major unit, per currency. */
const MINOR_UNIT_EXPONENT: Record<Currency, number> = {
  USD: 2,
};

/** A non-negative integer count of minor units. */
export const MinorUnitsSchema = z
  .number()
  .int("amounts must be integer minor units (cents), not decimals")
  .nonnegative("amounts must be non-negative");

export type MinorUnits = number;

export interface Money {
  amount: MinorUnits;
  currency: Currency;
}

export const MoneySchema = z.object({
  amount: MinorUnitsSchema,
  currency: CurrencySchema,
});

/** Convert a major-unit decimal (e.g. 6.87) to minor units (687). Rounds half-up. */
export function toMinorUnits(major: number, currency: Currency): MinorUnits {
  const factor = 10 ** MINOR_UNIT_EXPONENT[currency];
  return Math.round(major * factor);
}

/** Convert minor units (687) to a major-unit decimal (6.87). Display only. */
export function toMajorUnits(minor: MinorUnits, currency: Currency): number {
  const factor = 10 ** MINOR_UNIT_EXPONENT[currency];
  return minor / factor;
}

/** Human-readable formatting. Display only — never round-trip through this. */
export function formatMoney(money: Money): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
  }).format(toMajorUnits(money.amount, money.currency));
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(
      `currency mismatch: cannot compare ${a.currency} with ${b.currency}`,
    );
  }
}
