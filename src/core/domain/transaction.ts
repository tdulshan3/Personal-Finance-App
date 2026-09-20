import type { Money } from "./money.ts";
import type { FinancialTime, Instant } from "./time.ts";

/**
 * The owner-facing transaction and its immutable revision history.
 *
 * buildspec.md §9.3: "A posted transaction owns a logical transaction ID and a current financial
 * revision. Immutable journals represent its financial history." The `transactions` row is the
 * stable identity the UI links to; every financial fact lives on a revision.
 */

export const TransactionKind = {
  EXPENSE: "expense",
  INCOME: "income",
  /** Between two of the owner's own accounts, including credit-card repayment. */
  TRANSFER: "transfer",
  /** buildspec.md §9.2: reduces the original expense; never income. */
  REFUND: "refund",
  /** buildspec.md §9.4: the starting-balance anchor. */
  OPENING_BALANCE: "opening_balance",
  /** buildspec.md §10: an unexplained balance difference. */
  UNKNOWN_ADJUSTMENT: "unknown_adjustment",
} as const;
export type TransactionKind = (typeof TransactionKind)[keyof typeof TransactionKind];

/**
 * buildspec.md §9.4: "their `accounting_scope=history_only` prevents them from being added again to
 * today's balance." A record can never be history-only *and* carry an active financial journal.
 */
export const AccountingScope = {
  LEDGER: "ledger",
  HISTORY_ONLY: "history_only",
} as const;
export type AccountingScope = (typeof AccountingScope)[keyof typeof AccountingScope];

export const TransactionStatus = {
  /** Has a posted journal and counts toward balances. */
  POSTED: "posted",
  /**
   * buildspec.md §9.3: "A draft, future schedule, invoice, or pending authorization has no posted
   * journal. Show pending amounts separately."
   */
  PENDING: "pending",
  /** Soft-deleted: reversed and tombstoned, recoverable from Trash (buildspec.md §13, §15). */
  DELETED: "deleted",
  /** Folded into a survivor by a duplicate merge (buildspec.md §8). */
  MERGED: "merged",
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export type Transaction = {
  readonly id: string;
  readonly kind: TransactionKind;
  readonly currentRevision: number;
  readonly accountingScope: AccountingScope;
  readonly status: TransactionStatus;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly deletedAt?: Instant | undefined;
  readonly mergedIntoId?: string | undefined;
};

/**
 * One immutable version of a transaction's business state.
 *
 * buildspec.md §9.3: "Merchant notes and display labels can change by revision without a financial
 * reversal", so not every new revision carries a new `journalId`.
 */
export type TransactionRevision = {
  readonly transactionId: string;
  readonly revision: number;
  readonly occurredAt: FinancialTime;
  readonly merchantId?: string | undefined;
  readonly merchantName?: string | undefined;
  readonly categoryId?: string | undefined;
  /** The magnitude the UI shows. Sign lives on the journal entries, not here. */
  readonly displayAmount: Money;
  readonly notes?: string | undefined;
  /**
   * buildspec.md §7.4: "Manual corrections have priority over subsequent reprocessing." Fields the
   * owner set by hand are listed here so re-extraction cannot quietly overwrite them.
   */
  readonly manualOverrideFields: readonly string[];
  /** The journal carrying this revision's financial effect, if it has one. */
  readonly journalId?: string | undefined;
  readonly actionId: string;
  readonly recordedAt: Instant;
};

export function isFinanciallyActive(transaction: Transaction): boolean {
  return (
    transaction.status === TransactionStatus.POSTED &&
    transaction.accountingScope === AccountingScope.LEDGER
  );
}

/**
 * buildspec.md §9.3: "Spending reports select current logical financial revisions, excluding
 * correction-only reversal journals, and handle actual refunds separately."
 */
export function countsTowardSpending(transaction: Transaction): boolean {
  return (
    transaction.status === TransactionStatus.POSTED &&
    (transaction.kind === TransactionKind.EXPENSE || transaction.kind === TransactionKind.REFUND)
  );
}

/** The set of fields whose change requires a financial reversal + replacement (buildspec.md §9.3). */
export const FINANCIAL_FIELDS: readonly string[] = Object.freeze([
  "amount",
  "currency",
  "accountId",
  "categoryId",
  "occurredAt",
  "splits",
]);

/** Fields that can change by revision without touching the ledger. */
export const DISPLAY_ONLY_FIELDS: readonly string[] = Object.freeze([
  "merchantName",
  "merchantId",
  "notes",
]);
