import type { Journal, LedgerAccount, PostedEntry } from "./ledger.ts";
import {
  AccountKind,
  AccountType,
  LiquidityRole,
  displayBalance,
  postedEntriesOf,
} from "./ledger.ts";
import type { Currency, Money } from "./money.ts";
import { LKR, money, zero } from "./money.ts";
import type { IdSource, PostingContext, PostingPlan, TransactionSnapshot } from "./posting.ts";
import type { Clock, Instant } from "./time.ts";
import { SUGGESTED_DEFAULT_ZONE, fixedClock, fromIso } from "./time.ts";
import type { Transaction, TransactionRevision } from "./transaction.ts";
import { TransactionStatus } from "./transaction.ts";

/**
 * An in-memory ledger for domain tests and previews.
 *
 * This deliberately mirrors what the SQLite layer does when it applies a [PostingPlan] — append
 * journals, replace the transaction row, append a revision — so the invariant tests exercise the
 * real posting rules without needing a database. The SQLite repository has its own tests that
 * prove it applies plans the same way.
 */

export const TEST_EPOCH: Instant = fromIso("2026-09-20T12:00:00+05:30");

/** Deterministic ids so fixture expectations can be written down literally. */
export function sequentialIds(): IdSource {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${next}`;
    },
  };
}

export type TestLedger = {
  readonly context: PostingContext;
  readonly clock: Clock & { set(instant: Instant): void; advanceMs(ms: number): void };
  account(input: {
    id: string;
    name?: string;
    kind: AccountKind;
    type: AccountType;
    currency?: Currency;
    liquidityRole?: LiquidityRole;
    archivedAt?: Instant;
  }): LedgerAccount;
  apply(plan: PostingPlan): PostingPlan;
  journals(): readonly Journal[];
  entries(): PostedEntry[];
  balance(accountId: string, asOf?: Instant): Money;
  /** Net spending recorded against a category, after refunds and corrections. */
  categoryNet(categoryId: string, currency?: Currency): Money;
  snapshot(transactionId: string): TransactionSnapshot;
  transaction(transactionId: string): Transaction;
  journalById(journalId: string): Journal;
  /** Every posted journal sums to zero per currency; throws with detail if not. */
  assertBalanced(): void;
};

export function createTestLedger(startAt: Instant = TEST_EPOCH): TestLedger {
  const accounts = new Map<string, LedgerAccount>();
  const journals: Journal[] = [];
  const transactions = new Map<string, Transaction>();
  const revisions = new Map<string, TransactionRevision[]>();
  const clock = fixedClock(startAt, SUGGESTED_DEFAULT_ZONE);
  const ids = sequentialIds();

  const lookup = {
    findAccount: (id: string): LedgerAccount | undefined => accounts.get(id),
  };

  /** Category posting accounts are created on demand, mirroring `category_accounts` (§17.1). */
  function categoryAccount(
    categoryId: string,
    currency: Currency,
    kind: typeof AccountKind.EXPENSE | typeof AccountKind.INCOME,
  ): string {
    const prefix = kind === AccountKind.EXPENSE ? "catexp" : "catinc";
    const id = `${prefix}_${categoryId}_${currency.code}`;
    if (!accounts.has(id)) {
      accounts.set(id, {
        id,
        name: `${categoryId} (${currency.code})`,
        kind,
        type: kind === AccountKind.EXPENSE ? AccountType.CATEGORY_EXPENSE : AccountType.CATEGORY_INCOME,
        currency,
        isUserVisible: false,
        liquidityRole: LiquidityRole.NOT_APPLICABLE,
        revision: 1,
      });
    }
    return id;
  }

  function systemAccount(role: "opening" | "reconciliation", currency: Currency): string {
    const id = `sys_${role}_${currency.code}`;
    if (!accounts.has(id)) {
      accounts.set(id, {
        id,
        name: role === "opening" ? `Opening equity (${currency.code})` : `Reconciliation equity (${currency.code})`,
        kind: AccountKind.EQUITY,
        type: AccountType.SYSTEM_EQUITY,
        currency,
        isUserVisible: false,
        liquidityRole: LiquidityRole.NOT_APPLICABLE,
        revision: 1,
      });
    }
    return id;
  }

  const context: PostingContext = {
    lookup,
    ids,
    clock,
    categories: {
      expenseAccountFor: (categoryId, currency) =>
        categoryAccount(categoryId, currency, AccountKind.EXPENSE),
      incomeAccountFor: (categoryId, currency) =>
        categoryAccount(categoryId, currency, AccountKind.INCOME),
    },
    system: {
      openingEquityFor: (currency) => systemAccount("opening", currency),
      reconciliationEquityFor: (currency) => systemAccount("reconciliation", currency),
    },
  };

  const ledger: TestLedger = {
    context,
    clock,

    account(input) {
      const account: LedgerAccount = {
        id: input.id,
        name: input.name ?? input.id,
        kind: input.kind,
        type: input.type,
        currency: input.currency ?? LKR,
        isUserVisible: !(
          input.type === AccountType.CATEGORY_EXPENSE ||
          input.type === AccountType.CATEGORY_INCOME ||
          input.type === AccountType.SYSTEM_EQUITY
        ),
        liquidityRole:
          input.liquidityRole ??
          (input.kind === AccountKind.ASSET ? LiquidityRole.LIQUID : LiquidityRole.NOT_APPLICABLE),
        revision: 1,
        archivedAt: input.archivedAt,
      };
      accounts.set(account.id, account);
      return account;
    },

    apply(plan) {
      for (const journal of plan.journals) journals.push(journal);
      transactions.set(plan.transaction.id, plan.transaction);
      const history = revisions.get(plan.transaction.id) ?? [];
      revisions.set(plan.transaction.id, [...history, ...plan.revisions]);
      return plan;
    },

    journals: () => journals,
    entries: () => postedEntriesOf(journals),

    balance(accountId, asOf) {
      const account = accounts.get(accountId);
      if (!account) throw new Error(`Unknown account '${accountId}' in test ledger`);
      return displayBalance(account, postedEntriesOf(journals), asOf);
    },

    categoryNet(categoryId, currency = LKR) {
      const accountId = categoryAccount(categoryId, currency, AccountKind.EXPENSE);
      const account = accounts.get(accountId)!;
      return displayBalance(account, postedEntriesOf(journals));
    },

    snapshot(transactionId) {
      const transaction = transactions.get(transactionId);
      if (!transaction) throw new Error(`Unknown transaction '${transactionId}' in test ledger`);
      const history = revisions.get(transactionId) ?? [];
      const current = history.find((r) => r.revision === transaction.currentRevision);
      if (!current) throw new Error(`Transaction '${transactionId}' has no current revision`);
      const journal = current.journalId
        ? journals.find((j) => j.id === current.journalId)
        : undefined;
      return { transaction, currentRevision: current, currentJournal: journal };
    },

    transaction(transactionId) {
      const found = transactions.get(transactionId);
      if (!found) throw new Error(`Unknown transaction '${transactionId}' in test ledger`);
      return found;
    },

    journalById(journalId) {
      const found = journals.find((j) => j.id === journalId);
      if (!found) throw new Error(`Unknown journal '${journalId}' in test ledger`);
      return found;
    },

    assertBalanced() {
      for (const journal of journals) {
        let sum = 0n;
        for (const entry of journal.entries) sum += entry.amountMinorSigned;
        if (sum !== 0n) {
          throw new Error(
            `Journal ${journal.id} (${journal.purpose}) does not balance: residual ${sum}`,
          );
        }
      }
      // Across the whole book every currency must also net to zero.
      const perCurrency = new Map<string, bigint>();
      for (const journal of journals) {
        for (const entry of journal.entries) {
          perCurrency.set(
            journal.currency.code,
            (perCurrency.get(journal.currency.code) ?? 0n) + entry.amountMinorSigned,
          );
        }
      }
      for (const [code, residual] of perCurrency) {
        if (residual !== 0n) {
          throw new Error(`Book does not balance in ${code}: residual ${residual}`);
        }
      }
    },
  };

  return ledger;
}

/** Sets up the account shape used by most fixtures: a bank, cash and a credit card in LKR. */
export function standardAccounts(ledger: TestLedger): {
  bank: LedgerAccount;
  cash: LedgerAccount;
  card: LedgerAccount;
} {
  return {
    bank: ledger.account({
      id: "acct_bank",
      name: "Everyday bank",
      kind: AccountKind.ASSET,
      type: AccountType.BANK,
    }),
    cash: ledger.account({
      id: "acct_cash",
      name: "Cash wallet",
      kind: AccountKind.ASSET,
      type: AccountType.CASH,
    }),
    card: ledger.account({
      id: "acct_card",
      name: "Credit card",
      kind: AccountKind.LIABILITY,
      type: AccountType.CREDIT_CARD,
      liquidityRole: LiquidityRole.CREDIT_LINE,
    }),
  };
}

export function lkr(majorWhole: number, minorPart = 0): Money {
  const sign = majorWhole < 0 || Object.is(majorWhole, -0) ? -1n : 1n;
  const whole = BigInt(Math.abs(majorWhole));
  return money(LKR, sign * (whole * 100n + BigInt(Math.abs(minorPart))));
}

export const ZERO_LKR = zero(LKR);

/** True when a transaction is currently visible in the ledger (not trashed or merged). */
export function isVisible(transaction: Transaction): boolean {
  return transaction.status === TransactionStatus.POSTED;
}
