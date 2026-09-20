import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { openEncryptedDatabase } from "../data/driver.ts";
import { migrate } from "../data/migrations.ts";
import { AccountType } from "../domain/ledger.ts";
import { LKR, formatMoney, majorUnits } from "../domain/money.ts";
import { dateOnlyTime, fixedClock, fromIso } from "../domain/time.ts";
import { deriveKey, newKdfParams } from "../security/passphrase.ts";
import { createCardDueService, nextMonthDue } from "./card-dues.ts";
import { createFinanceService } from "./finance-service.ts";

const ZONE = "Asia/Colombo";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a card's payment is its ledger balance, due next month, and paying it is not spending", async () => {
  assert.equal(nextMonthDue("2026-09-21", 15), "2026-10-15");
  assert.equal(nextMonthDue("2026-12-05", 10), "2027-01-10", "December rolls into January");
  assert.equal(nextMonthDue("2026-01-31", 31), "2026-02-28", "the 31st in February is the 28th");

  const dir = mkdtempSync(join(tmpdir(), "pfa-dues-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for card dues", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  const service = createFinanceService({ db, zone: ZONE, clock: fixedClock(fromIso("2026-09-21T09:00:00+05:30"), ZONE) });
  service.seedDefaultCategories();
  const bank = service.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
  const card = service.createAccount({ name: "Visa", type: AccountType.CREDIT_CARD, currency: LKR, creditLimit: majorUnits(LKR, 200_000n) });
  service.setOpeningBalance({ accountId: bank.id, amount: majorUnits(LKR, 100_000n), occurredAt: dateOnlyTime("2026-09-01", ZONE) });
  const amount = majorUnits(LKR, 18_500n);
  service.createExpense({ accountId: card.id, amount, occurredAt: dateOnlyTime("2026-09-10", ZONE), splits: [{ categoryId: "shopping", amount }] });

  const dues = createCardDueService({ db, service });
  assert.equal(dues.list("2026-09-21")[0]!.dueOn, null, "no due day is invented");
  assert.throws(() => dues.setDueDay(bank.id, 5), /credit card or a loan/);
  assert.throws(() => dues.setDueDay(card.id, 32), /between 1 and 31/);
  dues.setDueDay(card.id, 15);

  const [due] = dues.list("2026-09-21");
  assert.equal(formatMoney(due!.owed), "LKR 18,500.00");
  assert.equal(due!.dueOn, "2026-10-15");
  assert.equal(due!.daysLeft, 24);

  service.createTransfer({ fromAccountId: bank.id, toAccountId: card.id, amount, occurredAt: dateOnlyTime("2026-09-21", ZONE) });
  assert.equal(dues.list("2026-09-21")[0]!.owed.minor, 0n, "paid in full");
  assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 81,500.00");
});
