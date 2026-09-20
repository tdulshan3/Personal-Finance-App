import { createHash, randomUUID } from "node:crypto";

import type { Db } from "../data/driver.ts";
import { asBigInt, asNumber, asOptionalText, asText } from "../data/driver.ts";
import type { LedgerRepository } from "../data/ledger-repository.ts";
import { createLedgerRepository } from "../data/ledger-repository.ts";
import { notFound, validationError } from "../domain/errors.ts";
import type { LedgerAccount } from "../domain/ledger.ts";
import { AccountKind, AccountType, LiquidityRole, availableCredit, creditUtilisation } from "../domain/ledger.ts";
import type { Currency, Money } from "../domain/money.ts";
import { money, requireCurrency } from "../domain/money.ts";
import type {
  Actor,
  CategorySplit,
  IdSource,
  PostingContext,
  PostingPlan,
} from "../domain/posting.ts";
import {
  OWNER_ACTOR,
  planCreateExpense,
  planCreateIncome,
  planCreateRefund,
  planCreateTransfer,
  planDeleteTransaction,
  planEditFinancials,
  planOpeningBalance,
  planRestoreTransaction,
  planUnknownAdjustment,
} from "../domain/posting.ts";
import type { Clock, FinancialTime, Instant, LocalDate } from "../domain/time.ts";
import { SUGGESTED_DEFAULT_ZONE, systemClock } from "../domain/time.ts";
import type { AccountingScope } from "../domain/transaction.ts";
import { TransactionKind, TransactionStatus } from "../domain/transaction.ts";

/**
 * The typed application services of buildspec.md §3 and §16.
 *
 * buildspec.md §1 requires the manual UI, import workers and agent tools to share one set of
 * business rules, so every write in the app goes through this file rather than touching the
 * repository or the posting builders directly. §3 also says these are in-process contracts:
 * "Do not add a public HTTP server to the phone just to use the contracts" — the Next.js route
 * handlers are a thin, authenticated adapter over these functions, not a second implementation.
 */

/* -------------------------------------------------------------------------------------------- */
/* Default taxonomy                                                                               */
/* -------------------------------------------------------------------------------------------- */

/** buildspec.md §7.5: the starting category set. Editable; one parent level allowed. */
export const DEFAULT_CATEGORIES: readonly {
  id: string;
  name: string;
  icon: string;
  kind: "expense" | "income";
}[] = Object.freeze([
  { id: "groceries", name: "Groceries", icon: "shopping-cart", kind: "expense" },
  { id: "dining", name: "Dining", icon: "utensils", kind: "expense" },
  { id: "transport", name: "Transport", icon: "bus", kind: "expense" },
  { id: "housing", name: "Housing", icon: "home", kind: "expense" },
  { id: "utilities", name: "Utilities", icon: "plug", kind: "expense" },
  { id: "healthcare", name: "Healthcare", icon: "heart-pulse", kind: "expense" },
  { id: "education", name: "Education", icon: "graduation-cap", kind: "expense" },
  { id: "shopping", name: "Shopping", icon: "bag", kind: "expense" },
  { id: "entertainment", name: "Entertainment", icon: "film", kind: "expense" },
  { id: "fees", name: "Fees", icon: "receipt", kind: "expense" },
  { id: "income", name: "Income", icon: "arrow-down-circle", kind: "income" },
  { id: "uncategorized", name: "Uncategorized", icon: "help-circle", kind: "expense" },
]);

export type Category = {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string | undefined;
  readonly iconKey?: string | undefined;
  readonly isSystem: boolean;
  readonly archivedAt?: Instant | undefined;
};

/** One row of the Transactions list. Money stays a `Money`, never a formatted string. */
export type TransactionListItem = {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly accountingScope: string;
  readonly revision: number;
  readonly occurredAt: Instant;
  readonly occurredLocalDate: LocalDate;
  readonly occurredPrecision: string;
  readonly merchantName?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly amount: Money;
  readonly notes?: string | undefined;
};

/* -------------------------------------------------------------------------------------------- */
/* Service                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export type FinanceServiceOptions = {
  readonly db: Db;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  /** The owner's reporting timezone. buildspec.md §2 suggests Asia/Colombo but never assumes it. */
  readonly zone?: string;
};

function defaultIdSource(): IdSource {
  return { next: (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 22)}` };
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Deterministic JSON so the same request always produces the same idempotency hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? `"${value.toString()}"` : JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export type WriteOptions = {
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
  /** buildspec.md §16: supplied by the caller so a retried submit cannot post twice. */
  readonly idempotencyKey?: string;
};

export function createFinanceService(options: FinanceServiceOptions) {
  const { db } = options;
  const zone = options.zone ?? SUGGESTED_DEFAULT_ZONE;
  const clock = options.clock ?? systemClock(() => zone);
  const ids = options.ids ?? defaultIdSource();
  const repo: LedgerRepository = createLedgerRepository(db);

  const context: PostingContext = {
    lookup: repo.accountLookup,
    ids,
    clock,
    categories: {
      expenseAccountFor: (categoryId, currency) =>
        repo.categoryAccountFor(categoryId, currency, AccountKind.EXPENSE, clock.now()),
      incomeAccountFor: (categoryId, currency) =>
        repo.categoryAccountFor(categoryId, currency, AccountKind.INCOME, clock.now()),
    },
    system: {
      openingEquityFor: (currency) => repo.systemAccountFor("opening", currency, clock.now()),
      reconciliationEquityFor: (currency) =>
        repo.systemAccountFor("reconciliation", currency, clock.now()),
    },
  };

  function commit(plan: PostingPlan, operation: string, request: unknown, write: WriteOptions) {
    const idempotency = write.idempotencyKey
      ? {
          scope: `${write.actor?.kind ?? OWNER_ACTOR.kind}:${operation}`,
          key: write.idempotencyKey,
          requestHash: canonicalHash(request),
        }
      : undefined;
    const result = repo.applyPostingPlan(plan, { idempotency });
    return { ...result, transactionId: plan.transaction.id, plan };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Setup                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /** Installs the default categories. Safe to call repeatedly. */
  function seedDefaultCategories(): void {
    const now = clock.now();
    const insert = db.prepare(
      `INSERT INTO categories (id, name, icon_key, sort_order, is_system, created_at, updated_at)
       VALUES (?,?,?,?,1,?,?)
       ON CONFLICT(id) DO NOTHING`,
    );
    db.transaction(() => {
      DEFAULT_CATEGORIES.forEach((category, index) => {
        insert.run(category.id, category.name, category.icon, index, now, now);
      });
    });
  }

  function listCategories(includeArchived = false): Category[] {
    const where = includeArchived ? "" : "WHERE archived_at IS NULL";
    return (
      db.prepare(`SELECT * FROM categories ${where} ORDER BY sort_order, name`).all() as Record<
        string,
        unknown
      >[]
    ).map((row) => ({
      id: asText(row.id, "id"),
      name: asText(row.name, "name"),
      parentId: asOptionalText(row.parent_id, "parent_id"),
      iconKey: asOptionalText(row.icon_key, "icon_key"),
      isSystem: asNumber(row.is_system, "is_system") === 1,
      archivedAt: row.archived_at === null ? undefined : asNumber(row.archived_at, "archived_at"),
    }));
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Accounts                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  function createAccount(input: {
    name: string;
    type: AccountType;
    currency: Currency;
    institution?: string | undefined;
    liquidityRole?: LiquidityRole;
    trackingStartAt?: Instant | undefined;
    creditLimit?: Money | undefined;
  }): LedgerAccount {
    if (input.name.trim().length === 0) throw validationError("Account name is required");
    if (
      input.type === AccountType.CATEGORY_EXPENSE ||
      input.type === AccountType.CATEGORY_INCOME ||
      input.type === AccountType.SYSTEM_EQUITY
    ) {
      throw validationError("Internal account types cannot be created from the Accounts screen");
    }

    const kind =
      input.type === AccountType.CREDIT_CARD || input.type === AccountType.LOAN
        ? AccountKind.LIABILITY
        : AccountKind.ASSET;

    const liquidityRole =
      input.liquidityRole ??
      (kind === AccountKind.LIABILITY
        ? LiquidityRole.CREDIT_LINE
        : input.type === AccountType.SAVINGS
          ? LiquidityRole.PROTECTED_SAVINGS
          : LiquidityRole.LIQUID);

    return repo.insertAccount(
      {
        id: ids.next("acct"),
        name: input.name.trim(),
        kind,
        type: input.type,
        currency: input.currency,
        liquidityRole,
        institution: input.institution,
        trackingStartAt: input.trackingStartAt,
        isUserVisible: true,
        ...(input.creditLimit ? { creditLimitMinor: input.creditLimit.minor } : {}),
      },
      clock.now(),
    );
  }

  /**
   * Edits an account's owner-facing details.
   *
   * Currency and kind are deliberately not editable. Every journal already posted to the account
   * assumes both, and §17.3 rejects a journal whose account currency differs from its own — so
   * changing them would either invalidate history or silently mis-state it.
   */
  function updateAccount(input: {
    accountId: string;
    expectedRevision: number;
    name?: string | undefined;
    institution?: string | null | undefined;
    creditLimit?: Money | null | undefined;
  }): LedgerAccount {
    const account = repo.findAccount(input.accountId);
    if (!account) throw notFound("Account", input.accountId);

    if (input.creditLimit != null) {
      if (account.kind !== AccountKind.LIABILITY) {
        throw validationError("A credit limit only applies to a credit card or loan", {
          account_id: account.id,
        });
      }
      if (input.creditLimit.currency.code !== account.currency.code) {
        throw validationError(
          `The limit must be in ${account.currency.code}, the account's own currency`,
        );
      }
      if (input.creditLimit.minor < 0n) throw validationError("A credit limit cannot be negative");
    }

    return repo.updateAccount({
      id: input.accountId,
      expectedRevision: input.expectedRevision,
      name: input.name,
      institution: input.institution,
      creditLimitMinor:
        input.creditLimit === undefined ? undefined : (input.creditLimit?.minor ?? null),
      now: clock.now(),
    });
  }

  /** buildspec.md §13: archiving preserves history; it is not deletion, and it is reversible. */
  function archiveAccount(accountId: string): LedgerAccount {
    return repo.setAccountArchived(accountId, true, clock.now());
  }

  function unarchiveAccount(accountId: string): LedgerAccount {
    return repo.setAccountArchived(accountId, false, clock.now());
  }

  /** What archiving would preserve, so the screen can say it rather than imply it. */
  function accountUsage(accountId: string) {
    return repo.accountUsage(accountId);
  }

  function setOpeningBalance(
    input: { accountId: string; amount: Money; occurredAt: FinancialTime },
    write: WriteOptions = {},
  ) {
    const plan = planOpeningBalance(context, {
      accountId: input.accountId,
      amount: input.amount,
      occurredAt: input.occurredAt,
      actor: write.actor,
      origin: write.origin,
      reason: write.reason,
    });
    return commit(plan, "account.opening_balance", input, write);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Transactions                                                                               */
  /* ---------------------------------------------------------------------------------------- */

  function createExpense(
    input: {
      accountId: string;
      amount: Money;
      occurredAt: FinancialTime;
      splits: readonly CategorySplit[];
      merchantName?: string | undefined;
      notes?: string | undefined;
      accountingScope?: AccountingScope;
    },
    write: WriteOptions = {},
  ) {
    const plan = planCreateExpense(context, { ...input, ...actorFields(write) });
    return commit(plan, "transaction.create_expense", input, write);
  }

  function createIncome(
    input: {
      accountId: string;
      amount: Money;
      occurredAt: FinancialTime;
      splits: readonly CategorySplit[];
      merchantName?: string | undefined;
      notes?: string | undefined;
    },
    write: WriteOptions = {},
  ) {
    const plan = planCreateIncome(context, { ...input, ...actorFields(write) });
    return commit(plan, "transaction.create_income", input, write);
  }

  function createTransfer(
    input: {
      fromAccountId: string;
      toAccountId: string;
      amount: Money;
      occurredAt: FinancialTime;
      fee?: { amount: Money; categoryId: string } | undefined;
      notes?: string | undefined;
    },
    write: WriteOptions = {},
  ) {
    const plan = planCreateTransfer(context, { ...input, ...actorFields(write) });
    return commit(plan, "transaction.create_transfer", input, write);
  }

  function createRefund(
    input: {
      accountId: string;
      amount: Money;
      occurredAt: FinancialTime;
      categoryId: string;
      merchantName?: string | undefined;
      notes?: string | undefined;
    },
    write: WriteOptions = {},
  ) {
    const plan = planCreateRefund(context, { ...input, ...actorFields(write) });
    return commit(plan, "transaction.create_refund", input, write);
  }

  function recordUnknownAdjustment(
    input: { accountId: string; displayDelta: Money; occurredAt: FinancialTime },
    write: WriteOptions = {},
  ) {
    const plan = planUnknownAdjustment(context, { ...input, ...actorFields(write) });
    return commit(plan, "reconciliation.unknown_adjustment", input, write);
  }

  /**
   * Edits the financial fields of a posted expense.
   *
   * buildspec.md §9.3 routes this through a reversal + replacement rather than mutating rows, so
   * the original stays visible in history and the balance arithmetic stays auditable.
   */
  function editExpense(
    input: {
      transactionId: string;
      expectedRevision: number;
      accountId: string;
      amount: Money;
      occurredAt: FinancialTime;
      splits: readonly CategorySplit[];
      merchantName?: string | undefined;
      notes?: string | undefined;
    },
    write: WriteOptions = {},
  ) {
    const snapshot = repo.snapshotOf(input.transactionId);
    if (snapshot.transaction.kind !== TransactionKind.EXPENSE) {
      throw validationError("Only an expense record can be edited as an expense", {
        transaction_id: input.transactionId,
        kind: snapshot.transaction.kind,
      });
    }
    const account = repo.findAccount(input.accountId);
    if (!account) throw notFound("Account", input.accountId);
    /*
     * The same guards `planCreateExpense` applies. Without them an edit could produce what a create
     * refuses: a negative amount balances perfectly while posting backwards, turning an expense
     * into money arriving, and a system account has no business paying for groceries.
     */
    if (!account.isUserVisible || (account.kind !== AccountKind.ASSET && account.kind !== AccountKind.LIABILITY)) {
      throw validationError("An expense must be paid from one of your own accounts", { account_id: account.id });
    }
    if (account.currency.code !== input.amount.currency.code) {
      throw validationError(
        `Paying account '${account.name}' holds ${account.currency.code} but the amount is ${input.amount.currency.code}`,
        { account_id: account.id },
      );
    }
    if (input.amount.minor <= 0n) {
      throw validationError("An expense must be a positive amount", { amount: input.amount.minor.toString() });
    }
    if (input.splits.length === 0) throw validationError("At least one category line is required");
    if (input.splits.some((split) => split.amount.minor <= 0n)) {
      throw validationError("Each split line must be a positive amount");
    }

    const splitTotal = input.splits.reduce((acc, s) => acc + s.amount.minor, 0n);
    if (splitTotal !== input.amount.minor) {
      throw validationError("Split lines must total the transaction amount");
    }

    const legs = [
      ...input.splits.map((split) => ({
        accountId: repo.categoryAccountFor(
          split.categoryId,
          input.amount.currency,
          AccountKind.EXPENSE,
          clock.now(),
        ),
        amountMinorSigned: split.amount.minor,
        categoryId: split.categoryId,
        memo: split.memo,
      })),
      { accountId: account.id, amountMinorSigned: -input.amount.minor },
    ];

    const plan = planEditFinancials(context, {
      snapshot,
      expectedRevision: input.expectedRevision,
      legs,
      amount: input.amount,
      occurredAt: input.occurredAt,
      merchantName: input.merchantName,
      categoryId: input.splits.length === 1 ? input.splits[0]?.categoryId : undefined,
      notes: input.notes,
      ...actorFields(write),
    });
    return commit(plan, "transaction.edit", input, write);
  }

  /**
   * Edits the financial fields of posted income: the mirror image of `editExpense`.
   *
   * buildspec.md §9.2, row 2: income debits the asset and credits the income category account, so
   * the replacement legs carry the opposite signs to an expense. The guards repeat what
   * `planCreateIncome` enforces, so an edit cannot produce a record a create would have refused —
   * in particular a negative amount, which would balance perfectly while posting backwards.
   */
  function editIncome(
    input: {
      transactionId: string;
      expectedRevision: number;
      accountId: string;
      amount: Money;
      occurredAt: FinancialTime;
      splits: readonly CategorySplit[];
      merchantName?: string | undefined;
      notes?: string | undefined;
    },
    write: WriteOptions = {},
  ) {
    const snapshot = repo.snapshotOf(input.transactionId);
    if (snapshot.transaction.kind !== TransactionKind.INCOME) {
      throw validationError("Only an income record can be edited as income", {
        transaction_id: input.transactionId,
        kind: snapshot.transaction.kind,
      });
    }

    const account = repo.findAccount(input.accountId);
    if (!account) throw notFound("Account", input.accountId);
    if (account.kind !== AccountKind.ASSET) {
      throw validationError(`Income must be received into an asset account, not a ${account.kind}`, {
        account_id: account.id,
      });
    }
    if (account.currency.code !== input.amount.currency.code) {
      throw validationError(
        `Receiving account '${account.name}' holds ${account.currency.code} but the amount is ` +
          `${input.amount.currency.code}`,
        { account_id: account.id },
      );
    }
    if (input.amount.minor <= 0n) {
      throw validationError("Income must be a positive amount", {
        amount: input.amount.minor.toString(),
      });
    }
    if (input.splits.length === 0) throw validationError("At least one category line is required");
    if (input.splits.some((split) => split.amount.minor <= 0n)) {
      throw validationError("Each split line must be a positive amount");
    }

    const splitTotal = input.splits.reduce((acc, s) => acc + s.amount.minor, 0n);
    if (splitTotal !== input.amount.minor) {
      throw validationError("Split lines must total the transaction amount");
    }

    const legs = [
      { accountId: account.id, amountMinorSigned: input.amount.minor },
      ...input.splits.map((split) => ({
        accountId: repo.categoryAccountFor(
          split.categoryId,
          input.amount.currency,
          AccountKind.INCOME,
          clock.now(),
        ),
        amountMinorSigned: -split.amount.minor,
        categoryId: split.categoryId,
        memo: split.memo,
      })),
    ];

    const plan = planEditFinancials(context, {
      snapshot,
      expectedRevision: input.expectedRevision,
      legs,
      amount: input.amount,
      occurredAt: input.occurredAt,
      merchantName: input.merchantName,
      categoryId: input.splits.length === 1 ? input.splits[0]?.categoryId : undefined,
      notes: input.notes,
      ...actorFields(write),
    });
    return commit(plan, "transaction.edit", input, write);
  }

  /** buildspec.md §13: normal deletion goes to Trash and explains its balance impact. */
  function deleteTransaction(
    input: { transactionId: string; expectedRevision: number },
    write: WriteOptions = {},
  ) {
    const snapshot = repo.snapshotOf(input.transactionId);
    const plan = planDeleteTransaction(context, {
      snapshot,
      expectedRevision: input.expectedRevision,
      ...actorFields(write),
    });
    return commit(plan, "transaction.delete", input, write);
  }

  function restoreTransaction(
    input: { transactionId: string; expectedRevision: number },
    write: WriteOptions = {},
  ) {
    const snapshot = repo.snapshotOf(input.transactionId);
    /*
     * Find the journal the deletion reversed so its effect can be re-applied. The deletion reversal
     * is the most recent journal on this transaction that names a target.
     */
    const reversalRow = db
      .prepare(
        `SELECT reverses_journal_id FROM journals
          WHERE transaction_id = ? AND purpose = 'deletion_reversal'
          ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get(input.transactionId) as Record<string, unknown> | undefined;
    if (!reversalRow) {
      throw validationError(
        "This transaction has no deletion to undo. It may never have carried a journal.",
        { transaction_id: input.transactionId },
      );
    }
    const reversedJournalId = asText(reversalRow.reverses_journal_id, "reverses_journal_id");
    const reversedJournal = repo.findJournal(reversedJournalId);
    if (!reversedJournal) throw notFound("Journal", reversedJournalId);

    const plan = planRestoreTransaction(context, {
      snapshot,
      reversedJournal,
      expectedRevision: input.expectedRevision,
      ...actorFields(write),
    });
    return commit(plan, "transaction.restore", input, write);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Queries                                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  /** buildspec.md §16: typed filters, stable sort, bounded page size (default 50, max 200). */
  function searchTransactions(filters: {
    from?: LocalDate | undefined;
    to?: LocalDate | undefined;
    accountId?: string | undefined;
    categoryId?: string | undefined;
    text?: string | undefined;
    status?: TransactionStatus | undefined;
    includeHistoryOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const where: string[] = ["r.revision = t.current_revision"];
    const params: unknown[] = [];

    where.push("t.status = ?");
    params.push(filters.status ?? TransactionStatus.POSTED);

    if (!filters.includeHistoryOnly) where.push("t.accounting_scope = 'ledger'");
    if (filters.from) {
      where.push("r.occurred_local_date >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      where.push("r.occurred_local_date <= ?");
      params.push(filters.to);
    }
    if (filters.categoryId) {
      where.push("r.category_id = ?");
      params.push(filters.categoryId);
    }
    if (filters.accountId) {
      where.push(
        `EXISTS (SELECT 1 FROM journal_entries e
                   JOIN journals j ON j.id = e.journal_id
                  WHERE j.transaction_id = t.id AND e.ledger_account_id = ?)`,
      );
      params.push(filters.accountId);
    }
    if (filters.text && filters.text.trim().length > 0) {
      where.push("(r.merchant_name LIKE ? OR r.notes LIKE ?)");
      const pattern = `%${filters.text.trim()}%`;
      params.push(pattern, pattern);
    }

    const rows = db
      .prepare(
        `SELECT t.id, t.kind, t.status, t.accounting_scope, t.current_revision,
                r.occurred_at, r.occurred_local_date, r.occurred_precision,
                r.merchant_name, r.category_id, r.display_amount_minor, r.currency, r.notes
           FROM transactions t
           JOIN transaction_revisions r ON r.transaction_id = t.id
          WHERE ${where.join(" AND ")}
          ORDER BY r.occurred_at DESC, t.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    return rows.map(
      (row): TransactionListItem => ({
        id: asText(row.id, "id"),
        kind: asText(row.kind, "kind"),
        status: asText(row.status, "status"),
        accountingScope: asText(row.accounting_scope, "accounting_scope"),
        revision: asNumber(row.current_revision, "current_revision"),
        occurredAt: asNumber(row.occurred_at, "occurred_at"),
        occurredLocalDate: asText(row.occurred_local_date, "occurred_local_date"),
        occurredPrecision: asText(row.occurred_precision, "occurred_precision"),
        merchantName: asOptionalText(row.merchant_name, "merchant_name"),
        categoryId: asOptionalText(row.category_id, "category_id"),
        amount: money(
          requireCurrency(asText(row.currency, "currency")),
          asBigInt(row.display_amount_minor, "display_amount_minor"),
        ),
        notes: asOptionalText(row.notes, "notes"),
      }),
    );
  }

  /**
   * Per-currency totals for the Accounts screen and Home.
   *
   * A credit line also reports what is left to spend. buildspec.md §10 keeps the limit out of the
   * balance itself — it is never summed with journal entries, and §12 excludes it from spendable
   * money — so it travels alongside rather than inside.
   */
  function accountBalances(options: { asOf?: Instant; includeArchived?: boolean } = {}) {
    return repo
      .listAccounts(options.includeArchived ? { includeArchived: true } : {})
      .map((account) => {
        const balance = repo.balanceOf(account.id, options.asOf);
        return {
          account,
          balance,
          available: availableCredit(account, balance),
          utilisation: creditUtilisation(account, balance),
        };
      });
  }

  /**
   * buildspec.md §13: Home shows "Liquid balance, amount owed". Net worth stays separate from
   * spendable money, and currencies are never summed together.
   */
  function homeTotals(asOf?: Instant) {
    const liquid = new Map<string, Money>();
    const owed = new Map<string, Money>();

    for (const { account, balance } of accountBalances(asOf === undefined ? {} : { asOf })) {
      if (account.kind === AccountKind.LIABILITY) {
        const running = owed.get(account.currency.code) ?? money(account.currency, 0n);
        owed.set(account.currency.code, money(account.currency, running.minor + balance.minor));
      } else if (account.liquidityRole === LiquidityRole.LIQUID) {
        const running = liquid.get(account.currency.code) ?? money(account.currency, 0n);
        liquid.set(account.currency.code, money(account.currency, running.minor + balance.minor));
      }
    }
    return { liquid, owed };
  }

  /** Net spending per category over a local-date window, excluding non-spending journals. */
  function spendingByCategory(from: LocalDate, to: LocalDate) {
    const rows = db
      .prepare(
        `SELECT e.category_id AS category_id, a.currency AS currency,
                SUM(e.amount_minor_signed) AS total
           FROM journal_entries e
           JOIN journals j ON j.id = e.journal_id
           JOIN ledger_accounts a ON a.id = e.ledger_account_id
           JOIN transactions t ON t.id = j.transaction_id
           JOIN transaction_revisions r
                ON r.transaction_id = t.id AND r.revision = t.current_revision
          WHERE a.kind = 'expense'
            AND j.state = 'posted'
            AND t.status = 'posted'
            AND t.accounting_scope = 'ledger'
            AND r.occurred_local_date BETWEEN ? AND ?
          GROUP BY e.category_id, a.currency
          HAVING SUM(e.amount_minor_signed) <> 0
          ORDER BY total DESC`,
      )
      .all(from, to) as Record<string, unknown>[];

    return rows.map((row) => ({
      categoryId: asOptionalText(row.category_id, "category_id") ?? "uncategorized",
      amount: money(
        requireCurrency(asText(row.currency, "currency")),
        asBigInt(row.total, "total"),
      ),
    }));
  }

  function getTransactionDetail(transactionId: string) {
    const snapshot = repo.snapshotOf(transactionId);
    const revisionRows = db
      .prepare(
        "SELECT * FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision DESC",
      )
      .all(transactionId) as Record<string, unknown>[];

    /*
     * The owner-facing accounts this record touches, with which way the money went. A record in
     * Trash owns no active journal — its deleted revision has no `journalId` — so fall back to the
     * journal the deletion reversed. Otherwise Trash could not say which account a restore would
     * put the money back into.
     */
    let accountJournal = snapshot.currentJournal;
    if (!accountJournal) {
      const reversalRow = db
        .prepare(
          `SELECT reverses_journal_id FROM journals
            WHERE transaction_id = ? AND purpose = 'deletion_reversal'
            ORDER BY recorded_at DESC LIMIT 1`,
        )
        .get(transactionId) as Record<string, unknown> | undefined;
      const reversedId = reversalRow
        ? asOptionalText(reversalRow.reverses_journal_id, "reverses_journal_id")
        : undefined;
      accountJournal = reversedId ? repo.findJournal(reversedId) : undefined;
    }

    const netByAccount = new Map<string, bigint>();
    for (const entry of accountJournal?.entries ?? []) {
      netByAccount.set(
        entry.accountId,
        (netByAccount.get(entry.accountId) ?? 0n) + entry.amountMinorSigned,
      );
    }
    const accounts: { id: string; name: string; direction: "in" | "out" }[] = [];
    for (const [accountId, net] of netByAccount) {
      const account = repo.findAccount(accountId);
      if (!account?.isUserVisible) continue;
      // Debit-positive: a debit is money arriving in an asset, or debt being paid down on a card.
      accounts.push({ id: account.id, name: account.name, direction: net >= 0n ? "in" : "out" });
    }

    return {
      transaction: snapshot.transaction,
      currentRevision: snapshot.currentRevision,
      journal: snapshot.currentJournal,
      revisionCount: revisionRows.length,
      accounts,
    };
  }

  return {
    repo,
    context,
    clock,
    zone,
    seedDefaultCategories,
    listCategories,
    createAccount,
    updateAccount,
    archiveAccount,
    unarchiveAccount,
    accountUsage,
    listAccounts: repo.listAccounts,
    findAccount: repo.findAccount,
    setOpeningBalance,
    createExpense,
    createIncome,
    createTransfer,
    createRefund,
    recordUnknownAdjustment,
    editExpense,
    editIncome,
    deleteTransaction,
    restoreTransaction,
    searchTransactions,
    accountBalances,
    homeTotals,
    spendingByCategory,
    getTransactionDetail,
    balanceOf: repo.balanceOf,
  };
}

function actorFields(write: WriteOptions) {
  return { actor: write.actor, origin: write.origin, reason: write.reason };
}

export type FinanceService = ReturnType<typeof createFinanceService>;
