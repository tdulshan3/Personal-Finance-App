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
import { createDashboardService, resolvePeriod } from "./dashboard-service.ts";
import { createFinanceService } from "./finance-service.ts";

const ZONE = "Asia/Colombo";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("dashboard figures: transfers are not spending, refunds are not income, trash is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pfa-dash-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for the dashboard", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  const service = createFinanceService({ db, zone: ZONE, clock: fixedClock(fromIso("2026-09-20T12:00:00+05:30"), ZONE) });
  service.seedDefaultCategories();
  const bank = service.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
  const card = service.createAccount({ name: "Card", type: AccountType.CREDIT_CARD, currency: LKR });
  const on = (date: string) => dateOnlyTime(date, ZONE);
  const lkr = (n: bigint) => majorUnits(LKR, n);
  const spend = (accountId: string, n: bigint, date: string, categoryId: string, merchantName: string) =>
    service.createExpense({ accountId, amount: lkr(n), occurredAt: on(date), merchantName, splits: [{ categoryId, amount: lkr(n) }] });

  service.setOpeningBalance({ accountId: bank.id, amount: lkr(500_000n), occurredAt: on("2026-08-01") });
  service.createIncome({ accountId: bank.id, amount: lkr(150_000n), occurredAt: on("2026-09-01"), merchantName: "Employer", splits: [{ categoryId: "income", amount: lkr(150_000n) }] });
  spend(bank.id, 12_000n, "2026-09-03", "groceries", "Sample Grocer");
  spend(card.id, 8_000n, "2026-09-05", "groceries", "sample grocer");
  spend(card.id, 5_000n, "2026-09-10", "dining", "Cafe");
  spend(bank.id, 40_000n, "2026-08-10", "housing", "Landlord");
  // Paying the card moves money between the owner's own accounts. It is not spending.
  service.createTransfer({ fromAccountId: bank.id, toAccountId: card.id, amount: lkr(13_000n), occurredAt: on("2026-09-15") });
  // A refund takes spending back out of its category. It is not income.
  service.createRefund({ accountId: card.id, amount: lkr(1_000n), occurredAt: on("2026-09-12"), categoryId: "dining", merchantName: "Cafe" });
  const mistake = spend(bank.id, 99_000n, "2026-09-18", "shopping", "Mistake");
  service.deleteTransaction({ transactionId: mistake.transactionId, expectedRevision: 1 });

  const dash = createDashboardService({ db });
  const period = resolvePeriod("month", "2026-09-20");
  assert.deepEqual([period.from, period.to, period.previous.from, period.previous.to], ["2026-09-01", "2026-09-20", "2026-08-01", "2026-08-20"]);

  const now = dash.totals(LKR, period.from, period.to);
  assert.equal(formatMoney(now.income), "LKR 150,000.00", "the opening balance and the refund are not income");
  assert.equal(formatMoney(now.spending), "LKR 24,000.00", "12k + 8k + 5k - 1k refund; no transfer, no trashed record");
  assert.equal(formatMoney(now.net), "LKR 126,000.00");

  const categories = dash.byCategory(LKR, period.from, period.to, "expense");
  assert.deepEqual(categories.map((c) => [c.categoryId, formatMoney(c.amount)]), [["groceries", "LKR 20,000.00"], ["dining", "LKR 4,000.00"]]);
  const sum = categories.reduce((total, c) => total + c.amount.minor, 0n);
  assert.equal(sum, now.spending.minor, "the ring's slices add up to the headline");

  const merchants = dash.topMerchants(LKR, period.from, period.to);
  assert.deepEqual(merchants[0], { merchant: merchants[0]!.merchant, amount: lkr(20_000n), times: 2 }, "one merchant, however it was capitalised");

  const flow = dash.monthlyFlow(LKR, "2026-09-20", 6);
  assert.equal(flow.length, 6);
  assert.deepEqual(flow.slice(-2).map((m) => [m.month, formatMoney(m.spending)]), [["2026-08", "LKR 40,000.00"], ["2026-09", "LKR 24,000.00"]]);
  assert.equal(flow[0]!.spending.minor, 0n, "a month with nothing recorded is still on the axis");

  const days = dash.dailySpending(LKR, period.from, period.to);
  assert.equal(days.length, 20, "every day present, so the line has no gaps");
  assert.equal(days.reduce((total, d) => total + d.amount.minor, 0n), now.spending.minor);

  assert.deepEqual(resolvePeriod("last", "2026-03-31"), { key: "last", label: "Last month", from: "2026-02-01", to: "2026-02-28", previous: { from: "2026-01-01", to: "2026-01-31", label: "the month before" } });
  assert.equal(resolvePeriod("month", "2026-03-31").previous.to, "2026-02-28", "the 31st compares with February's last day");
  assert.equal(resolvePeriod("nonsense", "2026-09-20").key, "month");
});
