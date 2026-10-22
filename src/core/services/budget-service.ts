import type { Db } from "../data/driver.ts";
import { asBigInt, asText } from "../data/driver.ts";
import { validationError } from "../domain/errors.ts";
import type { Currency, Money } from "../domain/money.ts";
import { money } from "../domain/money.ts";
import type { LocalDate } from "../domain/time.ts";
import { daysInMonth, parseLocalDate, toLocalDate } from "../domain/time.ts";
import { createDashboardService } from "./dashboard-service.ts";
import type { FinanceService } from "./finance-service.ts";

/**
 * Monthly budgets: a limit per spending category, compared with what the ledger says was spent.
 *
 * Spending comes from `dashboard-service`, so it follows the same rules as Home: a transfer or a
 * card payment is never spending, a refund takes spending back out of its category, and a record in
 * Trash counts for nothing. A budget is planning only — setting one moves no money and changes no
 * balance.
 */

export type BudgetStatus = "under" | "near" | "over";

export type BudgetRow = {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly limit: Money;
  readonly spent: Money;
  /** Negative once the limit is passed. */
  readonly remaining: Money;
  /** spent ÷ limit; 1 is exactly on the limit. */
  readonly ratio: number;
  /** Where the month ends if spending carries on at this month's daily pace. */
  readonly projected: Money;
  readonly status: BudgetStatus;
};

export type BudgetSuggestion = {
  readonly categoryId: string;
  readonly categoryName: string;
  /** Average monthly spending over the last three complete months. */
  readonly average: Money;
  /** The average rounded up to two significant figures: a limit that is easy to remember. */
  readonly suggested: Money;
};

export function monthBounds(today: LocalDate): { from: LocalDate; to: LocalDate; day: number; days: number } {
  const { year, month, day } = parseLocalDate(today);
  const days = daysInMonth(year, month);
  return { from: toLocalDate(year, month, 1), to: toLocalDate(year, month, days), day, days };
}

function shiftMonth(date: LocalDate, by: number): { year: number; month: number } {
  const { year, month } = parseLocalDate(date);
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Two significant figures, rounded up: 23,456.78 → 24,000; 1,240 → 1,300; 85 → 85. */
export function roundUpForBudget(currency: Currency, minor: bigint): bigint {
  if (minor <= 0n) return 0n;
  const unit = 10n ** BigInt(currency.minorUnitDigits);
  const major = (minor + unit - 1n) / unit;
  const digits = major.toString().length;
  const step = digits <= 2 ? 1n : 10n ** BigInt(digits - 2);
  return ((major + step - 1n) / step) * step * unit;
}

export function createBudgetService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;
  const dashboard = createDashboardService({ db });

  function limits(currency: Currency): Map<string, bigint> {
    return new Map(
      (db.prepare("SELECT category_id, amount_minor FROM category_budgets WHERE currency = ?").all(currency.code) as Record<string, unknown>[]).map(
        (row) => [asText(row.category_id, "category_id"), asBigInt(row.amount_minor, "amount_minor")],
      ),
    );
  }

  function names(): Map<string, string> {
    return new Map(service.listCategories(true).map((category) => [category.id, category.name]));
  }

  function list(currency: Currency, today: LocalDate): BudgetRow[] {
    const month = monthBounds(today);
    const spentBy = new Map(dashboard.byCategory(currency, month.from, month.to, "expense").map((row) => [row.categoryId, row.amount.minor]));
    const nameOf = names();
    return [...limits(currency)]
      .map(([categoryId, limitMinor]): BudgetRow => {
        const spentMinor = spentBy.get(categoryId) ?? 0n;
        const projectedMinor = (spentMinor * BigInt(month.days)) / BigInt(Math.max(month.day, 1));
        const ratio = Number(spentMinor) / Number(limitMinor);
        return {
          categoryId,
          categoryName: nameOf.get(categoryId) ?? categoryId,
          limit: money(currency, limitMinor),
          spent: money(currency, spentMinor),
          remaining: money(currency, limitMinor - spentMinor),
          ratio,
          projected: money(currency, projectedMinor),
          status: spentMinor > limitMinor ? "over" : ratio >= 0.8 || projectedMinor > limitMinor ? "near" : "under",
        };
      })
      .sort((a, b) => b.ratio - a.ratio || a.categoryName.localeCompare(b.categoryName));
  }

  /** The whole month at a glance: every limit added up, against everything spent in those categories. */
  function summary(currency: Currency, today: LocalDate) {
    const rows = list(currency, today);
    const limit = rows.reduce((sum, row) => sum + row.limit.minor, 0n);
    const spent = rows.reduce((sum, row) => sum + row.spent.minor, 0n);
    return { count: rows.length, limit: money(currency, limit), spent: money(currency, spent), over: rows.filter((row) => row.status === "over").length };
  }

  function set(categoryId: string, amount: Money | null): void {
    const category = service.listCategories(false).find((c) => c.id === categoryId);
    if (!category) throw validationError("Choose a category that is in use.");
    if (category.kind !== "expense") throw validationError("Budgets are for spending categories.");
    if (amount === null) {
      db.prepare("DELETE FROM category_budgets WHERE category_id = ?").run(categoryId);
      return;
    }
    if (amount.minor <= 0n) throw validationError("A budget needs an amount greater than zero.");
    db.prepare(
      `INSERT INTO category_budgets (category_id, currency, amount_minor, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(category_id, currency) DO UPDATE SET amount_minor = excluded.amount_minor, updated_at = excluded.updated_at`,
    ).run(categoryId, amount.currency.code, amount.minor, service.clock.now());
  }

  /** Spending categories without a budget yet, with a limit drawn from what was actually spent. */
  function suggestions(currency: Currency, today: LocalDate): BudgetSuggestion[] {
    const start = shiftMonth(today, -3);
    const end = shiftMonth(today, -1);
    const from = toLocalDate(start.year, start.month, 1);
    const to = toLocalDate(end.year, end.month, daysInMonth(end.year, end.month));
    const existing = limits(currency);
    const active = new Map(service.listCategories(false).filter((c) => c.kind === "expense").map((c) => [c.id, c.name]));
    return dashboard
      .byCategory(currency, from, to, "expense")
      .filter((row) => active.has(row.categoryId) && !existing.has(row.categoryId) && row.categoryId !== "uncategorized" && row.amount.minor > 0n)
      .map((row) => {
        const average = row.amount.minor / 3n;
        return {
          categoryId: row.categoryId,
          categoryName: active.get(row.categoryId)!,
          average: money(currency, average),
          suggested: money(currency, roundUpForBudget(currency, average)),
        };
      })
      .filter((row) => row.suggested.minor > 0n);
  }

  return { list, summary, set, suggestions };
}

export type BudgetService = ReturnType<typeof createBudgetService>;
