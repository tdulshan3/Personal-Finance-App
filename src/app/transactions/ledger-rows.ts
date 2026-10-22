import type { Db } from "../../core/data/driver.ts";
import { asBigInt, asText } from "../../core/data/driver.ts";
import { TransactionStatus } from "../../core/domain/transaction.ts";

/**
 * Server-side helpers shared by the Transactions screen and its CSV export, so the two always
 * agree on what "the current filters" mean and on how a row's accounts are named.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type LedgerFilters = {
  readonly text: string | undefined;
  readonly accountId: string | undefined;
  readonly categoryId: string | undefined;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly includeHistoryOnly: boolean;
  readonly trash: boolean;
};

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

/** Reads the filters from GET parameters. A malformed date is ignored rather than refused. */
export function readFilters(params: Params): LedgerFilters {
  const single = (key: string): string | undefined => {
    const value = params instanceof URLSearchParams ? params.get(key) : params[key];
    const text = (Array.isArray(value) ? value[0] : value)?.trim();
    return text && text.length > 0 ? text : undefined;
  };
  const date = (key: string) => {
    const value = single(key);
    return value && DATE.test(value) ? value : undefined;
  };
  return {
    text: single("q"),
    accountId: single("account"),
    categoryId: single("category"),
    from: date("from"),
    to: date("to"),
    includeHistoryOnly: single("history") === "1",
    trash: single("view") === "trash",
  };
}

/** The same filters as `searchTransactions` takes them. */
export function searchArgs(filters: LedgerFilters) {
  return {
    text: filters.text,
    accountId: filters.accountId,
    categoryId: filters.categoryId,
    from: filters.from,
    to: filters.to,
    status: filters.trash ? TransactionStatus.DELETED : TransactionStatus.POSTED,
    // Trash holds whatever was deleted, including records that never touched a balance.
    includeHistoryOnly: filters.trash || filters.includeHistoryOnly,
  };
}

/** The filters back as a query string, for links that keep them (the export, the other view). */
export function queryOf(filters: LedgerFilters, overrides: Partial<Record<"view", string | undefined>> = {}): string {
  const query = new URLSearchParams();
  if (filters.text) query.set("q", filters.text);
  if (filters.accountId) query.set("account", filters.accountId);
  if (filters.categoryId) query.set("category", filters.categoryId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.includeHistoryOnly) query.set("history", "1");
  const view = "view" in overrides ? overrides.view : filters.trash ? "trash" : undefined;
  if (view) query.set("view", view);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * The owner's accounts each transaction touches, in one query: "Everyday Bank" for a purchase,
 * "Everyday Bank → Sample Visa" for a transfer (money leaves the first, arrives in the second).
 *
 * A record in Trash owns no live journal, so its accounts come from the journal its deletion
 * reversed — the same fallback the detail screen uses. A history-only record has no journal at
 * all and simply gets no account line.
 */
export function accountNamesFor(db: Db, rows: readonly { id: string; kind: string }[]): Map<string, string> {
  const names = new Map<string, string>();
  for (let start = 0; start < rows.length; start += 400) {
    const chunk = rows.slice(start, start + 400);
    const found = db
      .prepare(
        `SELECT t.id AS tid, a.name AS name, SUM(e.amount_minor_signed) AS net
           FROM transactions t
           JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
           JOIN journal_entries e ON e.journal_id = COALESCE(
                  r.journal_id,
                  (SELECT j2.reverses_journal_id FROM journals j2
                    WHERE j2.transaction_id = t.id AND j2.purpose = 'deletion_reversal'
                    ORDER BY j2.recorded_at DESC LIMIT 1))
           JOIN ledger_accounts a ON a.id = e.ledger_account_id AND a.is_user_visible = 1
          WHERE t.id IN (${chunk.map(() => "?").join(",")})
          GROUP BY t.id, a.id
          ORDER BY t.id, net ASC`,
      )
      .all(...chunk.map((row) => row.id)) as Record<string, unknown>[];
    const byId = new Map<string, { name: string; net: bigint }[]>();
    for (const row of found) {
      const id = asText(row.tid, "tid");
      byId.set(id, [...(byId.get(id) ?? []), { name: asText(row.name, "name"), net: asBigInt(row.net, "net") }]);
    }
    for (const row of chunk) {
      const accounts = byId.get(row.id);
      if (!accounts || accounts.length === 0) continue;
      // Debit-positive: the account money left has the negative net and sorts first.
      names.set(row.id, row.kind === "transfer" && accounts.length > 1 ? accounts.map((a) => a.name).join(" → ") : accounts.map((a) => a.name).join(", "));
    }
  }
  return names;
}
