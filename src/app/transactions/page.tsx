import { redirect } from "next/navigation";

import { localDateOf } from "../../core/domain/time.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { iconForCategory, iconForKind, labelForKind, labelForPrecision } from "../../ui/labels.ts";
import { accountNamesFor, queryOf, readFilters, searchArgs } from "./ledger-rows.ts";
import type { TransactionsData } from "./transactions-view.tsx";
import { TransactionsView } from "./transactions-view.tsx";

export const dynamic = "force-dynamic";

const LIMIT = 200;

/**
 * Transactions.
 *
 * buildspec.md §13: "Search, filters, date/account/category/source controls, create, edit, split,
 * link transfer/refund, soft delete, restore, multi-select preview." Filters are plain GET
 * parameters, so the list is linkable — Home's "Where it went" and "Top merchants" open it
 * already filtered — and a reload or a live refresh keeps them.
 *
 * `?view=trash` is the same screen over deleted records, with Restore in place of Move to Trash.
 */
export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const filters = readFilters(await searchParams);
  const rows = service.searchTransactions({ ...searchArgs(filters), limit: LIMIT });
  const accountNames = accountNamesFor(requireDb(), rows);
  const categories = service.listCategories(true);
  const categoryOf = new Map(categories.map((c) => [c.id, c]));

  const data: TransactionsData = {
    today: localDateOf(Date.now(), service.zone),
    filters: {
      text: filters.text ?? "",
      accountId: filters.accountId ?? "",
      categoryId: filters.categoryId ?? "",
      from: filters.from ?? "",
      to: filters.to ?? "",
      includeHistoryOnly: filters.includeHistoryOnly,
      trash: filters.trash,
    },
    exportHref: `/api/export/transactions${queryOf(filters)}`,
    otherViewHref: `/transactions${queryOf(filters, { view: filters.trash ? undefined : "trash" })}`,
    limitReached: rows.length === LIMIT,
    rows: rows.map((row) => {
      const category = row.categoryId ? categoryOf.get(row.categoryId) : undefined;
      return {
        id: row.id,
        kind: row.kind,
        kindLabel: labelForKind(row.kind),
        title: row.merchantName ?? labelForKind(row.kind),
        categoryName: row.categoryId ? (category?.name ?? row.categoryId) : null,
        icon: category ? iconForCategory(category.iconKey, category.kind) : iconForKind(row.kind),
        account: accountNames.get(row.id) ?? null,
        date: row.occurredLocalDate,
        // §16: a date-only record must never be shown as though the time were known.
        precision: labelForPrecision(row.occurredPrecision) ?? null,
        historyOnly: row.accountingScope === "history_only",
        amount: row.amount,
        revision: row.revision,
        notes: row.notes ?? null,
      };
    }),
    accounts: service.listAccounts({ includeArchived: true }).filter((a) => a.isUserVisible).map((a) => ({ id: a.id, name: a.name })),
    categories: categories.filter((c) => c.archivedAt === undefined || c.id === filters.categoryId).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
  };

  return <TransactionsView data={data} />;
}
