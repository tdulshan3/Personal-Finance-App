import type { Db } from "../core/data/driver.ts";
import { asBigInt, asNumber, asOptionalText, asText } from "../core/data/driver.ts";
import type { Currency, Money } from "../core/domain/money.ts";
import { findCurrency, formatMoney, money, requireCurrency } from "../core/domain/money.ts";
import type { LocalDate } from "../core/domain/time.ts";
import { addDays, addMonthsFromAnchor, daysBetween, daysInMonth, localDateOf, parseLocalDate, toLocalDate } from "../core/domain/time.ts";
import { createDashboardService } from "../core/services/dashboard-service.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import { accountNamesFor } from "../app/transactions/ledger-rows.ts";

/**
 * Shared expense reporting and pending-capture checks for both the model's tools and the
 * rules-first intent router.
 *
 * Ledger spending totals come from `spendingByCategory` and `dashboard-service` (transfers and
 * card payments excluded). Transactions imported as `history_only` (before an account's tracking
 * start) and unreviewed bank messages (`needs_review`) are reported separately so a period report
 * never silently omits them or mixes them into live ledger balances.
 */

const clip = (text: string | undefined | null, max = 80): string | null =>
  text ? (text.length > max ? `${text.slice(0, max)}…` : text) : null;

export function formatCurrencyMap(map: ReadonlyMap<string, Money>, empty = "0"): string {
  return map.size === 0 ? empty : [...map.values()].map((m) => formatMoney(m)).join(" + ");
}

function addMinor(map: Map<string, Money>, currency: Currency, delta: bigint): void {
  const prev = map.get(currency.code);
  map.set(currency.code, money(currency, (prev?.minor ?? 0n) + delta));
}

export function previousRange(from: LocalDate, to: LocalDate): { from: LocalDate; to: LocalDate } {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (start.day === 1 && start.year === end.year && start.month === end.month) {
    const prevFirst = addMonthsFromAnchor(from, -1);
    const prevParsed = parseLocalDate(prevFirst);
    const monthDays = daysInMonth(start.year, start.month);
    const prevMonthDays = daysInMonth(prevParsed.year, prevParsed.month);
    const prevDay = end.day === monthDays ? prevMonthDays : Math.min(end.day, prevMonthDays);
    return { from: prevFirst, to: toLocalDate(prevParsed.year, prevParsed.month, prevDay) };
  }
  const span = Math.max(0, daysBetween(from, to));
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -span), to: prevTo };
}

export function createExpenseReporter(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;
  const categoryNames = () => new Map(service.listCategories(true).map((c) => [c.id, c.name]));

  function historyOnlyExpenses(from: LocalDate, to: LocalDate) {
    const rows = db
      .prepare(
        `SELECT t.kind AS kind, r.category_id AS category_id, r.currency AS currency,
                SUM(r.display_amount_minor) AS total_minor, COUNT(*) AS n
           FROM transactions t
           JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
          WHERE t.status = 'posted'
            AND t.accounting_scope = 'history_only'
            AND t.kind IN ('expense', 'refund')
            AND r.occurred_local_date BETWEEN ? AND ?
          GROUP BY t.kind, r.category_id, r.currency`,
      )
      .all(from, to) as Record<string, unknown>[];

    let count = 0;
    const totals = new Map<string, Money>();
    const byCategoryMap = new Map<string, Money>();
    const names = categoryNames();

    for (const row of rows) {
      const kind = asText(row.kind, "kind");
      const cur = requireCurrency(asText(row.currency, "currency"));
      const raw = asBigInt(row.total_minor, "total_minor");
      const signed = kind === "refund" ? -raw : raw;
      const catId = asOptionalText(row.category_id, "category_id") ?? "uncategorized";
      count += asNumber(row.n, "n");
      addMinor(totals, cur, signed);
      const catKey = `${catId}\u0000${cur.code}`;
      const prev = byCategoryMap.get(catKey);
      byCategoryMap.set(catKey, money(cur, (prev?.minor ?? 0n) + signed));
    }

    const byCategory = [...byCategoryMap.entries()]
      .filter(([, amount]) => amount.minor !== 0n)
      .sort(([, a], [, b]) => (b.minor > a.minor ? 1 : b.minor < a.minor ? -1 : 0))
      .map(([key, amount]) => {
        const catId = key.split("\u0000")[0]!;
        return { category: names.get(catId) ?? catId, amount: formatMoney(amount) };
      });

    return {
      count,
      total: formatCurrencyMap(totals),
      by_category: byCategory,
    };
  }

  function pendingReviewItems(from?: LocalDate, to?: LocalDate) {
    const rows = db
      .prepare(
        `SELECT kind, amount_minor, currency, merchant_text, occurred_at, created_at
           FROM source_events
          WHERE status = 'needs_review'
          ORDER BY COALESCE(occurred_at, created_at) DESC, rowid DESC`,
      )
      .all() as Record<string, unknown>[];

    const items: { date: LocalDate; kind: string; amount: string | null; merchant_untrusted: string | null }[] = [];
    const totalsByKind = new Map<string, Map<string, Money>>();

    for (const row of rows) {
      const stamp = row.occurred_at !== null ? asNumber(row.occurred_at, "occurred_at") : asNumber(row.created_at, "created_at");
      const date = localDateOf(stamp, service.zone);
      if (from && date < from) continue;
      if (to && date > to) continue;

      const kind = asText(row.kind, "kind");
      const code = asOptionalText(row.currency, "currency");
      const minor = row.amount_minor === null ? null : asBigInt(row.amount_minor, "amount_minor");
      const cur = code ? findCurrency(code) : undefined;
      let formattedAmount: string | null = null;
      if (cur && minor !== null) {
        const amt = money(cur, minor);
        formattedAmount = formatMoney(amt);
        const curMap = totalsByKind.get(kind) ?? new Map<string, Money>();
        addMinor(curMap, cur, minor);
        totalsByKind.set(kind, curMap);
      } else if (minor !== null && code) {
        formattedAmount = `${code} ${String(minor)} (minor)`;
      }

      items.push({
        date,
        kind,
        amount: formattedAmount,
        merchant_untrusted: clip(asOptionalText(row.merchant_text, "merchant_text"), 40),
      });
    }

    const formattedTotals: Record<string, string> = {};
    for (const [kind, map] of totalsByKind) {
      formattedTotals[kind] = formatCurrencyMap(map);
    }

    return {
      count: items.length,
      totals_by_kind: formattedTotals,
      items: items.slice(0, 10),
    };
  }

  function spendingByAccount(from: LocalDate, to: LocalDate) {
    const rows = db
      .prepare(
        `SELECT a.name AS account_name, a.currency AS currency,
                SUM(-e.amount_minor_signed) AS total_minor, COUNT(DISTINCT t.id) AS tx_count
           FROM journal_entries e
           JOIN journals j ON j.id = e.journal_id
           JOIN ledger_accounts a ON a.id = e.ledger_account_id
           JOIN transactions t ON t.id = j.transaction_id
           JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
          WHERE a.is_user_visible = 1
            AND j.id = r.journal_id
            AND j.state = 'posted'
            AND t.status = 'posted'
            AND t.accounting_scope = 'ledger'
            AND t.kind IN ('expense', 'refund')
            AND r.occurred_local_date BETWEEN ? AND ?
          GROUP BY a.id, a.currency
         HAVING SUM(-e.amount_minor_signed) <> 0
          ORDER BY total_minor DESC`,
      )
      .all(from, to) as Record<string, unknown>[];

    return rows.map((row) => ({
      account: asText(row.account_name, "account_name"),
      amount: formatMoney(money(requireCurrency(asText(row.currency, "currency")), asBigInt(row.total_minor, "total_minor"))),
      count: asNumber(row.tx_count, "tx_count"),
    }));
  }

  function expenseReport(from: LocalDate, to: LocalDate) {
    const names = categoryNames();
    const rows = service.spendingByCategory(from, to);
    const totals = new Map<string, Money>();
    const currencies = new Map<string, Currency>();
    for (const row of rows) {
      currencies.set(row.amount.currency.code, row.amount.currency);
      addMinor(totals, row.amount.currency, row.amount.minor);
    }

    const txCount = asNumber(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n
               FROM transactions t
               JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
              WHERE t.status = 'posted'
                AND t.accounting_scope = 'ledger'
                AND t.kind IN ('expense', 'refund')
                AND r.occurred_local_date BETWEEN ? AND ?`,
          )
          .get(from, to) as Record<string, unknown>
      ).n,
      "n",
    );

    const dashboard = createDashboardService({ db });
    const topMerchants = [...currencies.values()].flatMap((currency) =>
      dashboard.topMerchants(currency, from, to, 8).map((m) => ({
        merchant: m.merchant,
        amount: formatMoney(m.amount),
        count: m.times,
      })),
    );

    const largestRows = service.searchTransactions({ from, to, kind: "expense", sort: "largest", limit: 10 });
    const largestAccountNames = accountNamesFor(db, largestRows);
    const largestExpenses = largestRows.map((t) => ({
      date: t.occurredLocalDate,
      amount: formatMoney(t.amount),
      merchant: clip(t.merchantName),
      category: t.categoryId ? (names.get(t.categoryId) ?? t.categoryId) : null,
      account: largestAccountNames.get(t.id) ?? null,
    }));

    const prev = previousRange(from, to);
    const prevRows = service.spendingByCategory(prev.from, prev.to);
    const prevTotals = new Map<string, Money>();
    for (const row of prevRows) addMinor(prevTotals, row.amount.currency, row.amount.minor);
    const allCodes = new Set([...totals.keys(), ...prevTotals.keys()]);
    const changes: string[] = [];
    for (const code of allCodes) {
      const cur = totals.get(code);
      const old = prevTotals.get(code);
      const currency = cur?.currency ?? old!.currency;
      const curMinor = cur?.minor ?? 0n;
      const oldMinor = old?.minor ?? 0n;
      const diff = curMinor - oldMinor;
      if (diff === 0n) {
        changes.push(`${code}: unchanged`);
      } else {
        const sign = diff > 0n ? "+" : "-";
        const absDiff = diff > 0n ? diff : -diff;
        const pct = oldMinor > 0n ? ` (${sign}${((Number(absDiff) / Number(oldMinor)) * 100).toFixed(1)}%)` : "";
        changes.push(`${sign}${formatMoney(money(currency, absDiff))}${pct}`);
      }
    }

    const historyOnly = historyOnlyExpenses(from, to);
    const pendingReview = pendingReviewItems(from, to);

    return {
      from,
      to,
      transaction_count: txCount,
      total: formatCurrencyMap(totals),
      by_category: rows.map((r) => ({ category: names.get(r.categoryId) ?? r.categoryId, amount: formatMoney(r.amount) })),
      by_account: spendingByAccount(from, to),
      top_merchants: topMerchants,
      largest_expenses: largestExpenses,
      previous_period: {
        from: prev.from,
        to: prev.to,
        total: formatCurrencyMap(prevTotals),
        ...(changes.length > 0 ? { change: changes.join(" + ") } : {}),
      },
      ...(historyOnly.count > 0
        ? {
            history_only: {
              ...historyOnly,
              note: "Imported historical expenses before account tracking start; excluded from ledger totals above. Mention these separately if relevant.",
            },
          }
        : {}),
      ...(pendingReview.count > 0
        ? {
            pending_review: {
              ...pendingReview,
              note: "Unreviewed bank messages in this date range are NOT in the totals above until accepted on the Review screen.",
            },
          }
        : {}),
    };
  }

  return { historyOnlyExpenses, pendingReviewItems, spendingByAccount, expenseReport };
}

export type ExpenseReporter = ReturnType<typeof createExpenseReporter>;
