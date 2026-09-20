import { validationError } from "./errors.ts";

/**
 * Money as integer minor units.
 *
 * buildspec.md §1.6: "Amounts use integer minor units. Never use floating-point arithmetic for
 * money." Amounts are `bigint`, so there is no silent precision loss and no `number` anywhere in
 * this file's public surface. buildspec.md §16 additionally requires the values to fit a signed
 * 64-bit integer, because that is what SQLite stores — `bigint` would happily exceed that, so the
 * range is checked explicitly on every result.
 */

export type Currency = {
  readonly code: string;
  readonly minorUnitDigits: number;
};

export type Money = {
  readonly currency: Currency;
  readonly minor: bigint;
};

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function defineCurrency(code: string, minorUnitDigits: number): Currency {
  return Object.freeze({ code, minorUnitDigits });
}

/**
 * buildspec.md §2 makes LKR the onboarding default but forbids inferring an account's currency
 * from the phone locale, so this is a lookup table and never a guess. Unknown codes are rejected
 * rather than defaulted to two decimals: a wrong scale multiplies or divides real money by 100.
 */
export const CURRENCIES: Readonly<Record<string, Currency>> = Object.freeze({
  // Two-decimal currencies.
  LKR: defineCurrency("LKR", 2),
  USD: defineCurrency("USD", 2),
  EUR: defineCurrency("EUR", 2),
  GBP: defineCurrency("GBP", 2),
  INR: defineCurrency("INR", 2),
  AUD: defineCurrency("AUD", 2),
  CAD: defineCurrency("CAD", 2),
  SGD: defineCurrency("SGD", 2),
  AED: defineCurrency("AED", 2),
  CHF: defineCurrency("CHF", 2),
  CNY: defineCurrency("CNY", 2),
  MYR: defineCurrency("MYR", 2),
  THB: defineCurrency("THB", 2),
  NZD: defineCurrency("NZD", 2),
  SAR: defineCurrency("SAR", 2),
  QAR: defineCurrency("QAR", 2),
  ZAR: defineCurrency("ZAR", 2),
  // Zero-decimal currencies: one minor unit is one major unit.
  JPY: defineCurrency("JPY", 0),
  KRW: defineCurrency("KRW", 0),
  VND: defineCurrency("VND", 0),
  IDR: defineCurrency("IDR", 0),
  ISK: defineCurrency("ISK", 0),
  CLP: defineCurrency("CLP", 0),
  // Three-decimal currencies.
  KWD: defineCurrency("KWD", 3),
  BHD: defineCurrency("BHD", 3),
  OMR: defineCurrency("OMR", 3),
  JOD: defineCurrency("JOD", 3),
  TND: defineCurrency("TND", 3),
});

export const LKR = CURRENCIES.LKR!;

/** Currencies offered in the selector, onboarding default first (buildspec.md §2). */
export const SUPPORTED_CURRENCIES: readonly Currency[] = Object.freeze([
  LKR,
  ...Object.values(CURRENCIES)
    .filter((c) => c.code !== "LKR")
    .sort((a, b) => a.code.localeCompare(b.code)),
]);

export function findCurrency(code: string): Currency | undefined {
  return CURRENCIES[code.trim().toUpperCase()];
}

export function requireCurrency(code: string): Currency {
  const found = findCurrency(code);
  if (!found) {
    throw validationError(
      `Unsupported currency code '${code}'. Add its minor-unit scale before using it.`,
      { currency: code },
    );
  }
  return found;
}

function pow10(digits: number): bigint {
  return 10n ** BigInt(digits);
}

function checkRange(value: bigint, context: string): bigint {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw validationError(`Money value overflowed 64 bits while trying to ${context}`);
  }
  return value;
}

function sameCurrency(a: Money, b: Money, operation: string): void {
  if (a.currency.code !== b.currency.code) {
    // buildspec.md §9.1: "Never sum different currencies into one unlabeled number."
    throw validationError(`Cannot ${operation} ${a.currency.code} and ${b.currency.code} directly`, {
      left: a.currency.code,
      right: b.currency.code,
    });
  }
}

export function money(currency: Currency, minor: bigint): Money {
  return Object.freeze({ currency, minor: checkRange(minor, "create an amount") });
}

export function zero(currency: Currency): Money {
  return money(currency, 0n);
}

/** Builds an amount from whole major units: `majorUnits(LKR, 3450n)` is `LKR 3,450.00`. */
export function majorUnits(currency: Currency, whole: bigint): Money {
  return money(currency, whole * pow10(currency.minorUnitDigits));
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b, "add");
  return money(a.currency, a.minor + b.minor);
}

export function subtractMoney(a: Money, b: Money): Money {
  sameCurrency(a, b, "subtract");
  return money(a.currency, a.minor - b.minor);
}

export function negateMoney(a: Money): Money {
  return money(a.currency, -a.minor);
}

export function absMoney(a: Money): Money {
  return a.minor < 0n ? negateMoney(a) : a;
}

export function compareMoney(a: Money, b: Money): number {
  sameCurrency(a, b, "compare");
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency.code === b.currency.code && a.minor === b.minor;
}

export function isZero(a: Money): boolean {
  return a.minor === 0n;
}

export function isPositive(a: Money): boolean {
  return a.minor > 0n;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0n;
}

/** Sums amounts known to share one currency. An empty list still needs an explicit currency. */
export function sumMoney(amounts: Iterable<Money>, currency: Currency): Money {
  let total = zero(currency);
  for (const amount of amounts) total = addMoney(total, amount);
  return total;
}

/**
 * Splits an amount into `parts` shares that sum back to exactly the original.
 *
 * buildspec.md §7.5: "Split transactions allocate exact minor units; sum of splits must equal the
 * total." The remainder is handed out one minor unit at a time to the leading shares instead of
 * being rounded away.
 */
export function splitEvenly(amount: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw validationError(`Cannot split money into ${parts} parts`);
  }
  const divisor = BigInt(parts);
  const base = amount.minor / divisor;
  const remainder = amount.minor % divisor;
  const step = amount.minor < 0n ? -1n : 1n;
  const extras = remainder < 0n ? -remainder : remainder;
  return Array.from({ length: parts }, (_unused, index) =>
    money(amount.currency, BigInt(index) < extras ? base + step : base),
  );
}

/**
 * Allocates a total across weights so the parts sum to exactly the total (largest-remainder).
 * Used by split transactions and by bill allocations.
 */
export function allocateProportionally(amount: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw validationError("Cannot allocate across zero weights");
  if (weights.some((w) => w < 0n)) throw validationError("Allocation weights must not be negative");
  const totalWeight = weights.reduce((acc, w) => acc + w, 0n);
  if (totalWeight === 0n) throw validationError("Allocation weights must not all be zero");

  const shares = weights.map((w) => (amount.minor * w) / totalWeight);
  let allocated = shares.reduce((acc, s) => acc + s, 0n);
  let remainder = amount.minor - allocated;
  const step = remainder < 0n ? -1n : 1n;

  // Hand the rounding remainder to the largest fractional parts first.
  const order = weights
    .map((w, index) => ({ index, fraction: (amount.minor * w) % totalWeight }))
    .sort((a, b) => (b.fraction === a.fraction ? a.index - b.index : b.fraction > a.fraction ? 1 : -1));

  let cursor = 0;
  while (remainder !== 0n && order.length > 0) {
    const target = order[cursor % order.length]!;
    shares[target.index] = shares[target.index]! + step;
    remainder -= step;
    cursor += 1;
  }
  allocated = shares.reduce((acc, s) => acc + s, 0n);
  if (allocated !== amount.minor) {
    throw validationError("Allocation did not reproduce the original total");
  }
  return shares.map((s) => money(amount.currency, s));
}

/**
 * Strict parser for the minor-unit wire format of buildspec.md §16 ("decimal-string minor units").
 * Accepts an optional sign followed by digits, and nothing else.
 */
export function parseMinorUnits(currency: Currency, text: string): Money {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw validationError("Minor-unit amount must be an optionally signed integer string", {
      value: text,
    });
  }
  return money(currency, BigInt(trimmed));
}

/**
 * Parses a human decimal such as `3,450.00` or `3450.5` into minor units.
 *
 * buildspec.md §9.1: "Reject excess fractional digits instead of silently rounding imported money."
 * More fraction digits than the currency allows is an error, not a rounding opportunity.
 */
export function parseMajorUnits(currency: Currency, text: string): Money {
  const compact = text.trim().replace(/[ \s]/g, "");
  if (compact.length === 0) throw validationError("Empty amount", { value: text });

  /*
   * Grouping separators are validated rather than stripped. Blindly deleting every comma turns the
   * European form `3.450,00` into `3.45000` — a silent factor-of-100 error on an imported bank
   * message. This parser accepts only the canonical form; normalising a sender's local number
   * format is the extraction layer's job, where the sender template says which style to expect.
   */
  const grouped = /^([+-]?)(\d{1,3}(?:,\d{3})+)(?:\.(\d*))?$/.exec(compact);
  const plain = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(compact);
  const match = grouped ?? plain;
  if (!match) {
    throw validationError("Amount is not a plain decimal number", { value: text });
  }
  const [, sign = "", rawWhole = "0", fraction = ""] = match;
  const whole = rawWhole.replace(/,/g, "");
  if (fraction.length > currency.minorUnitDigits) {
    throw validationError(
      `Amount has ${fraction.length} fraction digits but ${currency.code} allows ` +
        `${currency.minorUnitDigits}`,
      { value: text, currency: currency.code },
    );
  }
  const padded = fraction.padEnd(currency.minorUnitDigits, "0");
  const magnitude = BigInt(whole) * pow10(currency.minorUnitDigits) + BigInt(padded || "0");
  return money(currency, sign === "-" ? -magnitude : magnitude);
}

function groupDigits(digits: string, enabled: boolean): string {
  if (!enabled || digits.length <= 3) return digits;
  let out = "";
  for (let i = digits.length; i > 0; i -= 3) {
    const start = Math.max(0, i - 3);
    out = digits.slice(start, i) + (out ? "," + out : "");
  }
  return out;
}

export type FormatMoneyOptions = {
  /** Include thousands separators. Default true. */
  grouping?: boolean;
  /** Prefix the ISO code, e.g. `LKR 3,450.00`. Default true. */
  withCode?: boolean;
  /** Always show a leading `+` for positive values. Default false. */
  signed?: boolean;
};

/**
 * Renders an amount for display. Never used for arithmetic.
 *
 * buildspec.md §13 asks for tabular digits and for income/expense to be distinguished by "signs and
 * labels, not color alone", which is why `signed` exists.
 */
export function formatMoney(amount: Money, options: FormatMoneyOptions = {}): string {
  const { grouping = true, withCode = true, signed = false } = options;
  const negative = amount.minor < 0n;
  const magnitude = negative ? -amount.minor : amount.minor;
  const digits = amount.currency.minorUnitDigits;

  let body: string;
  if (digits === 0) {
    body = groupDigits(magnitude.toString(), grouping);
  } else {
    const padded = magnitude.toString().padStart(digits + 1, "0");
    const whole = padded.slice(0, padded.length - digits);
    const fraction = padded.slice(padded.length - digits);
    body = `${groupDigits(whole, grouping)}.${fraction}`;
  }

  const sign = negative ? "-" : signed ? "+" : "";
  return withCode ? `${amount.currency.code} ${sign}${body}` : `${sign}${body}`;
}

/** The wire representation of buildspec.md §16: minor units as a decimal string, plus the code. */
export type MoneyWire = { readonly amount_minor: string; readonly currency: string };

export function toWire(amount: Money): MoneyWire {
  return { amount_minor: amount.minor.toString(), currency: amount.currency.code };
}

export function fromWire(wire: MoneyWire): Money {
  return parseMinorUnits(requireCurrency(wire.currency), wire.amount_minor);
}
