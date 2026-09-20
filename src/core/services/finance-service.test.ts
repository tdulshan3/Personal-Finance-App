import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { openEncryptedDatabase } from "../data/driver.ts";
import { migrate } from "../data/migrations.ts";
import { FinanceErrorCode, isFinanceError } from "../domain/errors.ts";
import { AccountType } from "../domain/ledger.ts";
import { LKR, formatMoney, majorUnits } from "../domain/money.ts";
import { deriveKey, newKdfParams } from "../security/passphrase.ts";
import { dateOnlyTime, fixedClock, fromIso } from "../domain/time.ts";
import { TransactionStatus } from "../domain/transaction.ts";
import type { FinanceService } from "./finance-service.ts";
import { createFinanceService } from "./finance-service.ts";

/**
 * End-to-end proof that a [PostingPlan] survives the round trip through encrypted SQLite with the
 * same numbers the pure-domain tests produce. buildspec.md §21 M1 gate: "every money invariant
 * passes; a fresh restore reproduces totals; full manual operation works without a network."
 */

const ZONE = "Asia/Colombo";
const AT = (date: string) => dateOnlyTime(date, ZONE);
const TEST_KDF = { ...newKdfParams(), N: 1 << 10 };

const workspaces: string[] = [];
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

async function freshService(): Promise<{ service: FinanceService; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pfa-svc-test-"));
  workspaces.push(dir);
  const file = join(dir, "ledger.db");
  const key = await deriveKey("a passphrase for the service tests", TEST_KDF);
  const db = await openEncryptedDatabase({ file, key });
  migrate(db);

  let counter = 0;
  const service = createFinanceService({
    db,
    zone: ZONE,
    clock: fixedClock(fromIso("2026-09-20T12:00:00+05:30"), ZONE),
    ids: { next: (prefix) => `${prefix}_${++counter}` },
  });
  service.seedDefaultCategories();
  return { service, file };
}

function bankAndCard(service: FinanceService) {
  const bank = service.createAccount({
    name: "Everyday bank",
    type: AccountType.BANK,
    currency: LKR,
  });
  const card = service.createAccount({
    name: "Credit card",
    type: AccountType.CREDIT_CARD,
    currency: LKR,
  });
  const cash = service.createAccount({ name: "Cash", type: AccountType.CASH, currency: LKR });
  return { bank, card, cash };
}

describe("accounts", () => {
  test("a credit card is created as a liability with a credit-line role", async () => {
    const { service } = await freshService();
    const { card, bank } = bankAndCard(service);
    assert.equal(card.kind, "liability");
    assert.equal(card.liquidityRole, "credit_line");
    assert.equal(bank.kind, "asset");
    assert.equal(bank.liquidityRole, "liquid");
  });

  test("internal account types cannot be created from the Accounts screen", async () => {
    const { service } = await freshService();
    assert.throws(
      () =>
        service.createAccount({
          name: "Sneaky equity",
          type: AccountType.SYSTEM_EQUITY,
          currency: LKR,
        }),
      /Internal account types/,
    );
  });

  test("category and system accounts stay hidden from the visible list", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 100_000n),
      occurredAt: AT("2026-09-01"),
    });
    service.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
    });

    const visible = service.listAccounts();
    assert.equal(
      visible.every((a) => a.type !== "category_expense" && a.type !== "system_equity"),
      true,
      "buildspec.md §9.2: system equity and category accounts stay behind the UI",
    );
    assert.equal(visible.length, 3);
  });
});

describe("§22 fixtures through encrypted SQLite", () => {
  test("opening 100,000 then a 3,450 purchase leaves 96,550", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);

    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 100_000n),
      occurredAt: AT("2026-09-01"),
    });
    service.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-20"),
      merchantName: "Keells Super",
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
    });

    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 96,550.00");
    const spending = service.spendingByCategory("2026-09-01", "2026-09-30");
    const groceries = spending.find((s) => s.categoryId === "groceries");
    assert.equal(formatMoney(groceries!.amount), "LKR 3,450.00");
  });

  test("card purchase then repayment counts spending once", async () => {
    const { service } = await freshService();
    const { bank, card } = bankAndCard(service);

    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 100_000n),
      occurredAt: AT("2026-09-01"),
    });
    service.createExpense({
      accountId: card.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
    });
    assert.equal(formatMoney(service.balanceOf(card.id)), "LKR 3,450.00");

    service.createTransfer({
      fromAccountId: bank.id,
      toAccountId: card.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-25"),
    });

    assert.equal(formatMoney(service.balanceOf(card.id)), "LKR 0.00");
    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 96,550.00");
    const spending = service.spendingByCategory("2026-09-01", "2026-09-30");
    assert.equal(formatMoney(spending.find((s) => s.categoryId === "groceries")!.amount), "LKR 3,450.00");
  });

  test("withdrawal with a fee spends only the fee", async () => {
    const { service } = await freshService();
    const { bank, cash } = bankAndCard(service);

    service.createIncome({
      accountId: bank.id,
      amount: majorUnits(LKR, 100_000n),
      occurredAt: AT("2026-09-01"),
      splits: [{ categoryId: "income", amount: majorUnits(LKR, 100_000n) }],
    });
    service.createTransfer({
      fromAccountId: bank.id,
      toAccountId: cash.id,
      amount: majorUnits(LKR, 4_000n),
      occurredAt: AT("2026-09-10"),
      fee: { amount: majorUnits(LKR, 250n), categoryId: "fees" },
    });

    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 95,750.00");
    assert.equal(formatMoney(service.balanceOf(cash.id)), "LKR 4,000.00");
    const spending = service.spendingByCategory("2026-09-01", "2026-09-30");
    assert.equal(spending.length, 1, "only the fee is spending");
    assert.equal(spending[0]!.categoryId, "fees");
    assert.equal(formatMoney(spending[0]!.amount), "LKR 250.00");
  });

  test("a partial refund reduces the original category", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 100_000n),
      occurredAt: AT("2026-09-01"),
    });
    service.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
    });
    service.createRefund({
      accountId: bank.id,
      amount: majorUnits(LKR, 500n),
      occurredAt: AT("2026-09-07"),
      categoryId: "groceries",
    });

    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 97,050.00");
    const spending = service.spendingByCategory("2026-09-01", "2026-09-30");
    assert.equal(formatMoney(spending.find((s) => s.categoryId === "groceries")!.amount), "LKR 2,950.00");
  });

  test("history-only imports never move today's balance", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 80_000n),
      occurredAt: AT("2026-09-20"),
    });
    service.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 20_000n),
      occurredAt: AT("2026-05-14"),
      splits: [{ categoryId: "shopping", amount: majorUnits(LKR, 20_000n) }],
      accountingScope: "history_only",
    });

    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 80,000.00");
    // It is still there for categorisation and estimates, just not in the ledger view.
    assert.equal(service.searchTransactions({ includeHistoryOnly: false }).length, 1);
    assert.equal(service.searchTransactions({ includeHistoryOnly: true }).length, 2);
  });

  test("an unknown adjustment reconciles the balance without becoming spending", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 84_250n),
      occurredAt: AT("2026-09-01"),
    });

    const recorded = service.balanceOf(bank.id);
    const observed = majorUnits(LKR, 80_000n);
    service.recordUnknownAdjustment({
      accountId: bank.id,
      displayDelta: { currency: LKR, minor: observed.minor - recorded.minor },
      occurredAt: AT("2026-09-20"),
    });

    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 80,000.00");
    assert.equal(
      service.spendingByCategory("2026-09-01", "2026-09-30").length,
      0,
      "an unexplained difference is equity, not spending",
    );
  });
});

describe("edit, delete and restore", () => {
  test("an edit reverses and replaces, leaving only the latest amount in the balance", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 100_000n),
      occurredAt: AT("2026-09-01"),
    });
    const created = service.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
    });

    service.editExpense({
      transactionId: created.transactionId,
      expectedRevision: 1,
      accountId: bank.id,
      amount: majorUnits(LKR, 4_000n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 4_000n) }],
    });

    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 96,000.00");
    const detail = service.getTransactionDetail(created.transactionId);
    assert.equal(detail.transaction.currentRevision, 2);
    assert.equal(detail.revisionCount, 2, "history is kept, not overwritten");
  });

  test("delete moves to Trash and restore brings the effect back", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 100_000n),
      occurredAt: AT("2026-09-01"),
    });
    const created = service.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
    });

    const ids = () => service.searchTransactions().map((t) => t.id);
    assert.equal(ids().includes(created.transactionId), true);

    service.deleteTransaction({ transactionId: created.transactionId, expectedRevision: 1 });
    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 100,000.00");
    assert.equal(ids().includes(created.transactionId), false, "trashed rows leave the default list");
    assert.deepEqual(
      service.searchTransactions({ status: TransactionStatus.DELETED }).map((t) => t.id),
      [created.transactionId],
      "and are findable in Trash",
    );

    service.restoreTransaction({ transactionId: created.transactionId, expectedRevision: 2 });
    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 96,550.00");
    assert.equal(ids().includes(created.transactionId), true, "restored rows come back to the list");
  });

  test("a stale expected revision is refused", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    const created = service.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 1_000n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 1_000n) }],
    });
    assert.throws(
      () =>
        service.deleteTransaction({ transactionId: created.transactionId, expectedRevision: 99 }),
      /changed since it was loaded/,
    );
  });
});

describe("idempotency (buildspec.md §16, §20)", () => {
  test("replaying the same key returns the original result and writes nothing new", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    const input = {
      accountId: bank.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
    };

    const first = service.createExpense(input, { idempotencyKey: "submit-1" });
    const second = service.createExpense(input, { idempotencyKey: "submit-1" });

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.actionId, first.actionId, "the same receipt comes back");
    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR -3,450.00");
    assert.equal(service.searchTransactions().length, 1, "no duplicate write");
  });

  test("the same key with different arguments is a conflict", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    const base = {
      accountId: bank.id,
      occurredAt: AT("2026-09-05"),
    };
    service.createExpense(
      {
        ...base,
        amount: majorUnits(LKR, 3_450n),
        splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
      },
      { idempotencyKey: "submit-1" },
    );

    try {
      service.createExpense(
        {
          ...base,
          amount: majorUnits(LKR, 9_999n),
          splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 9_999n) }],
        },
        { idempotencyKey: "submit-1" },
      );
      assert.fail("expected an idempotency conflict");
    } catch (error) {
      assert.ok(isFinanceError(error));
      assert.equal(error.code, FinanceErrorCode.IDEMPOTENCY_CONFLICT);
    }
  });
});

describe("search and totals", () => {
  test("filters by date, account, category and text", async () => {
    const { service } = await freshService();
    const { bank, card } = bankAndCard(service);
    service.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 1_000n),
      occurredAt: AT("2026-08-15"),
      merchantName: "Keells Super",
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 1_000n) }],
    });
    service.createExpense({
      accountId: card.id,
      amount: majorUnits(LKR, 2_000n),
      occurredAt: AT("2026-09-15"),
      merchantName: "Odel",
      splits: [{ categoryId: "shopping", amount: majorUnits(LKR, 2_000n) }],
    });

    assert.equal(service.searchTransactions().length, 2);
    assert.equal(service.searchTransactions({ from: "2026-09-01" }).length, 1);
    assert.equal(service.searchTransactions({ to: "2026-08-31" }).length, 1);
    assert.equal(service.searchTransactions({ accountId: card.id }).length, 1);
    assert.equal(service.searchTransactions({ categoryId: "groceries" }).length, 1);
    assert.equal(service.searchTransactions({ text: "keells" }).length, 1);
    assert.equal(service.searchTransactions({ text: "nothing here" }).length, 0);
  });

  test("page size is bounded to 200 (buildspec.md §16)", async () => {
    const { service } = await freshService();
    const { bank } = bankAndCard(service);
    for (let i = 0; i < 5; i += 1) {
      service.createExpense({
        accountId: bank.id,
        amount: majorUnits(LKR, 10n),
        occurredAt: AT("2026-09-05"),
        splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 10n) }],
      });
    }
    assert.equal(service.searchTransactions({ limit: 2 }).length, 2);
    assert.equal(service.searchTransactions({ limit: 100_000 }).length, 5);
    assert.equal(service.searchTransactions({ limit: 2, offset: 4 }).length, 1);
  });

  test("home totals keep liquid money and debt separate, per currency", async () => {
    const { service } = await freshService();
    const { bank, card, cash } = bankAndCard(service);
    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 80_000n),
      occurredAt: AT("2026-09-01"),
    });
    service.setOpeningBalance({
      accountId: cash.id,
      amount: majorUnits(LKR, 5_000n),
      occurredAt: AT("2026-09-01"),
    });
    service.createExpense({
      accountId: card.id,
      amount: majorUnits(LKR, 12_000n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "shopping", amount: majorUnits(LKR, 12_000n) }],
    });

    const totals = service.homeTotals();
    assert.equal(formatMoney(totals.liquid.get("LKR")!), "LKR 85,000.00");
    assert.equal(formatMoney(totals.owed.get("LKR")!), "LKR 12,000.00");
  });
});

describe("durability", () => {
  // buildspec.md §21 M1 gate: "a fresh restore reproduces totals".
  test("reopening the database reproduces every balance", async () => {
    const { service, file } = await freshService();
    const { bank, card } = bankAndCard(service);
    service.setOpeningBalance({
      accountId: bank.id,
      amount: majorUnits(LKR, 100_000n),
      occurredAt: AT("2026-09-01"),
    });
    service.createExpense({
      accountId: card.id,
      amount: majorUnits(LKR, 3_450n),
      occurredAt: AT("2026-09-05"),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
    });
    const before = {
      bank: formatMoney(service.balanceOf(bank.id)),
      card: formatMoney(service.balanceOf(card.id)),
    };
    // Reopen from disk with the same passphrase.
    const key = await deriveKey("a passphrase for the service tests", TEST_KDF);
    const reopened = await openEncryptedDatabase({ file, key });
    const restored = createFinanceService({ db: reopened, zone: ZONE });

    assert.equal(formatMoney(restored.balanceOf(bank.id)), before.bank);
    assert.equal(formatMoney(restored.balanceOf(card.id)), before.card);
    // The opening balance and the card purchase are both ledger transactions.
    assert.equal(restored.searchTransactions().length, 2);
    assert.equal(
      formatMoney(restored.spendingByCategory("2026-09-01", "2026-09-30")[0]!.amount),
      "LKR 3,450.00",
    );
    reopened.close();
  });
});
