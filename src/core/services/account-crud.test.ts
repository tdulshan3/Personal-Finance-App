import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { openEncryptedDatabase } from "../data/driver.ts";
import { migrate } from "../data/migrations.ts";
import { AccountType, availableCredit, creditUtilisation } from "../domain/ledger.ts";
import { LKR, formatMoney, majorUnits, money } from "../domain/money.ts";
import { dateOnlyTime, fixedClock, fromIso } from "../domain/time.ts";
import { deriveKey, newKdfParams } from "../security/passphrase.ts";
import { createFinanceService } from "./finance-service.ts";

/**
 * buildspec.md §13's Accounts screen: "Add/edit/archive bank, cash, wallet and card accounts",
 * and §10's rule that a credit limit is not a balance.
 */

const ZONE = "Asia/Colombo";
const TEST_KDF = { ...newKdfParams(), N: 1 << 10 };
const workspaces: string[] = [];
after(() => { for (const d of workspaces) rmSync(d, { recursive: true, force: true }); });

async function service() {
  const dir = mkdtempSync(join(tmpdir(), "pfa-acct-"));
  workspaces.push(dir);
  const db = await openEncryptedDatabase({
    file: join(dir, "l.db"),
    key: await deriveKey("a passphrase for account tests", TEST_KDF),
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

describe("editing an account", () => {
  test("renames and sets an institution, bumping the revision", async () => {
    const { svc } = await service();
    const created = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    assert.equal(created.revision, 1);

    const updated = svc.updateAccount({
      accountId: created.id,
      expectedRevision: 1,
      name: "  Everyday current account  ",
      institution: "BlueLagoon Bank",
    });
    assert.equal(updated.name, "Everyday current account", "surrounding space is trimmed");
    assert.equal(updated.institution, "BlueLagoon Bank");
    assert.equal(updated.revision, 2);
  });

  // buildspec.md §16: a write checks the revision it was loaded at.
  test("a stale revision is refused, so two open tabs cannot overwrite each other", async () => {
    const { svc } = await service();
    const a = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    svc.updateAccount({ accountId: a.id, expectedRevision: 1, name: "First" });
    assert.throws(
      () => svc.updateAccount({ accountId: a.id, expectedRevision: 1, name: "Second" }),
      /changed since it was loaded/,
    );
    assert.equal(svc.findAccount(a.id)?.name, "First");
  });

  test("an empty name is refused", async () => {
    const { svc } = await service();
    const a = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    assert.throws(() => svc.updateAccount({ accountId: a.id, expectedRevision: 1, name: "   " }),
                  /name is required/);
  });
});

describe("credit limits (buildspec.md §10)", () => {
  test("a limit is recorded on a card and is not part of the balance", async () => {
    const { svc } = await service();
    const card = svc.createAccount({
      name: "Credit card", type: AccountType.CREDIT_CARD, currency: LKR,
      creditLimit: majorUnits(LKR, 500_000n),
    });
    assert.equal(formatMoney(card.creditLimit!), "LKR 500,000.00");
    // The limit is not money the owner has; the balance is still zero.
    assert.equal(formatMoney(svc.balanceOf(card.id)), "LKR 0.00");
  });

  test("a limit never counts as liquid money", async () => {
    const { svc } = await service();
    const bank = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    svc.createAccount({
      name: "Card", type: AccountType.CREDIT_CARD, currency: LKR,
      creditLimit: majorUnits(LKR, 500_000n),
    });
    svc.setOpeningBalance({
      accountId: bank.id, amount: majorUnits(LKR, 80_000n),
      occurredAt: dateOnlyTime("2026-09-01", ZONE),
    });
    const totals = svc.homeTotals();
    assert.equal(formatMoney(totals.liquid.get("LKR")!), "LKR 80,000.00",
                 "spendable money is the bank balance, not the bank plus a credit line");
  });

  test("available credit is the limit less what is owed", async () => {
    const { svc } = await service();
    const bank = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    const card = svc.createAccount({
      name: "Card", type: AccountType.CREDIT_CARD, currency: LKR,
      creditLimit: majorUnits(LKR, 100_000n),
    });
    svc.setOpeningBalance({
      accountId: bank.id, amount: majorUnits(LKR, 50_000n),
      occurredAt: dateOnlyTime("2026-09-01", ZONE),
    });
    svc.createExpense({
      accountId: card.id, amount: majorUnits(LKR, 25_000n),
      occurredAt: dateOnlyTime("2026-09-05", ZONE),
      splits: [{ categoryId: "shopping", amount: majorUnits(LKR, 25_000n) }],
    });

    const row = svc.accountBalances().find((r) => r.account.id === card.id)!;
    assert.equal(formatMoney(row.balance), "LKR 25,000.00");
    assert.equal(formatMoney(row.available!), "LKR 75,000.00");
    assert.equal(Math.round(row.utilisation! * 100), 25);
  });

  /*
   * buildspec.md §20: "Negative credit-card balance | Display credit balance correctly; do not
   * label it debt owed." A card in credit has more available than its limit, which is right.
   */
  test("a card in credit has more available than its limit, and 0% used", async () => {
    const { svc } = await service();
    const bank = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    const card = svc.createAccount({
      name: "Card", type: AccountType.CREDIT_CARD, currency: LKR,
      creditLimit: majorUnits(LKR, 100_000n),
    });
    svc.setOpeningBalance({
      accountId: bank.id, amount: majorUnits(LKR, 50_000n),
      occurredAt: dateOnlyTime("2026-09-01", ZONE),
    });
    svc.createTransfer({
      fromAccountId: bank.id, toAccountId: card.id,
      amount: majorUnits(LKR, 5_000n), occurredAt: dateOnlyTime("2026-09-05", ZONE),
    });

    const row = svc.accountBalances().find((r) => r.account.id === card.id)!;
    assert.equal(formatMoney(row.balance), "LKR -5,000.00", "negative means in credit");
    assert.equal(formatMoney(row.available!), "LKR 105,000.00");
    assert.equal(row.utilisation, 0, "being in credit is 0% used, not negative");
  });

  test("a limit on a non-credit account is refused", async () => {
    const { svc } = await service();
    const bank = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    assert.throws(
      () => svc.updateAccount({
        accountId: bank.id, expectedRevision: 1, creditLimit: majorUnits(LKR, 1_000n),
      }),
      /only applies to a credit card or loan/,
    );
  });

  test("a limit in the wrong currency, or a negative one, is refused", async () => {
    const { svc } = await service();
    const card = svc.createAccount({ name: "Card", type: AccountType.CREDIT_CARD, currency: LKR });
    assert.throws(
      () => svc.updateAccount({
        accountId: card.id, expectedRevision: 1,
        creditLimit: money({ code: "USD", minorUnitDigits: 2 }, 100_00n),
      }),
      /must be in LKR/,
    );
    assert.throws(
      () => svc.updateAccount({
        accountId: card.id, expectedRevision: 1, creditLimit: money(LKR, -1n),
      }),
      /cannot be negative/,
    );
  });

  test("no limit means no available figure, rather than a guessed one", async () => {
    const { svc } = await service();
    const card = svc.createAccount({ name: "Card", type: AccountType.CREDIT_CARD, currency: LKR });
    const row = svc.accountBalances().find((r) => r.account.id === card.id)!;
    assert.equal(row.available, undefined);
    assert.equal(row.utilisation, undefined);
    assert.equal(availableCredit(card, money(LKR, 0n)), undefined);
    assert.equal(creditUtilisation(card, money(LKR, 0n)), undefined);
  });
});

describe("archiving (buildspec.md §13)", () => {
  test("archiving hides the account but keeps every journal entry", async () => {
    const { svc } = await service();
    const bank = svc.createAccount({ name: "Old bank", type: AccountType.BANK, currency: LKR });
    svc.setOpeningBalance({
      accountId: bank.id, amount: majorUnits(LKR, 10_000n),
      occurredAt: dateOnlyTime("2026-09-01", ZONE),
    });
    const usageBefore = svc.accountUsage(bank.id);
    assert.ok(usageBefore.entries > 0);

    svc.archiveAccount(bank.id);
    assert.equal(svc.listAccounts().some((a) => a.id === bank.id), false, "gone from the list");
    assert.deepEqual(svc.accountUsage(bank.id), usageBefore, "history untouched");
    assert.equal(formatMoney(svc.balanceOf(bank.id)), "LKR 10,000.00", "balance still computes");
  });

  test("archiving is reversible", async () => {
    const { svc } = await service();
    const bank = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    svc.archiveAccount(bank.id);
    assert.equal(svc.findAccount(bank.id)?.archivedAt !== undefined, true);
    svc.unarchiveAccount(bank.id);
    assert.equal(svc.findAccount(bank.id)?.archivedAt, undefined);
    assert.equal(svc.listAccounts().some((a) => a.id === bank.id), true);
  });

  // §17.3: "Reject posting to an archived account".
  test("an archived account refuses new transactions", async () => {
    const { svc } = await service();
    const bank = svc.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
    svc.archiveAccount(bank.id);
    assert.throws(
      () => svc.createExpense({
        accountId: bank.id, amount: majorUnits(LKR, 100n),
        occurredAt: dateOnlyTime("2026-09-05", ZONE),
        splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 100n) }],
      }),
      /archived/,
    );
  });
});
