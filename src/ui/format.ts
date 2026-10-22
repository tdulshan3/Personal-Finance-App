import type { Money } from "../core/domain/money.ts";
import { formatMoney } from "../core/domain/money.ts";

/**
 * Display helpers shared by both looks and by the server pages.
 *
 * Money is only ever *formatted* here, with the domain's own `formatMoney`, so the browser never
 * does arithmetic on an amount (buildspec.md §1.6). Dates are local calendar dates (`YYYY-MM-DD`)
 * and are formatted in UTC, which is the one zone where such a date means exactly itself.
 */

export const money = (amount: Money, options?: { withCode?: boolean; signed?: boolean }) => formatMoney(amount, options);

/** An amount without its code and with the minus sign written as the typographic one. */
export function bare(amount: Money): string {
  return formatMoney(amount, { withCode: false }).replace(/^-/, "−");
}

/**
 * A transaction's amount the way a bank statement writes it: money out with a minus, money in with
 * a plus, a transfer or an opening balance with neither. The sign and the kind's label carry the
 * meaning, never colour (buildspec.md §13).
 */
export function signedAmount(kind: string, amount: Money, withCode = true): string {
  const body = formatMoney(amount.minor < 0n ? { currency: amount.currency, minor: -amount.minor } : amount, { withCode: false });
  const prefix = withCode ? `${amount.currency.code} ` : "";
  if (kind === "expense") return `${prefix}−${body}`;
  if (kind === "income" || kind === "refund") return `${prefix}+${body}`;
  return amount.minor < 0n ? `${prefix}−${body}` : `${prefix}${body}`;
}

/** Positive with a plus, negative with a typographic minus. */
export function delta(amount: Money): string {
  if (amount.minor === 0n) return formatMoney(amount);
  const body = formatMoney(amount.minor < 0n ? { currency: amount.currency, minor: -amount.minor } : amount, { withCode: false });
  return `${amount.currency.code} ${amount.minor < 0n ? "−" : "+"}${body}`;
}

/** For an edit field: plain major units, no grouping, no code — "3450.00". */
export const plainAmount = (amount: Money) => formatMoney(amount, { withCode: false, grouping: false });

const utc = (date: string) => new Date(`${date}T00:00:00Z`);

/** "22 Oct", or "22 Oct 2025" when it is not this year. */
export function shortDate(date: string, today?: string): string {
  const sameYear = today !== undefined && today.slice(0, 4) === date.slice(0, 4);
  return utc(date).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** "22 October 2026". */
export const longDate = (date: string) => utc(date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** "Thursday, 22 October". */
export const weekdayDate = (date: string) => utc(date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** "Oct" for "2026-10". */
export const monthShort = (yearMonth: string) => utc(`${yearMonth}-01`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

/** "October 2026" for "2026-10". */
export const monthLong = (yearMonth: string) => utc(`${yearMonth}-01`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** "today", "tomorrow", "in 3 days", "yesterday", "3 days ago". */
export function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** Axis ticks and other places with no room: 950, 12K, 1.4M (whole units, no code). */
export function compact(minor: bigint | number, digits: number): string {
  const major = Number(minor) / 10 ** digits;
  const size = Math.abs(major);
  const sign = major < 0 ? "−" : "";
  if (size >= 1_000_000) return `${sign}${trim(size / 1_000_000)}M`;
  if (size >= 1_000) return `${sign}${trim(size / 1_000)}K`;
  return `${sign}${Math.round(size)}`;
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

/** `YYYY-MM-DD` → a Date at local midnight of that calendar day, for the iOS date picker. */
export function dateFromLocal(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

/** A Date from the iOS date picker → its local calendar day as `YYYY-MM-DD`. */
export function localFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** "3 transactions", "1 transaction". */
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
