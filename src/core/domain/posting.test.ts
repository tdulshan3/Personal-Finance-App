import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { FinanceErrorCode, isFinanceError } from "./errors.ts";
import { AccountKind, AccountType, validateJournal } from "./ledger.ts";
import { formatMoney } from "./money.ts";
import {
  planCreateExpense,
  planCreateIncome,
  planCreateRefund,
  planCreateTransfer,
  planDeleteTransaction,
  planEditFinancials,
  planOpeningBalance,
  planRestoreTransaction,
  planUnknownAdjustment,
} from "./posting.ts";
import { createTestLedger, lkr, standardAccounts } from "./test-support.ts";
import { dateOnlyTime, exactTime } from "./time.ts";
import { AccountingScope, TransactionStatus } from "./transaction.ts";

const ZONE = "Asia/Colombo";
const AT = (date: string) => dateOnlyTime(date, ZONE);

function expectError(code: FinanceErrorCode, fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    assert.ok(isFinanceError(error), `expected a FinanceError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  assert.fail(`expected ${code} but nothing was thrown`);
}

/* ============================================================================================ */
/* buildspec.md §22 required fixture scenarios                                                   */
/* ============================================================================================ */

describe("§22 fixture: opening bank 100,000; purchase 3,450", () => {
  test("bank falls to 96,550 and groceries shows 3,450", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);

    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(100_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(3_450),
        occurredAt: AT("2026-09-20"),
        merchantName: "Keells Super",
        splits: [{ categoryId: "groceries", amount: lkr(3_450) }],
      }),
    );

    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 96,550.00");
    assert.equal(formatMoney(ledger.categoryNet("groceries")), "LKR 3,450.00");
    ledger.assertBalanced();
  });

  // buildspec.md §9.4: an opening balance is "Starting point, not income."
  test("the opening balance is equity, not income", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    const plan = ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(100_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    const equityLeg = plan.journals[0]!.entries.find((e) => e.accountId !== bank.id)!;
    const equityAccount = ledger.context.lookup.findAccount(equityLeg.accountId)!;
    assert.equal(equityAccount.kind, AccountKind.EQUITY);
    assert.equal(equityAccount.type, AccountType.SYSTEM_EQUITY);
  });
});

describe("§22 fixture: salary 100,000; bank to cash 4,000; fee 250", () => {
  test("income is 100,000, only the 250 fee is spending, and assets are conserved otherwise", () => {
    const ledger = createTestLedger();
    const { bank, cash } = standardAccounts(ledger);

    ledger.apply(
      planCreateIncome(ledger.context, {
        accountId: bank.id,
        amount: lkr(100_000),
        occurredAt: AT("2026-09-01"),
        merchantName: "Employer",
        splits: [{ categoryId: "income", amount: lkr(100_000) }],
      }),
    );
    ledger.apply(
      planCreateTransfer(ledger.context, {
        fromAccountId: bank.id,
        toAccountId: cash.id,
        amount: lkr(4_000),
        occurredAt: AT("2026-09-10"),
        fee: { amount: lkr(250), categoryId: "fees" },
      }),
    );

    // buildspec.md §9.2 row 4: the withdrawal moves money, only the fee is spending.
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 95,750.00");
    assert.equal(formatMoney(ledger.balance(cash.id)), "LKR 4,000.00");
    assert.equal(formatMoney(ledger.categoryNet("fees")), "LKR 250.00");

    // Total assets fell by exactly the fee, not by the transferred amount.
    const totalAssets = ledger.balance(bank.id).minor + ledger.balance(cash.id).minor;
    assert.equal(totalAssets, 99_750_00n);
    ledger.assertBalanced();
  });

  test("a transfer with no fee conserves total assets exactly", () => {
    const ledger = createTestLedger();
    const { bank, cash } = standardAccounts(ledger);
    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(50_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    const before = ledger.balance(bank.id).minor + ledger.balance(cash.id).minor;
    ledger.apply(
      planCreateTransfer(ledger.context, {
        fromAccountId: bank.id,
        toAccountId: cash.id,
        amount: lkr(4_000),
        occurredAt: AT("2026-09-10"),
      }),
    );
    const after = ledger.balance(bank.id).minor + ledger.balance(cash.id).minor;
    assert.equal(after, before, "a transfer must not create or destroy money");
  });
});

describe("§22 fixture: card purchase 3,450 then repayment", () => {
  test("spending counts once, debt returns to zero, and the bank falls by 3,450", () => {
    const ledger = createTestLedger();
    const { bank, card } = standardAccounts(ledger);

    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(100_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: card.id,
        amount: lkr(3_450),
        occurredAt: AT("2026-09-05"),
        merchantName: "Keells Super",
        splits: [{ categoryId: "groceries", amount: lkr(3_450) }],
      }),
    );

    // buildspec.md §9.2 row 5: expense now, debt increases.
    assert.equal(formatMoney(ledger.balance(card.id)), "LKR 3,450.00", "amount owed");
    assert.equal(formatMoney(ledger.categoryNet("groceries")), "LKR 3,450.00");

    // buildspec.md §9.2 row 6: repayment is a cash outflow, not a second expense.
    ledger.apply(
      planCreateTransfer(ledger.context, {
        fromAccountId: bank.id,
        toAccountId: card.id,
        amount: lkr(3_450),
        occurredAt: AT("2026-09-25"),
      }),
    );

    assert.equal(formatMoney(ledger.balance(card.id)), "LKR 0.00", "debt cleared");
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 96,550.00");
    assert.equal(
      formatMoney(ledger.categoryNet("groceries")),
      "LKR 3,450.00",
      "repayment must not double-count spending",
    );
    ledger.assertBalanced();
  });

  // buildspec.md §20: "Negative credit-card balance | Display credit balance correctly; do not
  // label it debt owed."
  test("overpaying a card shows a credit balance, not debt", () => {
    const ledger = createTestLedger();
    const { bank, card } = standardAccounts(ledger);
    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(10_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    ledger.apply(
      planCreateTransfer(ledger.context, {
        fromAccountId: bank.id,
        toAccountId: card.id,
        amount: lkr(1_000),
        occurredAt: AT("2026-09-05"),
      }),
    );
    const owed = ledger.balance(card.id);
    assert.equal(owed.minor < 0n, true, "a negative amount owed is a credit balance");
    assert.equal(formatMoney(owed), "LKR -1,000.00");
  });
});

describe("§22 fixture: partial refund 500", () => {
  test("net category spending falls by 500 and the account is credited", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);

    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(100_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(3_450),
        occurredAt: AT("2026-09-05"),
        splits: [{ categoryId: "groceries", amount: lkr(3_450) }],
      }),
    );
    ledger.apply(
      planCreateRefund(ledger.context, {
        accountId: bank.id,
        amount: lkr(500),
        occurredAt: AT("2026-09-07"),
        categoryId: "groceries",
      }),
    );

    // buildspec.md §9.2 row 7: reduces that expense, not salary.
    assert.equal(formatMoney(ledger.categoryNet("groceries")), "LKR 2,950.00");
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 97,050.00");
    ledger.assertBalanced();
  });
});

describe("§22 fixture: balance 84,250 vs 80,000", () => {
  test("an unknown decrease of 4,250 reconciles without touching the expense report", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);

    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(84_250),
        occurredAt: AT("2026-09-01"),
      }),
    );
    ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(1_000),
        occurredAt: AT("2026-09-02"),
        splits: [{ categoryId: "groceries", amount: lkr(1_000) }],
      }),
    );
    const groceriesBefore = ledger.categoryNet("groceries");
    const recorded = ledger.balance(bank.id);
    assert.equal(formatMoney(recorded), "LKR 83,250.00");

    // The owner confirms a real ledger balance of 80,000: delta = observed - recorded.
    const observed = lkr(80_000);
    const delta = { currency: observed.currency, minor: observed.minor - recorded.minor };
    assert.equal(delta.minor, -3_250_00n);

    ledger.apply(
      planUnknownAdjustment(ledger.context, {
        accountId: bank.id,
        displayDelta: delta,
        occurredAt: exactTime(ledger.clock.now(), ZONE),
      }),
    );

    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 80,000.00");
    assert.deepEqual(
      ledger.categoryNet("groceries"),
      groceriesBefore,
      "an unknown adjustment must not appear as ordinary spending",
    );
    ledger.assertBalanced();
  });

  // buildspec.md §20: "Positive unexplained difference | Equity adjustment, not assumed salary or
  // income."
  test("a positive difference posts to equity, never to income", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(80_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    const plan = ledger.apply(
      planUnknownAdjustment(ledger.context, {
        accountId: bank.id,
        displayDelta: lkr(5_000),
        occurredAt: exactTime(ledger.clock.now(), ZONE),
      }),
    );
    const counterLeg = plan.journals[0]!.entries.find((e) => e.accountId !== bank.id)!;
    const counterAccount = ledger.context.lookup.findAccount(counterLeg.accountId)!;
    assert.equal(counterAccount.kind, AccountKind.EQUITY);
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 85,000.00");
  });
});

describe("§22 fixture: start today at 80,000; import older spending 20,000", () => {
  // buildspec.md §9.4: history-only records "prevent them from being added again to today's balance".
  test("history-only imports do not move the current balance", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);

    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(80_000),
        occurredAt: AT("2026-09-20"),
      }),
    );

    const historical = ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(20_000),
        occurredAt: AT("2026-05-14"),
        splits: [{ categoryId: "shopping", amount: lkr(20_000) }],
        accountingScope: AccountingScope.HISTORY_ONLY,
      }),
    );

    assert.equal(historical.journals.length, 0, "history-only records carry no journal");
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 80,000.00");
    assert.equal(
      historical.transaction.accountingScope,
      AccountingScope.HISTORY_ONLY,
      "the record still exists for categorisation and estimates",
    );
    assert.equal(historical.revisions[0]!.journalId, undefined);
    ledger.assertBalanced();
  });
});

/* ============================================================================================ */
/* Corrections: edit, delete, restore (buildspec.md §9.3, §15)                                   */
/* ============================================================================================ */

describe("editing a posted transaction", () => {
  test("appends a reversal and a replacement, leaving balances correct", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(100_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    const created = ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(3_450),
        occurredAt: AT("2026-09-05"),
        splits: [{ categoryId: "groceries", amount: lkr(3_450) }],
      }),
    );
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 96,550.00");

    const snapshot = ledger.snapshot(created.transaction.id);
    const groceriesAccount = snapshot.currentJournal!.entries.find(
      (e) => e.accountId !== bank.id,
    )!.accountId;

    const edited = ledger.apply(
      planEditFinancials(ledger.context, {
        snapshot,
        expectedRevision: 1,
        amount: lkr(4_000),
        occurredAt: AT("2026-09-05"),
        categoryId: "groceries",
        legs: [
          { accountId: groceriesAccount, amountMinorSigned: 400_000n, categoryId: "groceries" },
          { accountId: bank.id, amountMinorSigned: -400_000n },
        ],
      }),
    );

    assert.equal(edited.journals.length, 2, "one reversal plus one replacement");
    assert.equal(edited.journals[0]!.purpose, "correction_reversal");
    assert.equal(edited.journals[1]!.purpose, "replacement");
    assert.equal(edited.transaction.currentRevision, 2);

    // buildspec.md §9.3: balances include the original and its reversal.
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 96,000.00");
    assert.equal(formatMoney(ledger.categoryNet("groceries")), "LKR 4,000.00");
    ledger.assertBalanced();
  });

  // buildspec.md §20: "Record changes while a confirmation is open | Reject stale proposal".
  test("a stale expected revision is rejected", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    const created = ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(1_000),
        occurredAt: AT("2026-09-05"),
        splits: [{ categoryId: "groceries", amount: lkr(1_000) }],
      }),
    );
    const snapshot = ledger.snapshot(created.transaction.id);
    expectError(FinanceErrorCode.VALIDATION_ERROR, () =>
      planEditFinancials(ledger.context, {
        snapshot,
        expectedRevision: 7,
        amount: lkr(1_000),
        occurredAt: AT("2026-09-05"),
        legs: [
          { accountId: bank.id, amountMinorSigned: -100_000n },
          { accountId: bank.id, amountMinorSigned: 100_000n },
        ],
      }),
    );
  });
});

describe("deleting and restoring", () => {
  test("delete reverses the effect and restore re-applies it with a new revision", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    ledger.apply(
      planOpeningBalance(ledger.context, {
        accountId: bank.id,
        amount: lkr(100_000),
        occurredAt: AT("2026-09-01"),
      }),
    );
    const created = ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(3_450),
        occurredAt: AT("2026-09-05"),
        splits: [{ categoryId: "groceries", amount: lkr(3_450) }],
      }),
    );
    const originalJournal = ledger.journalById(created.revisions[0]!.journalId!);

    const deleted = ledger.apply(
      planDeleteTransaction(ledger.context, {
        snapshot: ledger.snapshot(created.transaction.id),
        expectedRevision: 1,
      }),
    );
    assert.equal(deleted.transaction.status, TransactionStatus.DELETED);
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 100,000.00");
    assert.equal(formatMoney(ledger.categoryNet("groceries")), "LKR 0.00");

    const restored = ledger.apply(
      planRestoreTransaction(ledger.context, {
        snapshot: ledger.snapshot(created.transaction.id),
        reversedJournal: originalJournal,
        expectedRevision: 2,
      }),
    );
    assert.equal(restored.transaction.status, TransactionStatus.POSTED);
    assert.equal(restored.transaction.currentRevision, 3);
    assert.equal(formatMoney(ledger.balance(bank.id)), "LKR 96,550.00");
    assert.equal(formatMoney(ledger.categoryNet("groceries")), "LKR 3,450.00");

    // buildspec.md §15: "Undo appends a compensating action... It never deletes the original".
    assert.equal(ledger.journals().length, 4, "opening + original + reversal + restore");
    ledger.assertBalanced();
  });
});

/* ============================================================================================ */
/* Guard rails                                                                                   */
/* ============================================================================================ */

describe("posting guard rails", () => {
  test("splits must total the transaction amount exactly", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    expectError(FinanceErrorCode.VALIDATION_ERROR, () =>
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(1_000),
        occurredAt: AT("2026-09-05"),
        splits: [
          { categoryId: "groceries", amount: lkr(600) },
          { categoryId: "dining", amount: lkr(300) },
        ],
      }),
    );
  });

  test("a split that totals exactly is accepted", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    ledger.apply(
      planCreateExpense(ledger.context, {
        accountId: bank.id,
        amount: lkr(1_000),
        occurredAt: AT("2026-09-05"),
        splits: [
          { categoryId: "groceries", amount: lkr(600) },
          { categoryId: "dining", amount: lkr(400) },
        ],
      }),
    );
    assert.equal(formatMoney(ledger.categoryNet("groceries")), "LKR 600.00");
    assert.equal(formatMoney(ledger.categoryNet("dining")), "LKR 400.00");
    ledger.assertBalanced();
  });

  test("negative and zero amounts are rejected", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    for (const amount of [lkr(0), lkr(-100)]) {
      expectError(FinanceErrorCode.VALIDATION_ERROR, () =>
        planCreateExpense(ledger.context, {
          accountId: bank.id,
          amount,
          occurredAt: AT("2026-09-05"),
          splits: [{ categoryId: "groceries", amount }],
        }),
      );
    }
  });

  // buildspec.md §17.3: "Reject a journal with mixed account currencies."
  test("cross-currency transfers report an unsupported operation, not a wrong number", () => {
    const ledger = createTestLedger();
    const bank = ledger.account({
      id: "acct_lkr",
      kind: AccountKind.ASSET,
      type: AccountType.BANK,
    });
    const usd = ledger.account({
      id: "acct_usd",
      kind: AccountKind.ASSET,
      type: AccountType.BANK,
      currency: { code: "USD", minorUnitDigits: 2 },
    });
    expectError(FinanceErrorCode.UNSUPPORTED_OPERATION, () =>
      planCreateTransfer(ledger.context, {
        fromAccountId: bank.id,
        toAccountId: usd.id,
        amount: lkr(1_000),
        occurredAt: AT("2026-09-05"),
      }),
    );
  });

  test("a transfer needs two different accounts", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    expectError(FinanceErrorCode.VALIDATION_ERROR, () =>
      planCreateTransfer(ledger.context, {
        fromAccountId: bank.id,
        toAccountId: bank.id,
        amount: lkr(100),
        occurredAt: AT("2026-09-05"),
      }),
    );
  });

  // buildspec.md §17.3: "Reject posting to an archived account".
  test("archived accounts refuse new entries but keep their history", () => {
    const ledger = createTestLedger();
    const closed = ledger.account({
      id: "acct_closed",
      kind: AccountKind.ASSET,
      type: AccountType.BANK,
      archivedAt: 1,
    });
    expectError(FinanceErrorCode.VALIDATION_ERROR, () =>
      planCreateExpense(ledger.context, {
        accountId: closed.id,
        amount: lkr(100),
        occurredAt: AT("2026-09-05"),
        splits: [{ categoryId: "groceries", amount: lkr(100) }],
      }),
    );
  });

  test("income must land in an asset account", () => {
    const ledger = createTestLedger();
    const { card } = standardAccounts(ledger);
    expectError(FinanceErrorCode.VALIDATION_ERROR, () =>
      planCreateIncome(ledger.context, {
        accountId: card.id,
        amount: lkr(1_000),
        occurredAt: AT("2026-09-05"),
        splits: [{ categoryId: "income", amount: lkr(1_000) }],
      }),
    );
  });

  test("an unbalanced hand-built journal is rejected", () => {
    const ledger = createTestLedger();
    const { bank, cash } = standardAccounts(ledger);
    expectError(FinanceErrorCode.UNBALANCED_JOURNAL, () =>
      validateJournal(
        {
          id: "jrn_bad",
          transactionId: "txn_bad",
          transactionRevision: 1,
          purpose: "original",
          currency: lkr(0).currency,
          effectiveAt: 0,
          recordedAt: 0,
          state: "posted",
          actionId: "act_bad",
          entries: [
            { id: "e1", accountId: bank.id, amountMinorSigned: 100n },
            { id: "e2", accountId: cash.id, amountMinorSigned: -99n },
          ],
        },
        ledger.context.lookup,
      ),
    );
  });

  test("a single-sided journal is rejected", () => {
    const ledger = createTestLedger();
    const { bank } = standardAccounts(ledger);
    expectError(FinanceErrorCode.UNBALANCED_JOURNAL, () =>
      validateJournal(
        {
          id: "jrn_one",
          transactionId: "txn_one",
          transactionRevision: 1,
          purpose: "original",
          currency: lkr(0).currency,
          effectiveAt: 0,
          recordedAt: 0,
          state: "posted",
          actionId: "act_one",
          entries: [{ id: "e1", accountId: bank.id, amountMinorSigned: 0n }],
        },
        ledger.context.lookup,
      ),
    );
  });
});

/* ============================================================================================ */
/* Property sweeps (buildspec.md §22: "randomized valid journals")                                */
/* ============================================================================================ */

describe("randomised invariants", () => {
  test("every generated book balances, and transfers conserve total assets", () => {
    let seed = 0x9e3779b9;
    const nextInt = (bound: number): number => {
      // xorshift32 keeps failures reproducible from the seed above.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed % bound;
    };

    for (let run = 0; run < 120; run += 1) {
      const ledger = createTestLedger();
      const { bank, cash, card } = standardAccounts(ledger);
      ledger.apply(
        planOpeningBalance(ledger.context, {
          accountId: bank.id,
          amount: lkr(500_000),
          occurredAt: AT("2026-01-01"),
        }),
      );

      let expectedAssets = 500_000_00n;

      for (let step = 0; step < 12; step += 1) {
        const amount = lkr(nextInt(5_000) + 1, nextInt(100));
        const day = String(nextInt(27) + 1).padStart(2, "0");
        const when = AT(`2026-06-${day}`);

        switch (nextInt(5)) {
          case 0: {
            ledger.apply(
              planCreateExpense(ledger.context, {
                accountId: bank.id,
                amount,
                occurredAt: when,
                splits: [{ categoryId: "groceries", amount }],
              }),
            );
            expectedAssets -= amount.minor;
            break;
          }
          case 1: {
            ledger.apply(
              planCreateIncome(ledger.context, {
                accountId: bank.id,
                amount,
                occurredAt: when,
                splits: [{ categoryId: "income", amount }],
              }),
            );
            expectedAssets += amount.minor;
            break;
          }
          case 2: {
            // A transfer between two assets must leave the asset total untouched.
            ledger.apply(
              planCreateTransfer(ledger.context, {
                fromAccountId: bank.id,
                toAccountId: cash.id,
                amount,
                occurredAt: when,
              }),
            );
            break;
          }
          case 3: {
            // Card spending does not touch assets at all; it raises debt.
            ledger.apply(
              planCreateExpense(ledger.context, {
                accountId: card.id,
                amount,
                occurredAt: when,
                splits: [{ categoryId: "shopping", amount }],
              }),
            );
            break;
          }
          default: {
            ledger.apply(
              planCreateRefund(ledger.context, {
                accountId: bank.id,
                amount,
                occurredAt: when,
                categoryId: "groceries",
              }),
            );
            expectedAssets += amount.minor;
            break;
          }
        }
      }

      ledger.assertBalanced();
      const actualAssets = ledger.balance(bank.id).minor + ledger.balance(cash.id).minor;
      assert.equal(actualAssets, expectedAssets, `run ${run}: asset conservation`);
    }
  });

  test("repeated edits leave the book balanced and the balance exactly tracks the last amount", () => {
    let seed = 12345;
    const nextInt = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    for (let run = 0; run < 60; run += 1) {
      const ledger = createTestLedger();
      const { bank } = standardAccounts(ledger);
      ledger.apply(
        planOpeningBalance(ledger.context, {
          accountId: bank.id,
          amount: lkr(100_000),
          occurredAt: AT("2026-01-01"),
        }),
      );

      const firstAmount = lkr(nextInt(2_000) + 1);
      const created = ledger.apply(
        planCreateExpense(ledger.context, {
          accountId: bank.id,
          amount: firstAmount,
          occurredAt: AT("2026-06-15"),
          splits: [{ categoryId: "groceries", amount: firstAmount }],
        }),
      );
      const groceriesAccount = ledger
        .journalById(created.revisions[0]!.journalId!)
        .entries.find((e) => e.accountId !== bank.id)!.accountId;

      // Edit the same record several times; only the latest amount may survive in the balance.
      let latest = firstAmount;
      for (let edit = 0; edit < 3; edit += 1) {
        latest = lkr(nextInt(2_000) + 1);
        const snapshot = ledger.snapshot(created.transaction.id);
        ledger.apply(
          planEditFinancials(ledger.context, {
            snapshot,
            expectedRevision: snapshot.transaction.currentRevision,
            amount: latest,
            occurredAt: AT("2026-06-15"),
            categoryId: "groceries",
            legs: [
              {
                accountId: groceriesAccount,
                amountMinorSigned: latest.minor,
                categoryId: "groceries",
              },
              { accountId: bank.id, amountMinorSigned: -latest.minor },
            ],
          }),
        );
      }

      ledger.assertBalanced();
      assert.equal(
        ledger.balance(bank.id).minor,
        100_000_00n - latest.minor,
        `run ${run}: only the latest revision may affect the balance`,
      );
      assert.equal(ledger.categoryNet("groceries").minor, latest.minor);
    }
  });
});
