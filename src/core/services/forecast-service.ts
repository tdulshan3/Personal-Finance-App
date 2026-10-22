import type { Db } from "../data/driver.ts";
import { asOptionalText } from "../data/driver.ts";
import { validationError } from "../domain/errors.ts";
import { AccountKind, AccountType, LiquidityRole } from "../domain/ledger.ts";
import type { Currency, Money } from "../domain/money.ts";
import { money } from "../domain/money.ts";
import type { LocalDate } from "../domain/time.ts";
import { addDays, daysBetween, daysInMonth, localDateOf, parseLocalDate, toLocalDate } from "../domain/time.ts";
import { createCardDueService } from "./card-dues.ts";
import { createDashboardService } from "./dashboard-service.ts";
import type { FinanceService } from "./finance-service.ts";
import { createRecurringService, matchesItem } from "./recurring-service.ts";

/**
 * The Plan screen's cash-flow projection (buildspec.md §12, M5).
 *
 * It answers one question: how much spendable money will there be on each day from now to the end
 * of next month? Every input is something the ledger or the owner already said:
 *
 *   - the start is the recorded balance of the liquid accounts (bank, cash, wallet) — never a
 *     savings account, never a credit limit (§12);
 *   - the bills and income the owner saved on Bills, on the days they fall due;
 *   - each card's payment, on its due day, for what is on the card today;
 *   - and everything else as an average day of spending, taken from up to 90 days of history with
 *     the recognised bill payments left out so they are not counted twice.
 *
 * The conservative line spends a quarter more a day, and the amount it suggests setting aside is read
 * from that line, not the expected one. Both are planning ranges, not promises, and
 * the screen says so; with little history the result is labelled low confidence rather than
 * presented as an answer.
 */

export type ForecastPoint = { readonly date: LocalDate; readonly base: bigint; readonly conservative: bigint };

export type ForecastEvent = {
  readonly date: LocalDate;
  readonly label: string;
  /** Signed: money out is negative. */
  readonly amount: Money;
  readonly kind: "bill" | "income" | "card";
};

export type Forecast = {
  readonly currency: Currency;
  readonly today: LocalDate;
  readonly until: LocalDate;
  readonly start: Money;
  readonly buffer: Money;
  readonly dailySpend: Money;
  readonly historyDays: number;
  readonly confidence: "low" | "medium" | "good";
  readonly points: readonly ForecastPoint[];
  readonly events: readonly ForecastEvent[];
  readonly lowest: { readonly base: { date: LocalDate; amount: Money }; readonly conservative: { date: LocalDate; amount: Money } };
  readonly monthEnd: { readonly date: LocalDate; readonly base: Money; readonly conservative: Money };
  /**
   * What could be moved to savings today and still stay above the buffer all the way — judged on the
   * cautious line, because a savings suggestion that holds only if spending behaves is not one.
   */
  readonly canSetAside: Money;
  /** The first day the conservative line goes under the buffer, if it does. */
  readonly belowBufferOn: LocalDate | null;
  /** Things the projection could not include, in plain words. */
  readonly notes: readonly string[];
};

const HISTORY_DAYS = 90;
const CONSERVATIVE_PERCENT = 125n;
const bufferKey = (currency: Currency) => `plan.buffer.${currency.code}`;

export function createForecastService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;
  const dashboard = createDashboardService({ db });
  const recurring = createRecurringService({ db, service });
  const cards = createCardDueService({ db, service });

  function buffer(currency: Currency): Money {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(bufferKey(currency)) as Record<string, unknown> | undefined;
    if (!row) return money(currency, 0n);
    try {
      const value = JSON.parse(String(row.value_json)) as unknown;
      return money(currency, typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n);
    } catch {
      return money(currency, 0n);
    }
  }

  function setBuffer(amount: Money): void {
    if (amount.minor < 0n) throw validationError("The buffer can't be negative.");
    db.prepare(
      `INSERT INTO settings (key, value_json, revision, updated_at) VALUES (?,?,1,?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, revision = settings.revision + 1, updated_at = excluded.updated_at`,
    ).run(bufferKey(amount.currency), JSON.stringify(amount.minor.toString()), service.clock.now());
  }

  /** Days of recorded history the average can lean on, up to 90. */
  function historyDays(currency: Currency, today: LocalDate): number {
    const row = db
      .prepare(
        `SELECT MIN(r.occurred_local_date) AS first FROM transactions t
           JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
          WHERE t.status = 'posted' AND t.accounting_scope = 'ledger' AND t.kind IN ('expense','income') AND r.currency = ?`,
      )
      .get(currency.code) as Record<string, unknown> | undefined;
    const first = row ? asOptionalText(row.first, "first") : undefined;
    if (!first) return 0;
    return Math.min(HISTORY_DAYS, Math.max(1, daysBetween(first, today) + 1));
  }

  function project(currency: Currency, today: LocalDate): Forecast {
    const notes: string[] = [];
    const { year, month } = parseLocalDate(today);
    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    const monthEnd = toLocalDate(year, month, daysInMonth(year, month));
    const until = toLocalDate(next.year, next.month, daysInMonth(next.year, next.month));

    const balances = service.accountBalances().filter(({ account }) => account.isUserVisible && account.currency.code === currency.code);
    const startMinor = balances
      .filter(({ account }) => account.kind === AccountKind.ASSET && account.liquidityRole === LiquidityRole.LIQUID)
      .reduce((sum, { balance }) => sum + balance.minor, 0n);

    // An average day, from history, with the payments of saved bills taken out.
    const days = historyDays(currency, today);
    let dailyMinor = 0n;
    if (days > 0) {
      const from = addDays(today, -(days - 1));
      const spent = dashboard.totals(currency, from, today).spending.minor;
      const bills = recurring.items().filter((item) => item.direction === "out" && item.amount.currency.code === currency.code);
      const recognised = recurring
        .ledgerRows(currency, from, today)
        .filter((row) => bills.some((item) => matchesItem(item, row)))
        .reduce((sum, row) => sum + row.amount, 0n);
      const everyday = spent - recognised;
      dailyMinor = everyday > 0n ? everyday / BigInt(days) : 0n;
    }

    const liquidIds = new Set(balances.filter(({ account }) => account.liquidityRole === LiquidityRole.LIQUID).map(({ account }) => account.id));
    const events: ForecastEvent[] = [];
    for (const occurrence of recurring.occurrences(currency, today, until)) {
      const item = recurring.find(occurrence.itemId);
      // A bill charged to a card reaches cash through the card's payment, not on its own day.
      if (item?.accountId && !liquidIds.has(item.accountId) && service.findAccount(item.accountId)?.kind === AccountKind.LIABILITY) continue;
      events.push({
        date: occurrence.date,
        label: occurrence.name,
        amount: money(currency, occurrence.direction === "in" ? occurrence.amount.minor : -occurrence.amount.minor),
        kind: occurrence.direction === "in" ? "income" : "bill",
      });
    }
    for (const due of cards.list(today)) {
      if (due.account.currency.code !== currency.code || due.owed.minor <= 0n || due.account.type === AccountType.LOAN) continue;
      if (!due.dueOn) {
        notes.push(`${due.account.name} has no payment due day, so what is on it is not in the projection. Set the day on Bills.`);
        continue;
      }
      if (due.dueOn > until) continue;
      events.push({ date: due.dueOn, label: `${due.account.name} payment`, amount: money(currency, -due.owed.minor), kind: "card" });
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || Number(a.amount.minor - b.amount.minor));

    const points: ForecastPoint[] = [];
    let base = startMinor;
    let conservative = startMinor;
    const conservativeDaily = (dailyMinor * CONSERVATIVE_PERCENT) / 100n;
    for (let day = today, index = 0; day <= until; day = addDays(day, 1), index += 1) {
      if (index > 0) {
        base -= dailyMinor;
        conservative -= conservativeDaily;
      }
      for (const event of events) {
        if (event.date === day) {
          base += event.amount.minor;
          conservative += event.amount.minor;
        }
      }
      points.push({ date: day, base, conservative });
    }

    const lowestOf = (pick: (p: ForecastPoint) => bigint) =>
      points.reduce((low, point) => (pick(point) < pick(low) ? point : low), points[0]!);
    const lowBase = lowestOf((p) => p.base);
    const lowConservative = lowestOf((p) => p.conservative);
    const atMonthEnd = points.find((p) => p.date === monthEnd) ?? points[points.length - 1]!;
    const bufferMinor = buffer(currency).minor;
    const spare = lowConservative.conservative - bufferMinor;

    if (balances.every(({ account }) => account.liquidityRole !== LiquidityRole.LIQUID)) {
      notes.push("There is no bank, cash or wallet account in this currency, so the projection starts from zero.");
    }

    return {
      currency,
      today,
      until,
      start: money(currency, startMinor),
      buffer: money(currency, bufferMinor),
      dailySpend: money(currency, dailyMinor),
      historyDays: days,
      confidence: days < 14 ? "low" : days < 60 ? "medium" : "good",
      points,
      events,
      lowest: {
        base: { date: lowBase.date, amount: money(currency, lowBase.base) },
        conservative: { date: lowConservative.date, amount: money(currency, lowConservative.conservative) },
      },
      monthEnd: { date: atMonthEnd.date, base: money(currency, atMonthEnd.base), conservative: money(currency, atMonthEnd.conservative) },
      canSetAside: money(currency, spare > 0n ? spare : 0n),
      belowBufferOn: points.find((p) => p.conservative < bufferMinor)?.date ?? null,
      notes,
    };
  }

  return { project, buffer, setBuffer, historyDays };
}

export type ForecastService = ReturnType<typeof createForecastService>;

/** Today in the service's own zone. */
export function todayFor(service: FinanceService): LocalDate {
  return localDateOf(service.clock.now(), service.zone);
}
