import { unsupported, validationError } from "./errors.ts";
import type { AccountLookup, Journal, JournalEntry, JournalPurpose, LedgerAccount } from "./ledger.ts";
import {
  AccountKind,
  JournalState,
  validateJournal,
  validateReversal,
  JournalPurpose as Purpose,
  isArchived,
  requireAccount,
} from "./ledger.ts";
import type { Currency, Money } from "./money.ts";
import { formatMoney, isPositive, sumMoney, zero } from "./money.ts";
import type { Clock, FinancialTime, Instant } from "./time.ts";
import type { Transaction, TransactionKind, TransactionRevision } from "./transaction.ts";
import { AccountingScope, TransactionStatus, TransactionKind as Kind } from "./transaction.ts";

/**
 * Turns owner intent into balanced journals.
 *
 * Everything here is a pure function: it reads a snapshot and returns a [PostingPlan] that the data
 * layer applies inside one database transaction. That is what lets buildspec.md §9.3's "All steps,
 * source links, bill allocations, revision increments, audit records, and derived-data invalidation
 * commit atomically" be enforced in exactly one place, and it keeps the rules testable without a
 * database (buildspec.md §1: the same rules serve the manual UI, the import workers and the agent).
 */

/* ------------------------------------------------------------------------------------------- */
/* Context                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/** Generates the opaque ids of buildspec.md §16. Injectable so fixtures stay deterministic. */
export type IdSource = {
  next(prefix: string): string;
};

/**
 * Resolves a user-facing category to its ledger posting account.
 *
 * buildspec.md §17.1: "Use `category_accounts` as the authoritative category-to-ledger mapping,
 * including when the owner currently uses only one currency."
 */
export type CategoryAccountResolver = {
  expenseAccountFor(categoryId: string, currency: Currency): string;
  incomeAccountFor(categoryId: string, currency: Currency): string;
};

/** The internal equity accounts that stay behind the UI (buildspec.md §9.2). */
export type SystemAccountResolver = {
  openingEquityFor(currency: Currency): string;
  reconciliationEquityFor(currency: Currency): string;
};

export type PostingContext = {
  readonly lookup: AccountLookup;
  readonly categories: CategoryAccountResolver;
  readonly system: SystemAccountResolver;
  readonly ids: IdSource;
  readonly clock: Clock;
};

/** Who caused a change, for the audit trail (buildspec.md §15). */
export const ActorKind = {
  OWNER: "owner",
  IMPORT: "import",
  AGENT: "agent",
  SYSTEM: "system",
  MIGRATION: "migration",
} as const;
export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

export type Actor = {
  readonly kind: ActorKind;
  readonly sessionId?: string | undefined;
  /** buildspec.md §14.1: endpoint/model/digest are recorded on every agent-caused change. */
  readonly modelIdentity?: string | undefined;
};

export const OWNER_ACTOR: Actor = Object.freeze({ kind: ActorKind.OWNER });

export type AuditEvent = {
  readonly actionId: string;
  readonly actor: Actor;
  /** Where the change entered the system, e.g. `ui.transactions.create`. */
  readonly origin: string;
  readonly entityRefs: readonly { type: string; id: string; revision?: number }[];
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string;
  readonly recordedAt: Instant;
};

/**
 * A complete, validated unit of financial change.
 *
 * The data layer writes every field of this atomically or writes none of it.
 */
export type PostingPlan = {
  readonly actionId: string;
  readonly journals: readonly Journal[];
  readonly transaction: Transaction;
  readonly revisions: readonly TransactionRevision[];
  readonly audit: AuditEvent;
};

/* ------------------------------------------------------------------------------------------- */
/* Leg helpers                                                                                   */
/* ------------------------------------------------------------------------------------------- */

/** One side of a journal before ids are assigned. Debit-positive, credit-negative. */
export type PostingLeg = {
  readonly accountId: string;
  readonly amountMinorSigned: bigint;
  readonly categoryId?: string | undefined;
  readonly memo?: string | undefined;
};

function buildJournal(
  context: PostingContext,
  params: {
    transactionId: string;
    transactionRevision: number;
    purpose: JournalPurpose;
    currency: Currency;
    effectiveAt: Instant;
    actionId: string;
    legs: readonly PostingLeg[];
    reversesJournalId?: string | undefined;
    allowArchivedAccounts?: boolean;
  },
): Journal {
  const journalId = context.ids.next("jrn");
  const entries: JournalEntry[] = params.legs.map((leg) => ({
    id: context.ids.next("ent"),
    accountId: leg.accountId,
    amountMinorSigned: leg.amountMinorSigned,
    categoryId: leg.categoryId,
    memo: leg.memo,
  }));

  const journal: Journal = {
    id: journalId,
    transactionId: params.transactionId,
    transactionRevision: params.transactionRevision,
    purpose: params.purpose,
    currency: params.currency,
    effectiveAt: params.effectiveAt,
    recordedAt: context.clock.now(),
    state: JournalState.POSTED,
    reversesJournalId: params.reversesJournalId,
    actionId: params.actionId,
    entries,
  };

  validateJournal(journal, context.lookup, {
    allowArchivedAccounts: params.allowArchivedAccounts ?? false,
  });
  return journal;
}

/**
 * Builds the exact negative of a journal.
 *
 * buildspec.md §17.3: "Reversal entries must be exact negatives of the original entries." Archived
 * accounts are permitted here because a correction to history must still be reversible after the
 * account was archived (buildspec.md §13: "Accounts with history are archived, not physically
 * removed").
 */
function buildReversal(
  context: PostingContext,
  original: Journal,
  params: {
    purpose: JournalPurpose;
    transactionRevision: number;
    actionId: string;
    effectiveAt?: Instant;
  },
): Journal {
  const reversal = buildJournal(context, {
    transactionId: original.transactionId,
    transactionRevision: params.transactionRevision,
    purpose: params.purpose,
    currency: original.currency,
    // buildspec.md §9.3: "Correcting historical data uses the original effective date for the
    // reversal/replacement when appropriate and today's `recorded_at`."
    effectiveAt: params.effectiveAt ?? original.effectiveAt,
    actionId: params.actionId,
    reversesJournalId: original.id,
    allowArchivedAccounts: true,
    legs: original.entries.map((entry) => ({
      accountId: entry.accountId,
      amountMinorSigned: -entry.amountMinorSigned,
      categoryId: entry.categoryId,
      memo: entry.memo,
    })),
  });
  validateReversal(reversal, original);
  return reversal;
}

function requirePositive(amount: Money, what: string): void {
  if (!isPositive(amount)) {
    // buildspec.md §7.3 requires a positive event amount; direction is expressed by the legs.
    throw validationError(`${what} must be a positive amount, got ${formatMoney(amount)}`, {
      amount: amount.minor.toString(),
    });
  }
}

function requireCurrencyMatch(account: LedgerAccount, amount: Money, role: string): void {
  if (account.currency.code !== amount.currency.code) {
    throw validationError(
      `${role} account '${account.name}' holds ${account.currency.code} but the amount is ` +
        `${amount.currency.code}`,
      { account_id: account.id },
    );
  }
}

function requireNotArchived(account: LedgerAccount): void {
  if (isArchived(account)) {
    throw validationError(
      `Account '${account.name}' is archived. Archived accounts keep their history but cannot ` +
        `receive new entries.`,
      { account_id: account.id },
    );
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Split lines                                                                                   */
/* ------------------------------------------------------------------------------------------- */

/**
 * One category line of an expense or income.
 *
 * buildspec.md §7.5: "Split transactions allocate exact minor units; sum of splits must equal the
 * total."
 */
export type CategorySplit = {
  readonly categoryId: string;
  readonly amount: Money;
  readonly memo?: string | undefined;
};

function validateSplits(splits: readonly CategorySplit[], total: Money): void {
  if (splits.length === 0) throw validationError("At least one category line is required");
  for (const split of splits) {
    requirePositive(split.amount, "Each split line");
    if (split.amount.currency.code !== total.currency.code) {
      throw validationError("Split lines must use the transaction currency", {
        split_currency: split.amount.currency.code,
        total_currency: total.currency.code,
      });
    }
  }
  const sum = sumMoney(
    splits.map((s) => s.amount),
    total.currency,
  );
  if (sum.minor !== total.minor) {
    throw validationError(
      `Split lines total ${formatMoney(sum)} but the transaction is ${formatMoney(total)}`,
      { splits_total: sum.minor.toString(), transaction_total: total.minor.toString() },
    );
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Create                                                                                        */
/* ------------------------------------------------------------------------------------------- */

export type CreateExpenseInput = {
  readonly accountId: string;
  readonly amount: Money;
  readonly occurredAt: FinancialTime;
  readonly splits: readonly CategorySplit[];
  readonly merchantId?: string | undefined;
  readonly merchantName?: string | undefined;
  readonly notes?: string | undefined;
  readonly accountingScope?: AccountingScope;
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
};

/**
 * buildspec.md §9.2, rows 1 and 5: a bank purchase debits the category expense account and credits
 * the bank asset; a credit-card purchase debits the same expense account and credits the card
 * liability, increasing debt. Both are the same shape, which is why one builder covers them.
 */
export function planCreateExpense(context: PostingContext, input: CreateExpenseInput): PostingPlan {
  const account = requireAccount(context.lookup, input.accountId);
  requirePositive(input.amount, "An expense");
  requireCurrencyMatch(account, input.amount, "Payment");
  requireNotArchived(account);
  validateSplits(input.splits, input.amount);

  if (account.kind !== AccountKind.ASSET && account.kind !== AccountKind.LIABILITY) {
    throw validationError(
      `An expense must be paid from an asset or credit account, not a ${account.kind} account`,
      { account_id: account.id },
    );
  }

  const legs: PostingLeg[] = input.splits.map((split) => ({
    accountId: context.categories.expenseAccountFor(split.categoryId, input.amount.currency),
    amountMinorSigned: split.amount.minor,
    categoryId: split.categoryId,
    memo: split.memo,
  }));
  legs.push({ accountId: account.id, amountMinorSigned: -input.amount.minor });

  return assemblePlan(context, {
    kind: Kind.EXPENSE,
    legs,
    input,
    defaultOrigin: "ui.transactions.create_expense",
    defaultReason: "Owner recorded an expense",
    categoryId: input.splits.length === 1 ? input.splits[0]?.categoryId : undefined,
  });
}

export type CreateIncomeInput = Omit<CreateExpenseInput, "splits"> & {
  readonly splits: readonly CategorySplit[];
};

/** buildspec.md §9.2, row 2: debit the asset, credit the income account. */
export function planCreateIncome(context: PostingContext, input: CreateIncomeInput): PostingPlan {
  const account = requireAccount(context.lookup, input.accountId);
  requirePositive(input.amount, "Income");
  requireCurrencyMatch(account, input.amount, "Receiving");
  requireNotArchived(account);
  validateSplits(input.splits, input.amount);

  if (account.kind !== AccountKind.ASSET) {
    throw validationError(`Income must be received into an asset account, not a ${account.kind}`, {
      account_id: account.id,
    });
  }

  const legs: PostingLeg[] = [
    { accountId: account.id, amountMinorSigned: input.amount.minor },
    ...input.splits.map((split) => ({
      accountId: context.categories.incomeAccountFor(split.categoryId, input.amount.currency),
      amountMinorSigned: -split.amount.minor,
      categoryId: split.categoryId,
      memo: split.memo,
    })),
  ];

  return assemblePlan(context, {
    kind: Kind.INCOME,
    legs,
    input,
    defaultOrigin: "ui.transactions.create_income",
    defaultReason: "Owner recorded income",
    categoryId: input.splits.length === 1 ? input.splits[0]?.categoryId : undefined,
  });
}

export type CreateTransferInput = {
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amount: Money;
  readonly occurredAt: FinancialTime;
  /**
   * buildspec.md §20: "Fee bundled with transfer | Separate fee and transfer entries with exact
   * total." The fee is charged to its own category rather than inflating the transferred amount.
   */
  readonly fee?: { readonly amount: Money; readonly categoryId: string } | undefined;
  readonly notes?: string | undefined;
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
};

/**
 * buildspec.md §9.2, rows 3 and 6: bank-to-cash is a transfer, and a card repayment is the same
 * shape — debiting a liability reduces the debt, so no second expense is created.
 */
export function planCreateTransfer(
  context: PostingContext,
  input: CreateTransferInput,
): PostingPlan {
  const from = requireAccount(context.lookup, input.fromAccountId);
  const to = requireAccount(context.lookup, input.toAccountId);
  requirePositive(input.amount, "A transfer");

  if (from.id === to.id) {
    throw validationError("A transfer needs two different accounts", { account_id: from.id });
  }
  /*
   * This check comes before the per-account currency checks on purpose. Otherwise moving LKR into a
   * USD account reports "the destination holds USD but the amount is LKR", which reads like the
   * owner picked the wrong amount, when the real answer is that the feature does not exist yet.
   * buildspec.md §17.3: "show an unsupported-operation message until implemented."
   */
  if (from.currency.code !== to.currency.code) {
    throw unsupported(
      `Cross-currency transfers are not supported yet (${from.currency.code} to ${to.currency.code}). ` +
        `Record them as one withdrawal and one deposit until the FX bridge exists.`,
      { from_currency: from.currency.code, to_currency: to.currency.code },
    );
  }

  requireCurrencyMatch(from, input.amount, "Source");
  requireCurrencyMatch(to, input.amount, "Destination");
  requireNotArchived(from);
  requireNotArchived(to);

  const legs: PostingLeg[] = [
    { accountId: to.id, amountMinorSigned: input.amount.minor },
    { accountId: from.id, amountMinorSigned: -input.amount.minor },
  ];

  if (input.fee) {
    requirePositive(input.fee.amount, "A fee");
    if (input.fee.amount.currency.code !== from.currency.code) {
      throw validationError("A transfer fee must use the source account currency");
    }
    legs.push({
      accountId: context.categories.expenseAccountFor(input.fee.categoryId, from.currency),
      amountMinorSigned: input.fee.amount.minor,
      categoryId: input.fee.categoryId,
      memo: "Transfer fee",
    });
    legs.push({ accountId: from.id, amountMinorSigned: -input.fee.amount.minor, memo: "Transfer fee" });
  }

  return assemblePlan(context, {
    kind: Kind.TRANSFER,
    legs,
    input: {
      accountId: from.id,
      amount: input.amount,
      occurredAt: input.occurredAt,
      notes: input.notes,
      actor: input.actor,
      origin: input.origin,
      reason: input.reason,
    },
    defaultOrigin: "ui.transactions.create_transfer",
    defaultReason: "Owner recorded a transfer",
  });
}

export type CreateRefundInput = {
  readonly accountId: string;
  readonly amount: Money;
  readonly occurredAt: FinancialTime;
  readonly categoryId: string;
  readonly merchantId?: string | undefined;
  readonly merchantName?: string | undefined;
  readonly notes?: string | undefined;
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
};

/**
 * buildspec.md §9.2, row 7: "Purchase refund LKR 500 | Bank/card account +50000 | Original expense
 * account −50000 | Reduces that expense; not salary."
 */
export function planCreateRefund(context: PostingContext, input: CreateRefundInput): PostingPlan {
  const account = requireAccount(context.lookup, input.accountId);
  requirePositive(input.amount, "A refund");
  requireCurrencyMatch(account, input.amount, "Refund destination");
  requireNotArchived(account);

  const legs: PostingLeg[] = [
    { accountId: account.id, amountMinorSigned: input.amount.minor },
    {
      accountId: context.categories.expenseAccountFor(input.categoryId, input.amount.currency),
      amountMinorSigned: -input.amount.minor,
      categoryId: input.categoryId,
      memo: "Refund",
    },
  ];

  return assemblePlan(context, {
    kind: Kind.REFUND,
    legs,
    input,
    defaultOrigin: "ui.transactions.create_refund",
    defaultReason: "Owner recorded a refund",
    categoryId: input.categoryId,
  });
}

export type OpeningBalanceInput = {
  readonly accountId: string;
  /** Signed as the owner sees it: positive cash on an asset, positive debt on a liability. */
  readonly amount: Money;
  readonly occurredAt: FinancialTime;
  readonly notes?: string | undefined;
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
};

/**
 * buildspec.md §9.2, row 9 and §9.4: "Opening bank balance LKR 80,000 | Bank asset +8000000 |
 * Opening equity −8000000 | Starting point, not income."
 */
export function planOpeningBalance(
  context: PostingContext,
  input: OpeningBalanceInput,
): PostingPlan {
  const account = requireAccount(context.lookup, input.accountId);
  requireCurrencyMatch(account, input.amount, "Opening");
  requireNotArchived(account);
  if (input.amount.minor === 0n) {
    throw validationError("An opening balance of zero needs no journal");
  }
  if (account.kind !== AccountKind.ASSET && account.kind !== AccountKind.LIABILITY) {
    throw validationError("Opening balances apply to asset and liability accounts only", {
      account_id: account.id,
    });
  }

  // A liability opening is entered as a positive amount owed, which credits the liability.
  const signedForAccount =
    account.kind === AccountKind.LIABILITY ? -input.amount.minor : input.amount.minor;

  const legs: PostingLeg[] = [
    { accountId: account.id, amountMinorSigned: signedForAccount, memo: "Opening balance" },
    {
      accountId: context.system.openingEquityFor(account.currency),
      amountMinorSigned: -signedForAccount,
      memo: "Opening balance",
    },
  ];

  return assemblePlan(context, {
    kind: Kind.OPENING_BALANCE,
    legs,
    input: { ...input, amount: input.amount },
    defaultOrigin: "ui.accounts.opening_balance",
    defaultReason: "Owner recorded a verified opening balance",
    purpose: Purpose.OPENING_BALANCE,
  });
}

export type UnknownAdjustmentInput = {
  readonly accountId: string;
  /**
   * The signed change to apply to the account's *displayed* balance. For an asset this is
   * `observed - recorded`; buildspec.md §10 flips the sign for a liability shown as amount owed.
   */
  readonly displayDelta: Money;
  readonly occurredAt: FinancialTime;
  readonly notes?: string | undefined;
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
};

/**
 * buildspec.md §9.2, row 8 and §10: an unexplained difference posts against reconciliation equity
 * and stays visible under "Unexplained differences". It is never guessed to be income or spending.
 */
export function planUnknownAdjustment(
  context: PostingContext,
  input: UnknownAdjustmentInput,
): PostingPlan {
  const account = requireAccount(context.lookup, input.accountId);
  requireCurrencyMatch(account, input.displayDelta, "Adjusted");
  if (input.displayDelta.minor === 0n) {
    throw validationError("There is no difference to adjust");
  }

  const signedForAccount =
    account.kind === AccountKind.LIABILITY ? -input.displayDelta.minor : input.displayDelta.minor;

  const legs: PostingLeg[] = [
    { accountId: account.id, amountMinorSigned: signedForAccount, memo: "Unknown adjustment" },
    {
      accountId: context.system.reconciliationEquityFor(account.currency),
      amountMinorSigned: -signedForAccount,
      memo: "Unknown adjustment",
    },
  ];

  return assemblePlan(context, {
    kind: Kind.UNKNOWN_ADJUSTMENT,
    legs,
    input: { ...input, amount: input.displayDelta },
    defaultOrigin: "ui.reconciliation.unknown_adjustment",
    defaultReason: "Owner confirmed an unexplained balance difference",
    purpose: Purpose.RECONCILIATION_ADJUSTMENT,
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Shared assembly                                                                               */
/* ------------------------------------------------------------------------------------------- */

type AssembleParams = {
  kind: TransactionKind;
  legs: readonly PostingLeg[];
  input: {
    accountId: string;
    amount: Money;
    occurredAt: FinancialTime;
    merchantId?: string | undefined;
    merchantName?: string | undefined;
    notes?: string | undefined;
    accountingScope?: AccountingScope | undefined;
    actor?: Actor | undefined;
    origin?: string | undefined;
    reason?: string | undefined;
  };
  defaultOrigin: string;
  defaultReason: string;
  categoryId?: string | undefined;
  purpose?: JournalPurpose | undefined;
};

function assemblePlan(context: PostingContext, params: AssembleParams): PostingPlan {
  const { input } = params;
  const now = context.clock.now();
  const actionId = context.ids.next("act");
  const transactionId = context.ids.next("txn");
  const scope = input.accountingScope ?? AccountingScope.LEDGER;

  /*
   * buildspec.md §9.4: "A record cannot simultaneously be history-only and have an active financial
   * journal." History-only rows exist for categorisation and estimates, so they carry a revision
   * with no journal at all.
   */
  const journals: Journal[] =
    scope === AccountingScope.HISTORY_ONLY
      ? []
      : [
          buildJournal(context, {
            transactionId,
            transactionRevision: 1,
            purpose: params.purpose ?? Purpose.ORIGINAL,
            currency: input.amount.currency,
            effectiveAt: input.occurredAt.instant,
            actionId,
            legs: params.legs,
          }),
        ];

  const transaction: Transaction = {
    id: transactionId,
    kind: params.kind,
    currentRevision: 1,
    accountingScope: scope,
    status: TransactionStatus.POSTED,
    createdAt: now,
    updatedAt: now,
  };

  const revision: TransactionRevision = {
    transactionId,
    revision: 1,
    occurredAt: input.occurredAt,
    merchantId: input.merchantId,
    merchantName: input.merchantName,
    categoryId: params.categoryId,
    displayAmount: input.amount,
    notes: input.notes,
    manualOverrideFields: [],
    journalId: journals[0]?.id,
    actionId,
    recordedAt: now,
  };

  return {
    actionId,
    journals,
    transaction,
    revisions: [revision],
    audit: {
      actionId,
      actor: input.actor ?? OWNER_ACTOR,
      origin: input.origin ?? params.defaultOrigin,
      entityRefs: [
        { type: "transaction", id: transactionId, revision: 1 },
        ...journals.map((j) => ({ type: "journal", id: j.id })),
      ],
      before: null,
      after: { transaction, revision: serialiseRevision(revision) },
      reason: input.reason ?? params.defaultReason,
      recordedAt: now,
    },
  };
}

function serialiseRevision(revision: TransactionRevision): Record<string, unknown> {
  return {
    transactionId: revision.transactionId,
    revision: revision.revision,
    occurredAt: revision.occurredAt,
    merchantName: revision.merchantName,
    categoryId: revision.categoryId,
    amount: {
      amount_minor: revision.displayAmount.minor.toString(),
      currency: revision.displayAmount.currency.code,
    },
    notes: revision.notes,
    journalId: revision.journalId,
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Edit, delete and restore                                                                      */
/* ------------------------------------------------------------------------------------------- */

/** The stored state a correction reads before proposing its change. */
export type TransactionSnapshot = {
  readonly transaction: Transaction;
  readonly currentRevision: TransactionRevision;
  /** The journal named by `currentRevision.journalId`, if the revision has one. */
  readonly currentJournal?: Journal | undefined;
};

export type EditFinancialsInput = {
  readonly snapshot: TransactionSnapshot;
  /** The replacement legs, already expressed in the new amount and accounts. */
  readonly legs: readonly PostingLeg[];
  readonly amount: Money;
  readonly occurredAt: FinancialTime;
  readonly merchantId?: string | undefined;
  readonly merchantName?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly notes?: string | undefined;
  readonly manualOverrideFields?: readonly string[];
  /** buildspec.md §16: financial writes check the expected record revision. */
  readonly expectedRevision: number;
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
};

/**
 * buildspec.md §9.3: "Editing a posted amount, account, currency, or effective date creates a
 * journal reversal and a replacement journal in one database transaction. The reversal negates the
 * exact original entries. The original stays posted; balances include it and its reversal."
 */
export function planEditFinancials(
  context: PostingContext,
  input: EditFinancialsInput,
): PostingPlan {
  const { snapshot } = input;
  assertEditable(snapshot, input.expectedRevision);

  const now = context.clock.now();
  const actionId = context.ids.next("act");
  const nextRevision = snapshot.transaction.currentRevision + 1;
  const journals: Journal[] = [];

  if (snapshot.currentJournal) {
    journals.push(
      buildReversal(context, snapshot.currentJournal, {
        purpose: Purpose.CORRECTION_REVERSAL,
        transactionRevision: nextRevision,
        actionId,
      }),
    );
  }

  const replacement = buildJournal(context, {
    transactionId: snapshot.transaction.id,
    transactionRevision: nextRevision,
    purpose: Purpose.REPLACEMENT,
    currency: input.amount.currency,
    effectiveAt: input.occurredAt.instant,
    actionId,
    legs: input.legs,
  });
  journals.push(replacement);

  const transaction: Transaction = {
    ...snapshot.transaction,
    currentRevision: nextRevision,
    updatedAt: now,
  };

  const revision: TransactionRevision = {
    transactionId: snapshot.transaction.id,
    revision: nextRevision,
    occurredAt: input.occurredAt,
    merchantId: input.merchantId,
    merchantName: input.merchantName,
    categoryId: input.categoryId,
    displayAmount: input.amount,
    notes: input.notes,
    manualOverrideFields: input.manualOverrideFields ?? snapshot.currentRevision.manualOverrideFields,
    journalId: replacement.id,
    actionId,
    recordedAt: now,
  };

  return {
    actionId,
    journals,
    transaction,
    revisions: [revision],
    audit: {
      actionId,
      actor: input.actor ?? OWNER_ACTOR,
      origin: input.origin ?? "ui.transactions.edit",
      entityRefs: [
        { type: "transaction", id: transaction.id, revision: nextRevision },
        ...journals.map((j) => ({ type: "journal", id: j.id })),
      ],
      before: { revision: serialiseRevision(snapshot.currentRevision) },
      after: { revision: serialiseRevision(revision) },
      reason: input.reason ?? "Owner corrected a transaction",
      recordedAt: now,
    },
  };
}

export type DeleteTransactionInput = {
  readonly snapshot: TransactionSnapshot;
  readonly expectedRevision: number;
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
};

/**
 * buildspec.md §9.3: "Deleting a posted transaction appends a reversal and a tombstone for the
 * logical record. Never remove its journal from balance calculations while also keeping its
 * reversal." The rows stay; Trash is what the owner sees (buildspec.md §13, §15).
 */
export function planDeleteTransaction(
  context: PostingContext,
  input: DeleteTransactionInput,
): PostingPlan {
  const { snapshot } = input;
  assertEditable(snapshot, input.expectedRevision);

  const now = context.clock.now();
  const actionId = context.ids.next("act");
  const nextRevision = snapshot.transaction.currentRevision + 1;
  const journals: Journal[] = [];

  if (snapshot.currentJournal) {
    journals.push(
      buildReversal(context, snapshot.currentJournal, {
        purpose: Purpose.DELETION_REVERSAL,
        transactionRevision: nextRevision,
        actionId,
      }),
    );
  }

  const transaction: Transaction = {
    ...snapshot.transaction,
    currentRevision: nextRevision,
    status: TransactionStatus.DELETED,
    deletedAt: now,
    updatedAt: now,
  };

  const revision: TransactionRevision = {
    ...snapshot.currentRevision,
    revision: nextRevision,
    // A deleted revision owns no active journal; the reversal is the financial record of removal.
    journalId: undefined,
    actionId,
    recordedAt: now,
  };

  return {
    actionId,
    journals,
    transaction,
    revisions: [revision],
    audit: {
      actionId,
      actor: input.actor ?? OWNER_ACTOR,
      origin: input.origin ?? "ui.transactions.delete",
      entityRefs: [
        { type: "transaction", id: transaction.id, revision: nextRevision },
        ...journals.map((j) => ({ type: "journal", id: j.id })),
      ],
      before: { status: snapshot.transaction.status, revision: serialiseRevision(snapshot.currentRevision) },
      after: { status: TransactionStatus.DELETED },
      reason: input.reason ?? "Owner moved a transaction to Trash",
      recordedAt: now,
    },
  };
}

export type RestoreTransactionInput = {
  readonly snapshot: TransactionSnapshot;
  /** The journal that the deletion reversed, so its effect can be re-applied. */
  readonly reversedJournal: Journal;
  readonly expectedRevision: number;
  readonly actor?: Actor;
  readonly origin?: string;
  readonly reason?: string;
};

/**
 * buildspec.md §15: "Undoing that deletion restores its effect with a new revision." The original
 * rows are never resurrected — a fresh journal re-applies the effect, so the audit trail keeps
 * showing what happened in order.
 */
export function planRestoreTransaction(
  context: PostingContext,
  input: RestoreTransactionInput,
): PostingPlan {
  const { snapshot } = input;
  if (snapshot.transaction.status !== TransactionStatus.DELETED) {
    throw validationError("Only a deleted transaction can be restored", {
      transaction_id: snapshot.transaction.id,
      status: snapshot.transaction.status,
    });
  }
  assertRevisionMatch(snapshot, input.expectedRevision);

  const now = context.clock.now();
  const actionId = context.ids.next("act");
  const nextRevision = snapshot.transaction.currentRevision + 1;

  const replacement = buildJournal(context, {
    transactionId: snapshot.transaction.id,
    transactionRevision: nextRevision,
    purpose: Purpose.REPLACEMENT,
    currency: input.reversedJournal.currency,
    effectiveAt: input.reversedJournal.effectiveAt,
    actionId,
    allowArchivedAccounts: true,
    legs: input.reversedJournal.entries.map((entry) => ({
      accountId: entry.accountId,
      amountMinorSigned: entry.amountMinorSigned,
      categoryId: entry.categoryId,
      memo: entry.memo,
    })),
  });

  const transaction: Transaction = {
    ...snapshot.transaction,
    currentRevision: nextRevision,
    status: TransactionStatus.POSTED,
    deletedAt: undefined,
    updatedAt: now,
  };

  const revision: TransactionRevision = {
    ...snapshot.currentRevision,
    revision: nextRevision,
    journalId: replacement.id,
    actionId,
    recordedAt: now,
  };

  return {
    actionId,
    journals: [replacement],
    transaction,
    revisions: [revision],
    audit: {
      actionId,
      actor: input.actor ?? OWNER_ACTOR,
      origin: input.origin ?? "ui.trash.restore",
      entityRefs: [
        { type: "transaction", id: transaction.id, revision: nextRevision },
        { type: "journal", id: replacement.id },
      ],
      before: { status: TransactionStatus.DELETED },
      after: { status: TransactionStatus.POSTED },
      reason: input.reason ?? "Owner restored a transaction from Trash",
      recordedAt: now,
    },
  };
}

function assertEditable(snapshot: TransactionSnapshot, expectedRevision: number): void {
  if (snapshot.transaction.status === TransactionStatus.DELETED) {
    throw validationError("This transaction is in Trash. Restore it before editing.", {
      transaction_id: snapshot.transaction.id,
    });
  }
  if (snapshot.transaction.status === TransactionStatus.MERGED) {
    throw validationError("This transaction was merged into another record. Edit the survivor.", {
      transaction_id: snapshot.transaction.id,
      merged_into: snapshot.transaction.mergedIntoId ?? "",
    });
  }
  assertRevisionMatch(snapshot, expectedRevision);
}

function assertRevisionMatch(snapshot: TransactionSnapshot, expectedRevision: number): void {
  if (snapshot.transaction.currentRevision !== expectedRevision) {
    // buildspec.md §20: "Record changes while a confirmation is open | Reject stale proposal and
    // show a fresh preview."
    throw validationError(
      `This record changed since it was loaded (expected revision ${expectedRevision}, ` +
        `found ${snapshot.transaction.currentRevision}). Reload and try again.`,
      {
        transaction_id: snapshot.transaction.id,
        expected_revision: String(expectedRevision),
        actual_revision: String(snapshot.transaction.currentRevision),
      },
    );
  }
}

/** Convenience for tests and previews: the net effect of a plan on one account. */
export function planEffectOnAccount(plan: PostingPlan, account: LedgerAccount): Money {
  let total = zero(account.currency);
  for (const journal of plan.journals) {
    for (const entry of journal.entries) {
      if (entry.accountId !== account.id) continue;
      total = { currency: account.currency, minor: total.minor + entry.amountMinorSigned };
    }
  }
  return account.kind === AccountKind.LIABILITY
    ? { currency: account.currency, minor: -total.minor }
    : total;
}
