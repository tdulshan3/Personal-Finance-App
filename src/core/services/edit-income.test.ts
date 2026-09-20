import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { openEncryptedDatabase } from "../data/driver.ts";
import { migrate } from "../data/migrations.ts";
import { AccountType } from "../domain/ledger.ts";
import { LKR, formatMoney, majorUnits } from "../domain/money.ts";
import { dateOnlyTime, fixedClock, fromIso } from "../domain/time.ts";
import { deriveKey, newKdfParams } from "../security/passphrase.ts";
import { createFinanceService } from "./finance-service.ts";

/**
 * buildspec.md §9.3: editing posted income is a reversal plus a replacement, exactly like an
 * expense — only the signs of the legs differ (§9.2, row 2).
 */

const ZONE = "Asia/Colombo";
const TEST_KDF = { ...newKdfParams(), N: 1 << 10 };
const workspaces: string[] = [];
after(() => { for (const d of workspaces) rmSync(d, { recursive: true, force: true }); });

async function service() {
  const dir = mkdtempSync(join(tmpdir(), "pfa-editinc-"));
  workspaces.push(dir);
  const db = await openEncryptedDatabase({
    file: join(dir, "l.db"),
    key: await deriveKey("a passphrase for edit-income tests", TEST_KDF),
  });
  migrate(db);
  let n = 0;
  const svc = createFinanceService({
    db, zone: ZONE,
    clock: fixedClock(fromIso("2026-09-20T12:00:00+05:30"), ZONE),
    ids: { next: (p) => `${p}_${++n}` },
  });
  svc.seedDefaultCategories();
  return { svc, db };
}

function bankWithIncome(svc: Awaited<ReturnType<typeof service>>["svc"]) {
  const bank = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
  const created = svc.createIncome({
    accountId: bank.id,
    amount: majorUnits(LKR, 100_000n),
    occurredAt: dateOnlyTime("2026-09-01", ZONE),
    splits: [{ categoryId: "income", amount: majorUnits(LKR, 100_000n) }],
    merchantName: "Employer",
  });
  return { bank, created };
}

describe("editing income", () => {
  test("an edit reverses and replaces, leaving only the latest amount in the balance", async () => {
    const { svc } = await service();
    const { bank, created } = bankWithIncome(svc);
    assert.equal(formatMoney(svc.balanceOf(bank.id)), "LKR 100,000.00");

    svc.editIncome({
      transactionId: created.transactionId,
      expectedRevision: 1,
      accountId: bank.id,
      amount: majorUnits(LKR, 120_000n),
      occurredAt: dateOnlyTime("2026-09-01", ZONE),
      splits: [{ categoryId: "income", amount: majorUnits(LKR, 120_000n) }],
      merchantName: "Employer",
    });

    assert.equal(formatMoney(svc.balanceOf(bank.id)), "LKR 120,000.00");
    const detail = svc.getTransactionDetail(created.transactionId);
    assert.equal(detail.transaction.currentRevision, 2);
    assert.equal(detail.revisionCount, 2, "history is kept, not overwritten");
    assert.equal(formatMoney(detail.currentRevision.displayAmount), "LKR 120,000.00");
    assert.deepEqual(detail.accounts, [{ id: bank.id, name: "Bank", direction: "in" }]);
  });

  // buildspec.md §16: a write checks the revision it was loaded at.
  test("a stale expected revision is refused and changes nothing", async () => {
    const { svc } = await service();
    const { bank, created } = bankWithIncome(svc);
    const edit = (expectedRevision: number, whole: bigint) =>
      svc.editIncome({
        transactionId: created.transactionId,
        expectedRevision,
        accountId: bank.id,
        amount: majorUnits(LKR, whole),
        occurredAt: dateOnlyTime("2026-09-01", ZONE),
        splits: [{ categoryId: "income", amount: majorUnits(LKR, whole) }],
      });

    edit(1, 120_000n);
    assert.throws(() => edit(1, 999_000n), /changed since it was loaded/);
    assert.equal(formatMoney(svc.balanceOf(bank.id)), "LKR 120,000.00");
    assert.equal(svc.getTransactionDetail(created.transactionId).transaction.currentRevision, 2);
  });

  // A negative amount would balance perfectly while posting the income backwards.
  test("a negative amount, or a record that is not income, is refused", async () => {
    const { svc } = await service();
    const { bank, created } = bankWithIncome(svc);
    assert.throws(
      () => svc.editIncome({
        transactionId: created.transactionId,
        expectedRevision: 1,
        accountId: bank.id,
        amount: majorUnits(LKR, -5_000n),
        occurredAt: dateOnlyTime("2026-09-01", ZONE),
        splits: [{ categoryId: "income", amount: majorUnits(LKR, -5_000n) }],
      }),
      /positive amount/,
    );

    const expense = svc.createExpense({
      accountId: bank.id,
      amount: majorUnits(LKR, 1_000n),
      occurredAt: dateOnlyTime("2026-09-02", ZONE),
      splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 1_000n) }],
    });
    assert.throws(
      () => svc.editIncome({
        transactionId: expense.transactionId,
        expectedRevision: 1,
        accountId: bank.id,
        amount: majorUnits(LKR, 1_000n),
        occurredAt: dateOnlyTime("2026-09-02", ZONE),
        splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 1_000n) }],
      }),
      /Only an income record/,
    );
    assert.equal(formatMoney(svc.balanceOf(bank.id)), "LKR 99,000.00", "nothing was posted");
  });
});
