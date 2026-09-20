import type { Db } from "../data/driver.ts";
import { asBigInt, asOptionalText, asText } from "../data/driver.ts";
import type { Currency, Money } from "../domain/money.ts";
import { money } from "../domain/money.ts";
import type { LocalDate } from "../domain/time.ts";
import { addDays, daysInMonth, parseLocalDate, toLocalDate } from "../domain/time.ts";

/**
 * Read-only figures for the Home dashboard.
 *
 * Everything here is summed from journal entries on income and expense accounts, which is what
 * makes the totals honest: a transfer between the owner's accounts or a credit-card payment never
 * touches either kind of account, so it cannot appear as spending or income (buildspec.md §9.2), and
 * a refund credits the expense account, so it reduces spending instead of inflating income. A
 * deleted or history-only record is excluded the same way the Transactions list excludes it.
 *
 * One currency at a time: currencies are never added together (§9.1).
 */

export type PeriodKey = "month" | "last" | "3m" | "year";

export type Period = {
  readonly key: PeriodKey;
  readonly label: string;
  readonly from: LocalDate;
  readonly to: LocalDate;
  /** The equally long window immediately before, for "vs previous" comparisons. */
  readonly previous: { readonly from: LocalDate; readonly to: LocalDate; readonly label: string };
};

const monthStart = (date: LocalDate) => `${date.slice(0, 8)}01`;

function shiftMonths(date: LocalDate, months: number): LocalDate {
  const { year, month } = parseLocalDate(date);
  const index = year * 12 + (month - 1) + months;
  return toLocalDate(Math.floor(index / 12), (index % 12) + 1, 1);
}

function endOfMonth(firstDay: LocalDate): LocalDate {
  const { year, month } = parseLocalDate(firstDay);
  return toLocalDate(year, month, daysInMonth(year, month));
}

export function resolvePeriod(raw: string | undefined, today: LocalDate): Period {
  const key: PeriodKey = raw === "last" || raw === "3m" || raw === "year" ? raw : "month";
  const thisMonth = monthStart(today);

  if (key === "last") {
    const from = shiftMonths(thisMonth, -1);
    const before = shiftMonths(thisMonth, -2);
    return { key, label: "Last month", from, to: endOfMonth(from), previous: { from: before, to: endOfMonth(before), label: "the month before" } };
  }
  if (key === "3m") {
    const from = shiftMonths(thisMonth, -2);
    const before = shiftMonths(thisMonth, -5);
    return { key, label: "Last 3 months", from, to: today, previous: { from: before, to: addDays(from, -1), label: "the 3 months before" } };
  }
  if (key === "year") {
    const from = `${today.slice(0, 4)}-01-01`;
    const lastYear = Number(today.slice(0, 4)) - 1;
    return { key, label: "This year", from, to: today, previous: { from: `${lastYear}-01-01`, to: `${lastYear}${today.slice(4)}`, label: "the same stretch last year" } };
  }
  // Compare month-to-date with the same number of days of last month, not the whole of it:
  // "you have spent less than all of August" on the 5th of September tells the owner nothing.
  const before = shiftMonths(thisMonth, -1);
  const day = Math.min(parseLocalDate(today).day, parseLocalDate(endOfMonth(before)).day);
  return { key, label: "This month", from: thisMonth, to: today, previous: { from: before, to: `${before.slice(0, 8)}${String(day).padStart(2, "0")}`, label: "the same days last month" } };
}

const FLOW_FROM = `
  FROM journal_entries e
  JOIN journals j ON j.id = e.journal_id
  JOIN ledger_accounts a ON a.id = e.ledger_account_id
  JOIN transactions t ON t.id = j.transaction_id
  JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
 WHERE j.state = 'posted' AND t.status = 'posted' AND t.accounting_scope = 'ledger'
   AND a.currency = ? AND r.occurred_local_date BETWEEN ? AND ?`;

export function createDashboardService(deps: { db: Db }) {
  const { db } = deps;

  /** Debit-positive: spending is the sum on expense accounts, income the negated sum on income accounts. */
  function totals(currency: Currency, from: LocalDate, to: LocalDate): { income: Money; spending: Money; net: Money } {
    const rows = db.prepare(`SELECT a.kind AS kind, SUM(e.amount_minor_signed) AS total ${FLOW_FROM} AND a.kind IN ('expense','income') GROUP BY a.kind`)
      .all(currency.code, from, to) as Record<string, unknown>[];
    let income = 0n;
    let spending = 0n;
    for (const row of rows) {
      const total = row.total === null ? 0n : asBigInt(row.total, "total");
      if (asText(row.kind, "kind") === "income") income = -total;
      else spending = total;
    }
    return { income: money(currency, income), spending: money(currency, spending), net: money(currency, income - spending) };
  }

  function byCategory(currency: Currency, from: LocalDate, to: LocalDate, kind: "expense" | "income") {
    const rows = db.prepare(
      `SELECT e.category_id AS category_id, SUM(e.amount_minor_signed) AS total ${FLOW_FROM} AND a.kind = ?
        GROUP BY e.category_id HAVING SUM(e.amount_minor_signed) <> 0`,
    ).all(currency.code, from, to, kind) as Record<string, unknown>[];
    return rows
      .map((row) => {
        const total = asBigInt(row.total, "total");
        return { categoryId: asOptionalText(row.category_id, "category_id") ?? "uncategorized", amount: money(currency, kind === "income" ? -total : total) };
      })
      .sort((a, b) => (a.amount.minor < b.amount.minor ? 1 : a.amount.minor > b.amount.minor ? -1 : 0));
  }

  /** Income and spending for each of the last `months` calendar months, oldest first, gaps filled. */
  function monthlyFlow(currency: Currency, today: LocalDate, months: number) {
    const first = shiftMonths(monthStart(today), -(months - 1));
    const rows = db.prepare(
      `SELECT substr(r.occurred_local_date, 1, 7) AS ym, a.kind AS kind, SUM(e.amount_minor_signed) AS total
       ${FLOW_FROM} AND a.kind IN ('expense','income') GROUP BY ym, a.kind`,
    ).all(currency.code, first, today) as Record<string, unknown>[];
    const found = new Map<string, { income: bigint; spending: bigint }>();
    for (const row of rows) {
      const ym = asText(row.ym, "ym");
      const slot = found.get(ym) ?? { income: 0n, spending: 0n };
      const total = asBigInt(row.total, "total");
      if (asText(row.kind, "kind") === "income") slot.income = -total;
      else slot.spending = total;
      found.set(ym, slot);
    }
    return Array.from({ length: months }, (_, index) => {
      const start = shiftMonths(first, index);
      const slot = found.get(start.slice(0, 7)) ?? { income: 0n, spending: 0n };
      return { month: start.slice(0, 7), income: money(currency, slot.income), spending: money(currency, slot.spending) };
    });
  }

  /** Spending per local day across the window, every day present, for a cumulative line. */
  function dailySpending(currency: Currency, from: LocalDate, to: LocalDate) {
    const rows = db.prepare(`SELECT r.occurred_local_date AS day, SUM(e.amount_minor_signed) AS total ${FLOW_FROM} AND a.kind = 'expense' GROUP BY day`)
      .all(currency.code, from, to) as Record<string, unknown>[];
    const found = new Map(rows.map((row) => [asText(row.day, "day"), asBigInt(row.total, "total")]));
    const days: { day: LocalDate; amount: Money }[] = [];
    for (let day = from; day <= to && days.length < 400; day = addDays(day, 1)) {
      days.push({ day, amount: money(currency, found.get(day) ?? 0n) });
    }
    return days;
  }

  function topMerchants(currency: Currency, from: LocalDate, to: LocalDate, limit = 5) {
    const rows = db.prepare(
      `SELECT r.merchant_name AS merchant, SUM(e.amount_minor_signed) AS total, COUNT(DISTINCT t.id) AS times
       ${FLOW_FROM} AND a.kind = 'expense' AND r.merchant_name IS NOT NULL AND r.merchant_name <> ''
        GROUP BY lower(r.merchant_name) HAVING SUM(e.amount_minor_signed) > 0 ORDER BY total DESC LIMIT ?`,
    ).all(currency.code, from, to, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      merchant: asText(row.merchant, "merchant"),
      amount: money(currency, asBigInt(row.total, "total")),
      times: Number(row.times),
    }));
  }

  /** Which currencies have any income or spending at all, so Home can say when it is showing one of several. */
  function activeCurrencies(): string[] {
    return (db.prepare("SELECT DISTINCT currency FROM ledger_accounts WHERE kind IN ('expense','income')").all() as Record<string, unknown>[])
      .map((row) => asText(row.currency, "currency"));
  }

  return { totals, byCategory, monthlyFlow, dailySpending, topMerchants, activeCurrencies };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
