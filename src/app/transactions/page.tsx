import Link from "next/link";
import { redirect } from "next/navigation";

import { TransactionStatus } from "../../core/domain/transaction.ts";
import { requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { Button, Select, TextInput } from "../../ui/form.tsx";
import { labelForKind, labelForPrecision } from "../../ui/labels.ts";
import {
  Amount,
  Badge,
  ButtonLink,
  Card,
  Columns,
  EmptyState,
  PageHeader,
  Shell,
  Stack,
} from "../../ui/primitives.tsx";
import { DeleteTransactionButton, RestoreTransactionButton } from "./row-actions.tsx";
import styles from "./transactions.module.css";

export const dynamic = "force-dynamic";

/**
 * Transactions.
 *
 * buildspec.md §13: "Search, filters, date/account/category/source controls, create, edit, split,
 * link transfer/refund, soft delete, restore, multi-select preview." Filters are plain GET
 * parameters so the list is linkable and survives a reload.
 *
 * On a desktop the list is the main column and the filters stay in view beside it. The filters come
 * first in the markup, for the keyboard and for a phone; `Columns flip` draws them on the right.
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
          <ButtonLink href="/transactions/new">Add</ButtonLink>
        }
      />

      {/*
        Filters come first in the DOM so the keyboard and a screen reader reach Search before a
        hundred rows; `flip` still draws them to the right of the list they filter.
      */}
      <Columns layout="aside-main" flip>
        <Stack sticky>
          <Card>
            {/* A plain GET form keeps filters in the URL and needs no client JavaScript. */}
            <form method="get" className={styles.filters}>
              <TextInput
                type="search"
                name="q"
                defaultValue={filters.text ?? ""}
                placeholder="Search merchant or notes"
                aria-label="Search merchant or notes"
                className={styles.filterWide}
              />
              <Select name="account" defaultValue={filters.accountId ?? ""} aria-label="Filter by account">
                <option value="">All accounts</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
              <Select name="category" defaultValue={filters.categoryId ?? ""} aria-label="Filter by category">
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
              {/* Visible labels: a bare date box does not say which end of the range it is. */}
              <label className={styles.filterLabel}>
                From
                <TextInput type="date" name="from" defaultValue={filters.from ?? ""} />
              </label>
              <label className={styles.filterLabel}>
                To
                <TextInput type="date" name="to" defaultValue={filters.to ?? ""} />
              </label>
              {showTrash ? <input type="hidden" name="view" value="trash" /> : null}
              <div className={styles.filterWide}>
                <Button variant="secondary" style={{ width: "100%" }}>
                  Apply
                </Button>
              </div>
            </form>
            <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "var(--space-4)" }}>
              <Link href={showTrash ? "/transactions" : "/transactions?view=trash"}>
                {showTrash ? "Back to transactions" : "View Trash"}
              </Link>
            </div>
          </Card>
        </Stack>

        <Stack>
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
              <div className={styles.ledger}>
                <ul className={styles.rows}>
                  {/* Column names for the desktop table. A phone row labels itself, so it hides them. */}
                  <li className={styles.head} aria-hidden="true">
                    <span>Date</span>
                    <span>Merchant or payer</span>
                    <span>Category</span>
                    <span className={styles.headAmount}>Amount</span>
                  </li>
                  {rows.map((row) => {
                    const precisionNote = labelForPrecision(row.occurredPrecision);
                    return (
                      <li key={row.id} className={styles.row}>
                        <div className={styles.rowMain}>
                          {/*
                            Merchant and badges share a table cell, so they are grouped here. A
                            phone still shows the badges last, under the date line — the stylesheet
                            orders them.
                          */}
                          <div className={styles.rowHead}>
                            <Link href={`/transactions/${row.id}`} className={styles.rowTitle}>
                              {row.merchantName ?? labelForKind(row.kind)}
                            </Link>
                            <div className={styles.rowBadges}>
                              {/* §16: a date-only record must never be shown as though the time were known. */}
                              {precisionNote ? <Badge>{precisionNote}</Badge> : null}
                              {row.accountingScope === "history_only" ? (
                                <Badge tone="warning">History only</Badge>
                              ) : null}
                            </div>
                          </div>
                          {/* One line on a phone; the stylesheet supplies the " · " between the parts. */}
                          <span className={styles.rowMeta}>
                            <span className={styles.rowDate}>{row.occurredLocalDate}</span>
                            <span className={styles.rowWhat}>
                              <span className={styles.rowKind}>{labelForKind(row.kind)}</span>
                              {row.categoryId ? (
                                <span className={styles.rowCategory}>
                                  {categoryNames.get(row.categoryId) ?? row.categoryId}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </div>
                        <div className={styles.rowTrailing}>
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
              </div>
            </Card>
          )}
        </Stack>
      </Columns>
    </Shell>
  );
}

