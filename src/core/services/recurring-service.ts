import { randomUUID } from "node:crypto";

import type { Db } from "../data/driver.ts";
import { asBigInt, asNumber, asOptionalText, asText } from "../data/driver.ts";
import { notFound, validationError } from "../domain/errors.ts";
import { AccountKind } from "../domain/ledger.ts";
import type { Currency, Money } from "../domain/money.ts";
import { money, requireCurrency } from "../domain/money.ts";
import type { LocalDate } from "../domain/time.ts";
import { addDays, daysBetween, daysInMonth, parseLocalDate, toLocalDate } from "../domain/time.ts";
import type { FinanceService } from "./finance-service.ts";

/**
 * Money that comes and goes every month: rent, broadband, a subscription, a salary.
 *
 * buildspec.md §11 asks for "recurrence detection and owner-approved plans". Detection here only
 * ever *suggests*: it reads the ledger for a merchant or payer that turns up about once a month for
 * about the same amount. A row exists in `recurring_items` only because the owner added it.
 *
 * Nothing in this file posts a transaction. Whether this month's bill is paid is answered by
 * looking for a posted record that matches it — by its merchant or payer name, or, for an item
 * with no name to match, by its category and an amount within 15%.
 */

export type RecurringDirection = "out" | "in";
export type RecurringState = "paid" | "upcoming" | "overdue";

export type RecurringItem = {
  readonly id: string;
  readonly name: string;
  readonly direction: RecurringDirection;
  readonly amount: Money;
  readonly dueDay: number;
  readonly accountId: string | null;
  readonly categoryId: string | null;
  readonly matchText: string | null;
};

export type RecurringRow = RecurringItem & {
  readonly state: RecurringState;
  /** The date this month's occurrence falls on (clamped: "the 31st" in a 30-day month is the 30th). */
  readonly dueThisMonth: LocalDate;
  /** The next date it is expected: this month's if not yet paid, otherwise next month's. */
  readonly nextDue: LocalDate;
  /** Negative once overdue. */
  readonly daysUntil: number;
  readonly lastPaid: { readonly date: LocalDate; readonly amount: Money; readonly transactionId: string } | null;
};

export type RecurringSuggestion = {
  readonly key: string;
  readonly name: string;
  readonly direction: RecurringDirection;
  /** The median of what was paid. */
  readonly amount: Money;
  readonly dueDay: number;
  readonly accountId: string | null;
  readonly categoryId: string | null;
  readonly months: number;
  readonly lastDate: LocalDate;
};

export type Occurrence = {
  readonly itemId: string;
  readonly name: string;
  readonly direction: RecurringDirection;
  readonly date: LocalDate;
  readonly amount: Money;
};

export type LedgerRow = {
  id: string;
  kind: "expense" | "income";
  day: LocalDate;
  merchant: string | null;
  categoryId: string | null;
  amount: bigint;
  accountId: string | null;
};

const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/** Whether a posted record is a payment of this item: by name when it has one, else category and amount. */
export function matchesItem(item: RecurringItem, row: { kind: string; merchant: string | null; categoryId: string | null; amount: bigint }): boolean {
  if (row.kind !== (item.direction === "in" ? "income" : "expense")) return false;
  if (item.matchText) return row.merchant !== null && normalise(row.merchant).includes(item.matchText);
  if (!item.categoryId || row.categoryId !== item.categoryId) return false;
  const low = (item.amount.minor * 85n) / 100n;
  const high = (item.amount.minor * 115n) / 100n;
  return row.amount >= low && row.amount <= high;
}

/** The due day in a given month, clamped to that month's length. */
export function dueDateIn(year: number, month: number, dueDay: number): LocalDate {
  return toLocalDate(year, month, Math.min(dueDay, daysInMonth(year, month)));
}

function monthAfter(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function medianBig(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2n;
}

export function createRecurringService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;

  function ledgerRows(currency: Currency, from: LocalDate, to: LocalDate): LedgerRow[] {
    return (
      db
        .prepare(
          `SELECT t.id, t.kind, r.occurred_local_date AS day, r.merchant_name, r.category_id, r.display_amount_minor AS amount,
                  (SELECT e.ledger_account_id FROM journal_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id
                    WHERE e.journal_id = r.journal_id AND a.is_user_visible = 1 LIMIT 1) AS account_id
             FROM transactions t
             JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
            WHERE t.status = 'posted' AND t.accounting_scope = 'ledger' AND t.kind IN ('expense','income')
              AND r.currency = ? AND r.occurred_local_date BETWEEN ? AND ?
            ORDER BY r.occurred_local_date DESC, t.created_at DESC`,
        )
        .all(currency.code, from, to) as Record<string, unknown>[]
    ).map((row) => ({
      id: asText(row.id, "id"),
      kind: asText(row.kind, "kind") === "income" ? "income" : "expense",
      day: asText(row.day, "day"),
      merchant: asOptionalText(row.merchant_name, "merchant_name") ?? null,
      categoryId: asOptionalText(row.category_id, "category_id") ?? null,
      amount: asBigInt(row.amount, "amount"),
      accountId: asOptionalText(row.account_id, "account_id") ?? null,
    }));
  }

  function toItem(row: Record<string, unknown>): RecurringItem {
    return {
      id: asText(row.id, "id"),
      name: asText(row.name, "name"),
      direction: asText(row.direction, "direction") === "in" ? "in" : "out",
      amount: money(requireCurrency(asText(row.currency, "currency")), asBigInt(row.amount_minor, "amount_minor")),
      dueDay: asNumber(row.due_day, "due_day"),
      accountId: asOptionalText(row.account_id, "account_id") ?? null,
      categoryId: asOptionalText(row.category_id, "category_id") ?? null,
      matchText: asOptionalText(row.match_text, "match_text") ?? null,
    };
  }

  function items(): RecurringItem[] {
    return (db.prepare("SELECT * FROM recurring_items WHERE archived_at IS NULL ORDER BY due_day, name").all() as Record<string, unknown>[]).map(toItem);
  }

  function list(today: LocalDate): RecurringRow[] {
    const { year, month } = parseLocalDate(today);
    const monthStart = toLocalDate(year, month, 1);
    const monthEnd = toLocalDate(year, month, daysInMonth(year, month));
    const next = monthAfter(year, month);
    const history = new Map<string, LedgerRow[]>();
    const rowsFor = (currency: Currency) => {
      if (!history.has(currency.code)) history.set(currency.code, ledgerRows(currency, addDays(today, -400), monthEnd));
      return history.get(currency.code)!;
    };

    return items()
      .map((item): RecurringRow => {
        const found = rowsFor(item.amount.currency).filter((row) => matchesItem(item, row));
        const last = found[0];
        const dueThisMonth = dueDateIn(year, month, item.dueDay);
        const paid = found.some((row) => row.day >= monthStart && row.day <= monthEnd);
        const nextDue = paid ? dueDateIn(next.year, next.month, item.dueDay) : dueThisMonth;
        const state: RecurringState = paid ? "paid" : today > dueThisMonth ? "overdue" : "upcoming";
        return {
          ...item,
          state,
          dueThisMonth,
          nextDue,
          daysUntil: daysBetween(today, nextDue),
          lastPaid: last ? { date: last.day, amount: money(item.amount.currency, last.amount), transactionId: last.id } : null,
        };
      })
      .sort((a, b) => (a.state === "paid" ? 1 : 0) - (b.state === "paid" ? 1 : 0) || a.nextDue.localeCompare(b.nextDue) || a.name.localeCompare(b.name));
  }

  /** Every expected occurrence from today to `until`, this month's skipped once it has been paid. */
  function occurrences(currency: Currency, today: LocalDate, until: LocalDate): Occurrence[] {
    const out: Occurrence[] = [];
    for (const row of list(today)) {
      if (row.amount.currency.code !== currency.code) continue;
      let { year, month } = parseLocalDate(row.state === "paid" ? row.nextDue : row.dueThisMonth);
      for (let guard = 0; guard < 24; guard += 1) {
        // An overdue item is still expected: it is counted as due today rather than in the past.
        const raw = dueDateIn(year, month, row.dueDay);
        const date = raw < today ? today : raw;
        if (date > until) break;
        out.push({ itemId: row.id, name: row.name, direction: row.direction, date, amount: row.amount });
        ({ year, month } = monthAfter(year, month));
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  function validate(input: { name: string; direction: RecurringDirection; amount: Money; dueDay: number; accountId?: string | null | undefined; categoryId?: string | null | undefined }) {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (name.length === 0) throw validationError("Give it a name, such as “Rent” or “Salary”.");
    if (name.length > 60) throw validationError("Keep the name under 60 characters.");
    if (input.direction !== "out" && input.direction !== "in") throw validationError("Choose whether money goes out or comes in.");
    if (input.amount.minor <= 0n) throw validationError("Enter an amount greater than zero.");
    if (!Number.isInteger(input.dueDay) || input.dueDay < 1 || input.dueDay > 31) throw validationError("The day must be between 1 and 31.");
    if (input.accountId) {
      const account = service.findAccount(input.accountId);
      if (!account || !account.isUserVisible) throw validationError("Choose one of your accounts.");
      if (account.currency.code !== input.amount.currency.code) throw validationError(`That account holds ${account.currency.code}, not ${input.amount.currency.code}.`);
      if (input.direction === "in" && account.kind !== AccountKind.ASSET) throw validationError("Income arrives in a bank, cash or wallet account.");
    }
    if (input.categoryId && !service.listCategories(true).some((c) => c.id === input.categoryId)) throw validationError("Choose a category.");
    return name;
  }

  function create(input: {
    name: string;
    direction: RecurringDirection;
    amount: Money;
    dueDay: number;
    accountId?: string | null | undefined;
    categoryId?: string | null | undefined;
    matchText?: string | null | undefined;
  }): RecurringItem {
    const name = validate(input);
    const id = `rec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const at = service.clock.now();
    const match = input.matchText === undefined ? normalise(name) : input.matchText ? normalise(input.matchText) : null;
    db.prepare(
      `INSERT INTO recurring_items (id, name, direction, amount_minor, currency, due_day, account_id, category_id, match_text, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, name, input.direction, input.amount.minor, input.amount.currency.code, input.dueDay, input.accountId ?? null, input.categoryId ?? null, match, at, at);
    return find(id)!;
  }

  function find(id: string): RecurringItem | undefined {
    const row = db.prepare("SELECT * FROM recurring_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toItem(row) : undefined;
  }

  function update(input: {
    id: string;
    name: string;
    direction: RecurringDirection;
    amount: Money;
    dueDay: number;
    accountId?: string | null | undefined;
    categoryId?: string | null | undefined;
    matchText?: string | null | undefined;
  }): RecurringItem {
    const existing = find(input.id);
    if (!existing) throw notFound("Recurring item", input.id);
    const name = validate(input);
    const match = input.matchText === undefined ? existing.matchText : input.matchText ? normalise(input.matchText) : null;
    db.prepare(
      `UPDATE recurring_items SET name = ?, direction = ?, amount_minor = ?, currency = ?, due_day = ?, account_id = ?, category_id = ?,
              match_text = ?, updated_at = ? WHERE id = ?`,
    ).run(name, input.direction, input.amount.minor, input.amount.currency.code, input.dueDay, input.accountId ?? null, input.categoryId ?? null, match, service.clock.now(), input.id);
    return find(input.id)!;
  }

  function archive(id: string): void {
    if (!find(id)) throw notFound("Recurring item", id);
    db.prepare("UPDATE recurring_items SET archived_at = ?, updated_at = ? WHERE id = ?").run(service.clock.now(), service.clock.now(), id);
  }

  /**
   * Merchants and payers that look monthly: seen in at least two different months of the last six,
   * no more than about once a month, for amounts within 30% of each other. Anything already tracked
   * is left out, so accepting a suggestion makes it disappear.
   */
  function detect(currency: Currency, today: LocalDate): RecurringSuggestion[] {
    const { year, month } = parseLocalDate(today);
    const startIndex = year * 12 + (month - 1) - 6;
    const from = toLocalDate(Math.floor(startIndex / 12), (startIndex % 12) + 1, 1);
    const tracked = items().map((item) => item.matchText ?? normalise(item.name));
    const groups = new Map<string, LedgerRow[]>();
    for (const row of ledgerRows(currency, from, today)) {
      if (!row.merchant || normalise(row.merchant).length < 2) continue;
      const key = `${row.kind}:${normalise(row.merchant)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const suggestions: RecurringSuggestion[] = [];
    for (const [key, rows] of groups) {
      const months = new Set(rows.map((row) => row.day.slice(0, 7)));
      if (months.size < 2 || rows.length > months.size * 1.5) continue;
      const amounts = rows.map((row) => row.amount);
      const low = amounts.reduce((a, b) => (b < a ? b : a));
      const high = amounts.reduce((a, b) => (b > a ? b : a));
      if (low <= 0n || high * 10n > low * 13n) continue;
      const name = normalise(rows[0]!.merchant!);
      if (tracked.some((text) => text.length > 0 && (name.includes(text) || text.includes(name)))) continue;
      const latest = rows[0]!;
      suggestions.push({
        key,
        name: latest.merchant!.trim(),
        direction: latest.kind === "income" ? "in" : "out",
        amount: money(currency, medianBig(amounts)),
        dueDay: median(rows.map((row) => parseLocalDate(row.day).day)),
        accountId: latest.accountId,
        categoryId: latest.categoryId,
        months: months.size,
        lastDate: latest.day,
      });
    }
    return suggestions.sort((a, b) => b.months - a.months || Number(b.amount.minor - a.amount.minor));
  }

  return { list, items, find, occurrences, create, update, archive, detect, ledgerRows };
}

export type RecurringService = ReturnType<typeof createRecurringService>;
