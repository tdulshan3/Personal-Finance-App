import { validationError } from "./errors.ts";

/**
 * Time handling for the ledger.
 *
 * buildspec.md §9.1: "Store UTC instants, original timezone/offset where known, the local financial
 * date, and timestamp precision. Due dates are local dates in a plan timezone. Store creation time
 * separately from effective financial time."
 *
 * Node has no `Temporal` yet, so zone arithmetic goes through `Intl.DateTimeFormat`, which is the
 * only zone database the runtime exposes. Everything here works in epoch milliseconds (`Instant`)
 * and ISO `YYYY-MM-DD` strings (`LocalDate`) rather than `Date`, because a `Date` carries the
 * host's zone around with it and invites accidental local-time bugs.
 */

/** Milliseconds since the Unix epoch, UTC. */
export type Instant = number;

/** An ISO-8601 calendar date with no time and no zone, e.g. `2026-09-20`. */
export type LocalDate = string;

/** An IANA zone id, e.g. `Asia/Colombo`. */
export type ZoneId = string;

/**
 * How much we actually know about when a financial event happened.
 *
 * buildspec.md §7.1: "Store message received time separately from financial occurrence time, plus
 * a precision flag such as exact, date-only, or inferred." §16 adds that a midnight value "encodes
 * a date-only boundary; it is not proof that the purchase happened at midnight."
 */
export const TimePrecision = {
  /** The source stated a wall-clock time we trust to the minute or better. */
  EXACT: "exact",
  /** The source stated only a calendar date; the instant is that day's local start boundary. */
  DATE_ONLY: "date_only",
  /** No usable time in the source; the instant was derived, e.g. from message arrival. */
  INFERRED: "inferred",
} as const;

export type TimePrecision = (typeof TimePrecision)[keyof typeof TimePrecision];

/**
 * buildspec.md §10: an intraday reconciliation checkpoint may not silently order a date-only event
 * against a timestamped balance. Only `EXACT` times support that comparison.
 */
export function supportsIntradayOrdering(precision: TimePrecision): boolean {
  return precision === TimePrecision.EXACT;
}

/** An instant plus everything needed to redisplay and reason about it honestly. */
export type FinancialTime = {
  readonly instant: Instant;
  readonly zone: ZoneId;
  readonly precision: TimePrecision;
};

/** buildspec.md §2: `Asia/Colombo` is the *suggested* onboarding zone, not an assumption. */
export const SUGGESTED_DEFAULT_ZONE: ZoneId = "Asia/Colombo";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const formatterCache = new Map<ZoneId, Intl.DateTimeFormat>();

function partsFormatter(zone: ZoneId): Intl.DateTimeFormat {
  let cached = formatterCache.get(zone);
  if (!cached) {
    try {
      cached = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw validationError(`Unknown timezone id '${zone}'`, { zone });
    }
    formatterCache.set(zone, cached);
  }
  return cached;
}

/** Validates an IANA zone id instead of letting an unknown one silently become UTC. */
export function requireZone(zone: string): ZoneId {
  partsFormatter(zone);
  return zone;
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function wallClockAt(instant: Instant, zone: ZoneId): WallClock {
  const parts = partsFormatter(zone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw validationError(`Zone '${zone}' produced no ${type} part`);
    return Number(found.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The UTC offset in effect at `instant` in `zone`, in milliseconds.
 *
 * buildspec.md §9.1 wants the original offset retained so that a later change to a zone's rules
 * cannot retroactively move a recorded transaction.
 */
export function zoneOffsetMs(instant: Instant, zone: ZoneId): number {
  const wall = wallClockAt(instant, zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // `instant` may carry sub-second precision that the formatter dropped.
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Formats the offset as `+05:30` for display and for storage alongside the instant. */
export function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+";
  const totalMinutes = Math.abs(Math.round(offsetMs / MS_PER_MINUTE));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The local calendar date an instant falls on, in the given zone. */
export function localDateOf(instant: Instant, zone: ZoneId): LocalDate {
  const wall = wallClockAt(instant, zone);
  return toLocalDate(wall.year, wall.month, wall.day);
}

export function toLocalDate(year: number, month: number, day: number): LocalDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseLocalDate(date: LocalDate): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw validationError(`Date must be formatted YYYY-MM-DD, got '${date}'`, { date });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) throw validationError(`Month out of range in '${date}'`, { date });
  if (day < 1 || day > daysInMonth(year, month)) {
    throw validationError(`Day out of range in '${date}'`, { date });
  }
  return { year, month, day };
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The instant at which a local calendar day begins in a zone.
 *
 * Daylight-saving transitions make this non-trivial: on a spring-forward day local midnight may not
 * exist. buildspec.md §20 requires explicit behaviour for "Month-end, leap day, daylight-saving
 * transition", so a missing midnight resolves forward to the first instant that *does* fall on the
 * requested date rather than silently landing on the previous day.
 */
export function startOfLocalDay(date: LocalDate, zone: ZoneId): Instant {
  const { year, month, day } = parseLocalDate(date);
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0);

  // Two passes converge for every real-world offset, including half-hour zones like Asia/Colombo.
  let candidate = naiveUtc - zoneOffsetMs(naiveUtc, zone);
  candidate = naiveUtc - zoneOffsetMs(candidate, zone);

  if (localDateOf(candidate, zone) === date) return candidate;

  // DST gap: walk forward in one-minute steps until the requested local date starts.
  for (let step = 1; step <= 180; step += 1) {
    const probe = candidate + step * MS_PER_MINUTE;
    if (localDateOf(probe, zone) === date) return probe;
  }
  // DST overlap in the other direction.
  for (let step = 1; step <= 180; step += 1) {
    const probe = candidate - step * MS_PER_MINUTE;
    if (localDateOf(probe, zone) === date) return probe;
  }
  throw validationError(`Could not place the start of ${date} in zone ${zone}`, { date, zone });
}

/** The exclusive end of a local day: the start of the next one. */
export function endOfLocalDayExclusive(date: LocalDate, zone: ZoneId): Instant {
  return startOfLocalDay(addDays(date, 1), zone);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = parseLocalDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return toLocalDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * Adds months, clamping to the last valid day.
 *
 * buildspec.md §11: "For '31st each month', default to the last valid day without permanently
 * drifting to the 28th." The clamp therefore always applies to the *anchor* day, not to the
 * previously generated date — which is why this takes the anchor explicitly.
 */
export function addMonthsFromAnchor(anchor: LocalDate, monthsToAdd: number): LocalDate {
  const { year, month, day } = parseLocalDate(anchor);
  const zeroBased = year * 12 + (month - 1) + monthsToAdd;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12) + 1;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return toLocalDate(targetYear, targetMonth, clampedDay);
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  const aMs = Date.UTC(a.year, a.month - 1, a.day);
  const bMs = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bMs - aMs) / MS_PER_DAY);
}

/* ------------------------------------------------------------------------------------------- */
/* FinancialTime constructors                                                                    */
/* ------------------------------------------------------------------------------------------- */

export function exactTime(instant: Instant, zone: ZoneId): FinancialTime {
  return Object.freeze({ instant, zone: requireZone(zone), precision: TimePrecision.EXACT });
}

/**
 * Encodes a date-only event as the start of that local day, flagged so that nothing downstream
 * mistakes the boundary value for a real observed time.
 */
export function dateOnlyTime(date: LocalDate, zone: ZoneId): FinancialTime {
  return Object.freeze({
    instant: startOfLocalDay(date, zone),
    zone: requireZone(zone),
    precision: TimePrecision.DATE_ONLY,
  });
}

export function inferredTime(instant: Instant, zone: ZoneId): FinancialTime {
  return Object.freeze({ instant, zone: requireZone(zone), precision: TimePrecision.INFERRED });
}

export function localDateOfFinancialTime(time: FinancialTime): LocalDate {
  return localDateOf(time.instant, time.zone);
}

/** True when both times are precise enough to be ordered against each other. */
export function canOrderStrictly(a: FinancialTime, b: FinancialTime): boolean {
  return supportsIntradayOrdering(a.precision) && supportsIntradayOrdering(b.precision);
}

export function toIso(instant: Instant): string {
  return new Date(instant).toISOString();
}

export function fromIso(text: string): Instant {
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw validationError(`Invalid ISO-8601 timestamp '${text}'`);
  return parsed;
}

/* ------------------------------------------------------------------------------------------- */
/* Clock                                                                                          */
/* ------------------------------------------------------------------------------------------- */

/**
 * buildspec.md §22: "Domain tests use an injectable clock/timezone." Nothing in the domain reads
 * `Date.now()` directly.
 */
export type Clock = {
  now(): Instant;
  zone(): ZoneId;
};

export function systemClock(zone: () => ZoneId): Clock {
  return { now: () => Date.now(), zone };
}

export type FixedClock = Clock & {
  set(instant: Instant): void;
  advanceMs(ms: number): void;
};

export function fixedClock(instant: Instant, zone: ZoneId = SUGGESTED_DEFAULT_ZONE): FixedClock {
  let current = instant;
  return {
    now: () => current,
    zone: () => zone,
    set: (next: Instant) => {
      current = next;
    },
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

export function todayIn(clock: Clock): LocalDate {
  return localDateOf(clock.now(), clock.zone());
}
