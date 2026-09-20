import Link from "next/link";
import { redirect } from "next/navigation";

import { TransactionStatus } from "../../core/domain/transaction.ts";
import { requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { labelForKind, labelForPrecision } from "../../ui/labels.ts";
import { Amount, Badge, Card, EmptyState, PageHeader, Shell } from "../../ui/primitives.tsx";
import { DeleteTransactionButton, RestoreTransactionButton } from "./row-actions.tsx";

export const dynamic = "force-dynamic";

/**
 * Transactions.
 *
 * buildspec.md §13: "Search, filters, date/account/category/source controls, create, edit, split,
 * link transfer/refund, soft delete, restore, multi-select preview." Filters are plain GET
 * parameters so the list is linkable and survives a reload.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    const text = Array.isArray(value) ? value[0] : value;
    return text && text.length > 0 ? text : undefined;
  };

  const service = requireService();
  const accounts = service.listAccounts();
  const categories = service.listCategories();
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));

  const showTrash = single("view") === "trash";
  const filters = {
    text: single("q"),
    accountId: single("account"),
    categoryId: single("category"),
    from: single("from"),
    to: single("to"),
    status: showTrash ? TransactionStatus.DELETED : TransactionStatus.POSTED,
    includeHistoryOnly: single("history") === "1",
    limit: 100,
  };
  const rows = service.searchTransactions(filters);

  return (
    <Shell>
      <PageHeader
        title={showTrash ? "Trash" : "Transactions"}
        subtitle={
          showTrash
            ? "Deleted records keep their history and can be restored."
            : `${rows.length} shown`
        }
        action={
          <Link
            href="/transactions/new"
            style={{
              minHeight: "var(--touch-target)",
              display: "inline-flex",
              alignItems: "center",
              padding: "0 var(--space-5)",
              borderRadius: "var(--radius-pill)",
              background: "var(--primary)",
              color: "var(--primary-contrast)",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Add
          </Link>
        }
      />

      <Card>
        {/* A plain GET form keeps filters in the URL and needs no client JavaScript. */}
        <form method="get" style={{ display: "grid", gap: "var(--space-3)" }}>
          <input
            type="search"
            name="q"
            defaultValue={filters.text ?? ""}
            placeholder="Search merchant or notes"
            aria-label="Search merchant or notes"
            style={{
              minHeight: "var(--touch-target)",
              padding: "0 var(--space-4)",
              borderRadius: "var(--radius-input)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              width: "100%",
            }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            <select
              name="account"
              defaultValue={filters.accountId ?? ""}
              aria-label="Filter by account"
              style={selectStyle}
            >
              <option value="">All accounts</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
            <select
              name="category"
              defaultValue={filters.categoryId ?? ""}
              aria-label="Filter by category"
              style={selectStyle}
            >
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              name="from"
              defaultValue={filters.from ?? ""}
              aria-label="From date"
              style={selectStyle}
            />
            <input
              type="date"
              name="to"
              defaultValue={filters.to ?? ""}
              aria-label="To date"
              style={selectStyle}
            />
            {showTrash ? <input type="hidden" name="view" value="trash" /> : null}
            <button type="submit" style={{ ...selectStyle, fontWeight: 600, cursor: "pointer" }}>
              Apply
            </button>
          </div>
        </form>
        <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "var(--space-4)" }}>
          <Link href={showTrash ? "/transactions" : "/transactions?view=trash"}>
            {showTrash ? "Back to transactions" : "View Trash"}
          </Link>
        </div>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title={showTrash ? "Trash is empty" : "No transactions match"}
            body={
              showTrash
                ? "Deleted transactions will appear here until you purge them."
                : "Try widening the date range or clearing the filters."
            }
          />
        </Card>
      ) : (
        <Card>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-4)" }}>
            {rows.map((row) => {
              const precisionNote = labelForPrecision(row.occurredPrecision);
              return (
                <li
                  key={row.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "var(--space-4)",
                    paddingBottom: "var(--space-4)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
                    <span style={{ fontWeight: 560 }}>
                      {row.merchantName ?? labelForKind(row.kind)}
                    </span>
                    <span
                      style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}
                    >
                      {row.occurredLocalDate} · {labelForKind(row.kind)}
                      {row.categoryId ? ` · ${categoryNames.get(row.categoryId) ?? row.categoryId}` : ""}
                    </span>
                    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                      {/* §16: a date-only record must never be shown as though the time were known. */}
                      {precisionNote ? <Badge>{precisionNote}</Badge> : null}
                      {row.accountingScope === "history_only" ? (
                        <Badge tone="warning">History only</Badge>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ display: "grid", gap: "var(--space-2)", justifyItems: "end" }}>
                    <Amount value={row.amount} srLabel={labelForKind(row.kind)} />
                    {showTrash ? (
                      <RestoreTransactionButton
                        transactionId={row.id}
                        expectedRevision={row.revision}
                      />
                    ) : (
                      <DeleteTransactionButton
                        transactionId={row.id}
                        expectedRevision={row.revision}
                        label={row.merchantName ?? labelForKind(row.kind)}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p
            style={{
              marginTop: "var(--space-4)",
              fontSize: "var(--font-sm)",
              color: "var(--text-secondary)",
            }}
          >
            Accounts: {[...accountNames.values()].join(", ") || "none yet"}
          </p>
        </Card>
      )}
    </Shell>
  );
}

const selectStyle = {
  minHeight: "var(--touch-target)",
  padding: "0 var(--space-3)",
  borderRadius: "var(--radius-input)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
} as const;
