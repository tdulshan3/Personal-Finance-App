import { notFound, redirect } from "next/navigation";

import { FinanceErrorCode, isFinanceError } from "../../../core/domain/errors.ts";
import { localDateOf, localDateOfFinancialTime } from "../../../core/domain/time.ts";
import type { FinanceService } from "../../../core/services/finance-service.ts";
import { requireService } from "../../../server/runtime.ts";
import { accessState } from "../../../server/session.ts";
import { plainAmount } from "../../../ui/format.ts";
import { labelForKind, labelForPrecision } from "../../../ui/labels.ts";
import type { DetailData } from "./detail-view.tsx";
import { DetailView } from "./detail-view.tsx";

export const dynamic = "force-dynamic";

type Detail = ReturnType<FinanceService["getTransactionDetail"]>;

/**
 * One transaction: what it is, where the money went, and — for an expense or income — the form
 * that corrects it.
 *
 * buildspec.md §13 lists "create, edit, split, link transfer/refund, soft delete, restore" for
 * Transactions. §9.3 makes an edit a reversal plus a replacement, so the record keeps its id and
 * its history; "Edited N times" is that history made visible.
 */
export default async function TransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
  const localDate = localDateOfFinancialTime(revision.occurredAt);
  const isDeleted = transaction.status === "deleted";
  const isHistoryOnly = transaction.accountingScope === "history_only";
  const categories = service.listCategories(true);
  const categoryName = (categoryId: string) => categories.find((c) => c.id === categoryId)?.name ?? categoryId;

  /*
   * A split record has no single category on its revision; the category lines live on the journal.
   * History-only and trashed records carry no journal, so this falls back to the revision.
   */
  const journalCategoryIds = [...new Set((detail.journal?.entries ?? []).map((entry) => entry.categoryId).filter((value): value is string => value !== undefined))];
  const categoryIds = revision.categoryId ? [revision.categoryId] : journalCategoryIds;

  /*
   * Only a posted ledger record is editable. A history-only record has no journal by definition
   * (buildspec.md §9.4), and an edit always writes a replacement journal — so editing one would
   * start moving today's balance with a record that exists precisely so it never does.
   */
  const editable = (kind === "expense" || kind === "income") && transaction.status === "posted" && !isHistoryOnly;
  const notEditable = isDeleted
    ? "This record is in Trash. Restore it before editing."
    : (kind === "expense" || kind === "income") && isHistoryOnly
      ? "History-only records can't be edited yet. They never touch a balance, so there is nothing to correct in the ledger."
      : "This kind of record can't be edited yet. Move it to Trash and record it again.";

  const currentAccountId = detail.accounts[0]?.id;
  const currentCategory = categoryIds[0] ?? (kind === "income" ? "income" : "uncategorized");
  const categoryKind = kind === "income" ? "income" : "expense";

  const data: DetailData = {
    id: transaction.id,
    kind,
    kindLabel: labelForKind(kind),
    title: revision.merchantName ?? labelForKind(kind),
    status: transaction.status,
    precision: labelForPrecision(revision.occurredAt.precision) ?? null,
    historyOnly: isHistoryOnly,
    changes: detail.revisionCount - 1,
    amount: revision.displayAmount,
    date: localDate,
    accountLines: accountRows(kind, detail.accounts),
    categories: categoryIds.map(categoryName),
    merchant: revision.merchantName ?? null,
    notes: revision.notes ?? null,
    revision: transaction.currentRevision,
    notEditable: editable ? null : notEditable,
    edit: editable
      ? {
          kind: kind as "expense" | "income",
          accountId: currentAccountId ?? "",
          amountValue: plainAmount(revision.displayAmount),
          date: localDate,
          maxDate: laterOf(localDate, localDateOf(Date.now(), service.zone)),
          categoryId: currentCategory,
          merchantName: revision.merchantName ?? "",
          notes: revision.notes ?? "",
          splitCount: journalCategoryIds.length,
          accounts: accountOptions(service, kind, currentAccountId),
          // The record's own category always stays on offer, even if archived or of the other kind.
          categories: categories
            .filter((c) => (c.archivedAt === undefined && c.kind === categoryKind) || c.id === currentCategory)
            .map((c) => ({ id: c.id, name: c.name })),
        }
      : null,
  };

  return <DetailView data={data} />;
}

/** Words the account lines the way the owner thinks about each kind of record. */
function accountRows(kind: string, accounts: Detail["accounts"]): { label: string; value: string }[] {
  if (accounts.length === 0) return [];
  if (kind === "transfer") {
    const from = accounts.filter((a) => a.direction === "out").map((a) => a.name);
    const to = accounts.filter((a) => a.direction === "in").map((a) => a.name);
    return [...(from.length > 0 ? [{ label: "From", value: from.join(", ") }] : []), ...(to.length > 0 ? [{ label: "To", value: to.join(", ") }] : [])];
  }
  const label =
    kind === "expense" ? "Paid from" : kind === "income" ? "Received into" : kind === "refund" ? "Refunded to" : accounts.length > 1 ? "Accounts" : "Account";
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
    .filter((a) => a.isUserVisible)
    .filter((a) => a.archivedAt === undefined || a.id === currentAccountId)
    .filter((a) => kind !== "income" || a.kind === "asset" || a.id === currentAccountId)
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency.code, archived: a.archivedAt !== undefined }));
}

/** ISO dates order correctly as plain strings. */
function laterOf(a: string, b: string): string {
  return a >= b ? a : b;
}
