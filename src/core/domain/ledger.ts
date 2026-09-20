import { notFound, unbalancedJournal, validationError } from "./errors.ts";
import type { Currency, Money } from "./money.ts";
import { formatMoney, money, zero } from "./money.ts";
import type { Instant } from "./time.ts";

/**
 * The double-entry ledger.
 *
 * buildspec.md §9.2: "Use a double-entry journal internally so transfers, debt, and corrections
 * remain consistent. The UI can still say 'Expense', 'Income', and 'Transfer'. Each posted journal
 * has at least two entries and sums to zero for each currency."
 *
 * `amountMinorSigned` is debit-positive and credit-negative. Posting code picks the signs; the
 * model never does (buildspec.md §1.1, §9.2).
 */

/* ------------------------------------------------------------------------------------------- */
/* Accounts                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export const AccountKind = {
  ASSET: "asset",
  LIABILITY: "liability",
  EXPENSE: "expense",
  INCOME: "income",
  EQUITY: "equity",
} as const;
export type AccountKind = (typeof AccountKind)[keyof typeof AccountKind];

/**
 * The owner-facing flavour of an account. Two accounts can share an [AccountKind] and still behave
 * very differently — a current account and a locked fixed deposit are both assets.
 */
export const AccountType = {
  BANK: "bank",
  CASH: "cash",
  WALLET: "wallet",
  CREDIT_CARD: "credit_card",
  SAVINGS: "savings",
  LOAN: "loan",
  /** Internal: the posting accounts behind expense/income category reporting. */
  CATEGORY_EXPENSE: "category_expense",
  CATEGORY_INCOME: "category_income",
  /** Internal: opening balances and reconciliation differences. */
  SYSTEM_EQUITY: "system_equity",
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

/**
 * How an account participates in the cash-flow projection.
 *
 * buildspec.md §12: forecasts use "Recorded liquid asset balances at an explicit cutoff, excluding
 * locked savings and credit limits."
 */
export const LiquidityRole = {
  /** Spendable today: current accounts, cash, wallets. */
  LIQUID: "liquid",
  /** Real money ring-fenced for a goal; excluded from spendable funds. */
  PROTECTED_SAVINGS: "protected_savings",
  /** Not reachable within the horizon: fixed deposits, locked instruments. */
  LOCKED: "locked",
  /** A credit line. Its limit is never a balance (buildspec.md §10). */
  CREDIT_LINE: "credit_line",
  /** Internal accounts that no cash-flow projection should read. */
  NOT_APPLICABLE: "not_applicable",
} as const;
export type LiquidityRole = (typeof LiquidityRole)[keyof typeof LiquidityRole];

export type LedgerAccount = {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly type: AccountType;
  readonly currency: Currency;
  readonly isUserVisible: boolean;
  readonly liquidityRole: LiquidityRole;
  readonly institution?: string | undefined;
  /** buildspec.md §9.4: the boundary before which imported rows stay history-only. */
  readonly trackingStartAt?: Instant | undefined;
  /**
   * buildspec.md §10: "A credit limit is not a balance." Stored beside the account, never summed
   * into one, and never counted as spendable money. Only meaningful on a credit line.
   */
  readonly creditLimit?: Money | undefined;
  readonly revision: number;
  readonly archivedAt?: Instant | undefined;
};

/**
 * What is left to spend on a credit line.
 *
 * `balance` is the displayed figure — positive when money is owed, negative when the card is in
 * credit. Available credit is therefore limit minus balance, and a card in credit has *more*
 * available than its limit, which is correct rather than a bug (buildspec.md §20: "Negative
 * credit-card balance | Display credit balance correctly; do not label it debt owed").
 *
 * Returns undefined when no limit is recorded, because guessing one would invent a number the
 * owner never supplied.
 */
export function availableCredit(account: LedgerAccount, balance: Money): Money | undefined {
  if (account.kind !== AccountKind.LIABILITY || !account.creditLimit) return undefined;
  if (account.creditLimit.currency.code !== balance.currency.code) return undefined;
  return money(account.creditLimit.currency, account.creditLimit.minor - balance.minor);
}

/**
 * How much of the limit is in use, 0-1, or undefined when there is no limit to compare against.
 * Clamped at zero so a card in credit reads as 0% rather than a negative percentage.
 */
export function creditUtilisation(account: LedgerAccount, balance: Money): number | undefined {
  if (account.kind !== AccountKind.LIABILITY || !account.creditLimit) return undefined;
  if (account.creditLimit.minor <= 0n) return undefined;
  const used = balance.minor <= 0n ? 0 : Number(balance.minor) / Number(account.creditLimit.minor);
  return Math.max(0, used);
}

/**
 * buildspec.md §9.2: "Expense accounts normally hold positive values; income and equity accounts
 * normally hold negative values."
 */
export function normalBalanceIsDebit(kind: AccountKind): boolean {
  return kind === AccountKind.ASSET || kind === AccountKind.EXPENSE;
}

export function isArchived(account: LedgerAccount): boolean {
  return account.archivedAt !== undefined && account.archivedAt !== null;
}

export function isLiquid(account: LedgerAccount): boolean {
  return account.liquidityRole === LiquidityRole.LIQUID && account.kind === AccountKind.ASSET;
}

export function isInternalType(type: AccountType): boolean {
  return (
    type === AccountType.CATEGORY_EXPENSE ||
    type === AccountType.CATEGORY_INCOME ||
    type === AccountType.SYSTEM_EQUITY
  );
}

/** Read side used by domain validation; implemented by the data layer and by test fakes. */
export type AccountLookup = {
  findAccount(id: string): LedgerAccount | undefined;
};

export function requireAccount(lookup: AccountLookup, id: string): LedgerAccount {
  const account = lookup.findAccount(id);
  if (!account) throw notFound("Ledger account", id);
  return account;
}

export function mapAccountLookup(accounts: Iterable<LedgerAccount>): AccountLookup & {
  all(): LedgerAccount[];
} {
  const byId = new Map<string, LedgerAccount>();
  for (const account of accounts) byId.set(account.id, account);
  return {
    findAccount: (id) => byId.get(id),
    all: () => [...byId.values()],
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Journals                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export const JournalPurpose = {
  /** The first financial record of a transaction. */
  ORIGINAL: "original",
  /** The corrected financial record written alongside a CORRECTION_REVERSAL. */
  REPLACEMENT: "replacement",
  /** Negates a previous journal because the owner edited the transaction. */
  CORRECTION_REVERSAL: "correction_reversal",
  /** Negates a previous journal because the transaction was deleted. */
  DELETION_REVERSAL: "deletion_reversal",
  /** buildspec.md §9.4: the starting-balance anchor. Not income. */
  OPENING_BALANCE: "opening_balance",
  /** buildspec.md §10: an unexplained difference posted against reconciliation equity. */
  RECONCILIATION_ADJUSTMENT: "reconciliation_adjustment",
  /** Negates a reconciliation adjustment once it is explained. */
  ADJUSTMENT_REVERSAL: "adjustment_reversal",
} as const;
export type JournalPurpose = (typeof JournalPurpose)[keyof typeof JournalPurpose];

export const JournalState = {
  DRAFT: "draft",
  POSTED: "posted",
} as const;
export type JournalState = (typeof JournalState)[keyof typeof JournalState];

/** Purposes that exist only to cancel another journal out. */
export function isReversalPurpose(purpose: JournalPurpose): boolean {
  return (
    purpose === JournalPurpose.CORRECTION_REVERSAL ||
    purpose === JournalPurpose.DELETION_REVERSAL ||
    purpose === JournalPurpose.ADJUSTMENT_REVERSAL
  );
}

export type JournalEntry = {
  readonly id: string;
  readonly accountId: string;
  /** Debit-positive, credit-negative, in the journal currency's minor units. */
  readonly amountMinorSigned: bigint;
  /** Present on entries that hit a category posting account, for reporting. */
  readonly categoryId?: string | undefined;
  readonly memo?: string | undefined;
};

export type Journal = {
  readonly id: string;
  readonly transactionId: string;
  readonly transactionRevision: number;
  readonly purpose: JournalPurpose;
  readonly currency: Currency;
  /** When the money actually moved (buildspec.md §9.1: effective financial time). */
  readonly effectiveAt: Instant;
  /** When this row was written (buildspec.md §9.3: separate from effective time). */
  readonly recordedAt: Instant;
  readonly state: JournalState;
  readonly reversesJournalId?: string | undefined;
  readonly actionId: string;
  readonly entries: readonly JournalEntry[];
};

/* ------------------------------------------------------------------------------------------- */
/* Validation                                                                                    */
/* ------------------------------------------------------------------------------------------- */

export type ValidateJournalOptions = {
  /**
   * buildspec.md §17.3: "Reject posting to an archived account unless a specific historical
   * correction flow permits it."
   */
  allowArchivedAccounts?: boolean;
};

/**
 * Enforces every per-journal invariant from buildspec.md §17.3.
 *
 * This is the single chokepoint every write path goes through — manual UI, import worker and agent
 * executor alike (buildspec.md §1: "Implement the same business rules for the manual UI, import
 * workers, and agent tools").
 */
export function validateJournal(
  journal: Journal,
  lookup: AccountLookup,
  options: ValidateJournalOptions = {},
): void {
  const { allowArchivedAccounts = false } = options;

  if (journal.entries.length < 2) {
    throw unbalancedJournal(
      `A journal needs at least two entries, got ${journal.entries.length}`,
      { journal_id: journal.id },
    );
  }

  let sum = 0n;
  const seenEntryIds = new Set<string>();

  for (const entry of journal.entries) {
    if (seenEntryIds.has(entry.id)) {
      throw validationError(`Duplicate journal entry id '${entry.id}'`, { journal_id: journal.id });
    }
    seenEntryIds.add(entry.id);

    if (entry.amountMinorSigned === 0n) {
      // A zero entry is either a bug or an attempt to pad a one-sided journal into looking valid.
      throw unbalancedJournal("Journal entries must be non-zero", {
        journal_id: journal.id,
        entry_id: entry.id,
      });
    }

    const account = requireAccount(lookup, entry.accountId);

    if (account.currency.code !== journal.currency.code) {
      // buildspec.md §17.3: "Reject a journal with mixed account currencies."
      throw validationError(
        `Entry posts ${account.currency.code} account '${account.name}' into a ` +
          `${journal.currency.code} journal`,
        {
          journal_id: journal.id,
          account_id: account.id,
          account_currency: account.currency.code,
          journal_currency: journal.currency.code,
        },
      );
    }

    if (!allowArchivedAccounts && isArchived(account)) {
      throw validationError(`Cannot post to archived account '${account.name}'`, {
        journal_id: journal.id,
        account_id: account.id,
      });
    }

    sum += entry.amountMinorSigned;
  }

  if (sum !== 0n) {
    throw unbalancedJournal(
      `Journal does not balance: entries sum to ${formatMoney(money(journal.currency, sum))}`,
      { journal_id: journal.id, residual: sum.toString(), currency: journal.currency.code },
    );
  }

  if (isReversalPurpose(journal.purpose) && !journal.reversesJournalId) {
    throw validationError(`A ${journal.purpose} journal must name the journal it reverses`, {
      journal_id: journal.id,
    });
  }
}

/**
 * Checks that a reversal exactly negates its target.
 *
 * buildspec.md §17.3: "Reversal entries must be exact negatives of the original entries." Merely
 * balancing to zero is not enough — a reversal that moved the money to a *different* account would
 * still balance while quietly corrupting per-account totals.
 */
export function validateReversal(reversal: Journal, original: Journal): void {
  if (reversal.reversesJournalId !== original.id) {
    throw validationError("Reversal does not point at the journal it is being checked against", {
      reversal_id: reversal.id,
      expected: original.id,
      actual: reversal.reversesJournalId ?? "none",
    });
  }
  if (reversal.currency.code !== original.currency.code) {
    throw validationError("Reversal currency differs from the original", {
      reversal_id: reversal.id,
    });
  }

  // Compare as multisets keyed by account+category: entry ids and ordering differ by construction.
  const tally = new Map<string, bigint>();
  const key = (entry: JournalEntry): string => `${entry.accountId}\u0000${entry.categoryId ?? ""}`;

  for (const entry of original.entries) {
    tally.set(key(entry), (tally.get(key(entry)) ?? 0n) + entry.amountMinorSigned);
  }
  for (const entry of reversal.entries) {
    tally.set(key(entry), (tally.get(key(entry)) ?? 0n) + entry.amountMinorSigned);
  }

  for (const [composite, residual] of tally) {
    if (residual !== 0n) {
      const accountId = composite.split("\u0000")[0] ?? "";
      throw unbalancedJournal(
        "Reversal is not an exact negative of the original journal",
        {
          reversal_id: reversal.id,
          original_id: original.id,
          account_id: accountId,
          residual: residual.toString(),
        },
      );
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Balances                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export type PostedEntry = {
  readonly accountId: string;
  readonly amountMinorSigned: bigint;
  readonly effectiveAt: Instant;
};

/**
 * The raw signed sum for an account.
 *
 * buildspec.md §9.3: "Balance queries sum all posted journal entries, including originals and
 * reversals." There is no soft-delete filter here on purpose — a deleted transaction is cancelled
 * by its reversal, not by being hidden from the sum.
 */
export function rawBalance(
  account: LedgerAccount,
  entries: Iterable<PostedEntry>,
  asOf?: Instant,
): Money {
  let total = 0n;
  for (const entry of entries) {
    if (entry.accountId !== account.id) continue;
    if (asOf !== undefined && entry.effectiveAt > asOf) continue;
    total += entry.amountMinorSigned;
  }
  return money(account.currency, total);
}

/**
 * The balance as the owner should see it.
 *
 * buildspec.md §9.2: "Asset balances use the sum; liability balances displayed as 'amount owed' use
 * the negative of the sum." buildspec.md §20 also requires a credit card in credit to display as a
 * credit balance rather than as debt, which falls out of returning a signed value here: a negative
 * result on a liability means the institution owes the owner.
 */
export function displayBalance(
  account: LedgerAccount,
  entries: Iterable<PostedEntry>,
  asOf?: Instant,
): Money {
  const raw = rawBalance(account, entries, asOf);
  if (account.kind === AccountKind.LIABILITY) {
    return money(account.currency, -raw.minor);
  }
  return raw;
}

/** Sums balances across accounts, keeping each currency separate (buildspec.md §9.1). */
export function balancesByCurrency(
  accounts: Iterable<LedgerAccount>,
  entries: Iterable<PostedEntry>,
  asOf?: Instant,
): Map<string, Money> {
  const materialised = [...entries];
  const totals = new Map<string, Money>();
  for (const account of accounts) {
    const balance = displayBalance(account, materialised, asOf);
    const running = totals.get(account.currency.code) ?? zero(account.currency);
    totals.set(account.currency.code, money(account.currency, running.minor + balance.minor));
  }
  return totals;
}

/** Flattens journals into the entry stream the balance functions consume. */
export function postedEntriesOf(journals: Iterable<Journal>): PostedEntry[] {
  const out: PostedEntry[] = [];
  for (const journal of journals) {
    if (journal.state !== JournalState.POSTED) continue;
    for (const entry of journal.entries) {
      out.push({
        accountId: entry.accountId,
        amountMinorSigned: entry.amountMinorSigned,
        effectiveAt: journal.effectiveAt,
      });
    }
  }
  return out;
}
