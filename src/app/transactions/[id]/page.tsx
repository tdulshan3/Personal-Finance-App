import type { ReactNode } from "react";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { FinanceErrorCode, isFinanceError } from "../../../core/domain/errors.ts";
import { formatMoney } from "../../../core/domain/money.ts";
import { localDateOf, localDateOfFinancialTime } from "../../../core/domain/time.ts";
import type { FinanceService } from "../../../core/services/finance-service.ts";
import { requireService } from "../../../server/runtime.ts";
import { accessState } from "../../../server/session.ts";
import { labelForKind, labelForPrecision } from "../../../ui/labels.ts";
import { Amount, Badge, Card, InfoNote, PageHeader, Shell } from "../../../ui/primitives.tsx";
import { DeleteTransactionButton, RestoreTransactionButton } from "../row-actions.tsx";
import { EditTransactionForm } from "./edit-transaction-form.tsx";

export const dynamic = "force-dynamic";

type Detail = ReturnType<FinanceService["getTransactionDetail"]>;

/**
 * One transaction: what it is, where the money went, and — for an expense or income — the form
 * that corrects it.
 *
 * buildspec.md §13 lists "create, edit, split, link transfer/refund, soft delete, restore" for
 * Transactions. §9.3 makes an edit a reversal plus a replacement, so the record keeps its id and
 * its history; the "Edited" badge is that history made visible.
 */
export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const { id } = await params;
  const service = requireService();

  let detail: Detail;
  try {
    detail = service.getTransactionDetail(id);
  } catch (error) {
    if (isFinanceError(error) && error.code === FinanceErrorCode.NOT_FOUND) notFound();
    throw error;
  }

  const { transaction, currentRevision: revision } = detail;
  const kind = transaction.kind;
  const title = revision.merchantName ?? labelForKind(kind);
  const localDate = localDateOfFinancialTime(revision.occurredAt);
  const precisionNote = labelForPrecision(revision.occurredAt.precision);
  const isDeleted = transaction.status === "deleted";
  const changes = detail.revisionCount - 1;

  const categories = service.listCategories(true);
  const categoryName = (categoryId: string) =>
    categories.find((c) => c.id === categoryId)?.name ?? categoryId;

  /*
   * A split record has no single category on its revision; the category lines live on the journal.
   * History-only and trashed records carry no journal, so this falls back to the revision.
   */
  const journalCategoryIds = [
    ...new Set(
      (detail.journal?.entries ?? [])
        .map((entry) => entry.categoryId)
        .filter((value): value is string => value !== undefined),
    ),
  ];
  const categoryIds = revision.categoryId ? [revision.categoryId] : journalCategoryIds;

  /*
   * Only a posted ledger record is editable. A history-only record has no journal by definition
   * (buildspec.md §9.4), and an edit always writes a replacement journal — so editing one would
   * start moving today's balance with a record that exists precisely so it never does.
   */
  const isHistoryOnly = transaction.accountingScope === "history_only";
  const editable =
    (kind === "expense" || kind === "income") && transaction.status === "posted" && !isHistoryOnly;

  return (
    <Shell>
      <PageHeader
        title={title}
        subtitle={`${labelForKind(kind)} · ${localDate}`}
        action={<Link href="/transactions">All transactions</Link>}
      />

      <Card
        title="Details"
        action={
          isDeleted ? (
            <RestoreTransactionButton
              transactionId={transaction.id}
              expectedRevision={transaction.currentRevision}
            />
          ) : transaction.status === "posted" ? (
            <DeleteTransactionButton
              transactionId={transaction.id}
              expectedRevision={transaction.currentRevision}
              label={title}
            />
          ) : null
        }
      >
        <div style={{ display: "grid", gap: "var(--space-4)" }}>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            <Badge tone={statusTone(transaction.status)}>{labelForStatus(transaction.status)}</Badge>
            {/* §16: a date-only record must never be shown as though the time were known. */}
            {precisionNote ? <Badge>{precisionNote}</Badge> : null}
            {isHistoryOnly ? <Badge tone="warning">History only</Badge> : null}
            {changes > 0 ? (
              <Badge tone="primary">
                Edited {changes} {changes === 1 ? "time" : "times"}
              </Badge>
            ) : null}
          </div>

          <dl style={{ display: "grid", gap: "var(--space-3)", margin: 0 }}>
            <Row label="Type">{labelForKind(kind)}</Row>
            <Row label="Amount">
              <Amount value={revision.displayAmount} srLabel={labelForKind(kind)} />
            </Row>
            <Row label="Date">{localDate}</Row>
            {accountRows(kind, detail.accounts).map((row) => (
              <Row key={row.label} label={row.label}>
                {row.value}
              </Row>
            ))}
            {categoryIds.length > 0 ? (
              <Row label={categoryIds.length > 1 ? "Categories" : "Category"}>
                {categoryIds.map(categoryName).join(", ")}
              </Row>
            ) : null}
            {revision.merchantName ? (
              <Row label={kind === "income" ? "Payer" : "Merchant"}>{revision.merchantName}</Row>
            ) : null}
            {revision.notes ? <Row label="Notes">{revision.notes}</Row> : null}
          </dl>

          {isHistoryOnly ? (
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              Kept for categories and estimates only. It is from before the tracked balance
              starts, so it is never added to today&apos;s balance.
            </p>
          ) : null}
        </div>
      </Card>

      {editable ? (
        <Card title="Edit">
          <EditTransactionForm
            data={{
              id: transaction.id,
              kind,
              revision: transaction.currentRevision,
              accountId: detail.accounts[0]?.id ?? "",
              amountValue: formatMoney(revision.displayAmount, { withCode: false, grouping: false }),
              date: localDate,
              maxDate: laterOf(localDate, localDateOf(Date.now(), service.zone)),
              categoryId: categoryIds[0] ?? (kind === "income" ? "income" : "uncategorized"),
              merchantName: revision.merchantName ?? "",
              notes: revision.notes ?? "",
              splitCount: journalCategoryIds.length,
            }}
            accounts={accountOptions(service, kind, detail.accounts[0]?.id)}
            categories={categories
              .filter((c) => c.archivedAt === undefined || categoryIds.includes(c.id))
              .map((c) => ({ id: c.id, name: c.name }))}
          />
        </Card>
      ) : (
        <Card>
          <InfoNote>
            {isDeleted
              ? "This record is in Trash. Restore it before editing."
              : (kind === "expense" || kind === "income") && isHistoryOnly
                ? "History-only records can't be edited yet. They never touch a balance, so there is nothing to correct in the ledger."
                : "This kind of record can't be edited yet. Delete it and record it again."}
          </InfoNote>
        </Card>
      )}
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: "var(--space-4)",
        paddingBottom: "var(--space-3)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <dt style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{label}</dt>
      <dd style={{ margin: 0, textAlign: "right", overflowWrap: "anywhere", minWidth: 0 }}>
        {children}
      </dd>
    </div>
  );
}

/** Words the account lines the way the owner thinks about each kind of record. */
function accountRows(kind: string, accounts: Detail["accounts"]): { label: string; value: string }[] {
  if (accounts.length === 0) return [];
  if (kind === "transfer") {
    const from = accounts.filter((a) => a.direction === "out").map((a) => a.name);
    const to = accounts.filter((a) => a.direction === "in").map((a) => a.name);
    return [
      ...(from.length > 0 ? [{ label: "From", value: from.join(", ") }] : []),
      ...(to.length > 0 ? [{ label: "To", value: to.join(", ") }] : []),
    ];
  }
  const label =
    kind === "expense"
      ? "Paid from"
      : kind === "income"
        ? "Received into"
        : kind === "refund"
          ? "Refunded to"
          : accounts.length > 1
            ? "Accounts"
            : "Account";
  return [{ label, value: accounts.map((a) => a.name).join(", ") }];
}

/**
 * The accounts the edit form offers. Income can only land in an asset account, so offering a card
 * there would only produce an error. The record's own account is always offered, even if it has
 * since been archived — otherwise the form would silently default to a different account.
 */
function accountOptions(service: FinanceService, kind: string, currentAccountId: string | undefined) {
  return service
    .listAccounts({ includeArchived: true })
    .filter((a) => a.archivedAt === undefined || a.id === currentAccountId)
    .filter((a) => kind !== "income" || a.kind === "asset" || a.id === currentAccountId)
    .map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency.code,
      archived: a.archivedAt !== undefined,
    }));
}

function labelForStatus(status: string): string {
  switch (status) {
    case "posted":
      return "Posted";
    case "pending":
      return "Pending";
    case "deleted":
      return "In Trash";
    case "merged":
      return "Merged";
    default:
      return status;
  }
}

function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "posted") return "success";
  if (status === "deleted") return "warning";
  return "neutral";
}

/** ISO dates order correctly as plain strings. */
function laterOf(a: string, b: string): string {
  return a >= b ? a : b;
}
