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
import { createBudgetService, roundUpForBudget } from "./budget-service.ts";
import { createCardDueService } from "./card-dues.ts";
import { createCategoryService } from "./category-service.ts";
import { createFinanceService } from "./finance-service.ts";
import { createForecastService } from "./forecast-service.ts";
import { createGoalService } from "./goal-service.ts";
import { createRecurringService } from "./recurring-service.ts";

const ZONE = "Asia/Colombo";
const TODAY = "2026-10-22";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Three months of a synthetic household: salary, rent, a card subscription and irregular groceries. */
async function household() {
  const dir = mkdtempSync(join(tmpdir(), "pfa-plan-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for planning", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  const service = createFinanceService({ db, zone: ZONE, clock: fixedClock(fromIso(`${TODAY}T10:00:00+05:30`), ZONE) });
  service.seedDefaultCategories();
  const lkr = (n: bigint) => majorUnits(LKR, n);
  const on = (date: string) => dateOnlyTime(date, ZONE);
  const bank = service.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
  const card = service.createAccount({ name: "Visa", type: AccountType.CREDIT_CARD, currency: LKR });
  const savings = service.createAccount({ name: "Savings", type: AccountType.SAVINGS, currency: LKR });
  service.setOpeningBalance({ accountId: bank.id, amount: lkr(200_000n), occurredAt: on("2026-07-01") });
  service.setOpeningBalance({ accountId: savings.id, amount: lkr(60_000n), occurredAt: on("2026-07-01") });
  const spend = (accountId: string, n: bigint, date: string, categoryId: string, merchantName: string) =>
    service.createExpense({ accountId, amount: lkr(n), occurredAt: on(date), merchantName, splits: [{ categoryId, amount: lkr(n) }] });
  for (const month of ["07", "08", "09"]) {
    service.createIncome({ accountId: bank.id, amount: lkr(150_000n), occurredAt: on(`2026-${month}-25`), merchantName: "Employer", splits: [{ categoryId: "income", amount: lkr(150_000n) }] });
  }
  for (const month of ["07", "08", "09", "10"]) {
    spend(bank.id, 50_000n, `2026-${month}-03`, "housing", "Landlord");
    spend(card.id, 2_500n, `2026-${month}-10`, "entertainment", "Netflix");
  }
  const groceries: [string, bigint][] = [["2026-08-05", 8_000n], ["2026-08-12", 12_000n], ["2026-08-20", 6_000n], ["2026-09-04", 9_000n], ["2026-09-15", 15_000n], ["2026-10-02", 7_000n], ["2026-10-18", 11_000n]];
  for (const [date, n] of groceries) spend(bank.id, n, date, "groceries", "Keells");
  spend(bank.id, 3_000n, "2026-10-05", "dining", "Cafe");
  return { db, service, bank, card, savings, lkr };
}

test("categories have a direction, cannot clash by name, and the app's own ones cannot be archived", async () => {
  const { db, service } = await household();
  const categories = createCategoryService({ db, service });
  assert.equal(categories.find("income")!.kind, "income");
  assert.equal(categories.find("groceries")!.kind, "expense");
  assert.ok(categories.find("groceries")!.uses >= 7);

  const salary = categories.create({ name: "  Salary ", kind: "income", icon: "banknote" });
  assert.equal(salary.name, "Salary");
  assert.equal(salary.kind, "income");
  assert.throws(() => categories.create({ name: "salary", kind: "income" }), /already a category/);
  assert.throws(() => categories.archive("income"), /can't be archived/);

  const renamed = categories.update({ id: salary.id, name: "Wages" });
  assert.equal(renamed.name, "Wages");
  categories.archive(salary.id);
  assert.ok(!service.listCategories().some((c) => c.id === salary.id), "archived categories leave the pickers");
  assert.ok(service.listCategories(true).some((c) => c.id === salary.id), "but still resolve for history");
});

test("budgets compare a limit with this month's ledger spending, and suggest limits from history", async () => {
  const { db, service, lkr } = await household();
  const budgets = createBudgetService({ db, service });
  assert.equal(roundUpForBudget(LKR, 2_345_678n), 2_400_000n, "23,456.78 rounds up to 24,000");
  assert.equal(roundUpForBudget(LKR, 124_000n), 130_000n, "1,240 rounds up to 1,300");
  assert.equal(roundUpForBudget(LKR, 8_500n), 8_500n, "85 stays 85");

  budgets.set("groceries", lkr(15_000n));
  budgets.set("dining", lkr(5_000n));
  assert.throws(() => budgets.set("income", lkr(1_000n)), /spending categories/);

  const rows = budgets.list(LKR, TODAY);
  const groceries = rows.find((r) => r.categoryId === "groceries")!;
  assert.equal(formatMoney(groceries.spent), "LKR 18,000.00", "7,000 + 11,000 in October");
  assert.equal(groceries.status, "over");
  assert.equal(formatMoney(groceries.remaining), "LKR -3,000.00");
  const dining = rows.find((r) => r.categoryId === "dining")!;
  assert.equal(dining.status, "under");
  assert.equal(formatMoney(dining.projected), "LKR 4,227.27", "3,000 over 22 days, carried to 31");
  assert.equal(rows[0]!.categoryId, "groceries", "the most used budget comes first");

  const suggestions = budgets.suggestions(LKR, TODAY);
  assert.deepEqual(
    suggestions.map((s) => [s.categoryId, formatMoney(s.suggested)]).sort(),
    [["entertainment", "LKR 2,500.00"], ["housing", "LKR 50,000.00"]],
    "July to September, without the categories that already have a budget",
  );

  budgets.set("dining", null);
  assert.equal(budgets.list(LKR, TODAY).length, 1);
});

test("recurring items: detection suggests monthly payers and payees, and status follows the ledger", async () => {
  const { db, service, bank, card, lkr } = await household();
  const recurring = createRecurringService({ db, service });

  const found = recurring.detect(LKR, TODAY);
  const names = found.map((s) => `${s.direction}:${s.name}:${s.dueDay}`).sort();
  assert.deepEqual(names, ["in:Employer:25", "out:Landlord:3", "out:Netflix:10"], "groceries vary and come often, so they are not a bill");
  assert.equal(found.find((s) => s.name === "Netflix")!.accountId, card.id);

  recurring.create({ name: "Rent", direction: "out", amount: lkr(50_000n), dueDay: 3, accountId: bank.id, categoryId: "housing", matchText: "Landlord" });
  recurring.create({ name: "Salary", direction: "in", amount: lkr(150_000n), dueDay: 25, accountId: bank.id, categoryId: "income", matchText: "Employer" });
  recurring.create({ name: "Netflix", direction: "out", amount: lkr(2_500n), dueDay: 10, accountId: card.id, categoryId: "entertainment" });
  recurring.create({ name: "Broadband", direction: "out", amount: lkr(4_000n), dueDay: 15, categoryId: "utilities", matchText: null });
  assert.throws(() => recurring.create({ name: "Bad", direction: "in", amount: lkr(1n), dueDay: 3, accountId: card.id }), /bank, cash or wallet/);
  assert.equal(recurring.detect(LKR, TODAY).length, 0, "a tracked payer or payee is no longer suggested");

  const rows = new Map(recurring.list(TODAY).map((row) => [row.name, row]));
  assert.equal(rows.get("Rent")!.state, "paid");
  assert.equal(rows.get("Rent")!.nextDue, "2026-11-03");
  assert.equal(rows.get("Rent")!.lastPaid!.date, "2026-10-03");
  assert.equal(rows.get("Salary")!.state, "upcoming");
  assert.equal(rows.get("Salary")!.daysUntil, 3);
  assert.equal(rows.get("Broadband")!.state, "overdue");
  assert.equal(rows.get("Broadband")!.daysUntil, -7);
  assert.equal(rows.get("Netflix")!.state, "paid", "a default match on its own name");

  const occurrences = recurring.occurrences(LKR, TODAY, "2026-11-30").map((o) => `${o.date} ${o.name}`);
  assert.deepEqual(occurrences, [
    "2026-10-22 Broadband",
    "2026-10-25 Salary",
    "2026-11-03 Rent",
    "2026-11-10 Netflix",
    "2026-11-15 Broadband",
    "2026-11-25 Salary",
  ]);
});

test("goals follow a linked account's balance or a hand-kept figure", async () => {
  const { db, service, savings, lkr } = await household();
  const goals = createGoalService({ db, service });
  goals.create({ name: "Emergency fund", target: lkr(300_000n), targetDate: "2027-03-31", accountId: savings.id });
  const holiday = goals.create({ name: "Holiday", target: lkr(100_000n) });
  goals.contribute(holiday, lkr(25_000n));
  assert.throws(() => goals.create({ name: "Bad", target: lkr(0n) }), /more than zero/);

  const [fund, trip] = goals.list(TODAY);
  assert.equal(fund!.name, "Emergency fund");
  assert.equal(formatMoney(fund!.saved), "LKR 60,000.00");
  assert.equal(fund!.monthsLeft, 6, "October to March, both counted");
  assert.equal(formatMoney(fund!.perMonth!), "LKR 40,000.00");
  assert.equal(trip!.progress, 0.25);
  assert.equal(trip!.perMonth, null, "no date, no monthly figure");
});

test("the forecast starts from liquid money, spends an average day, and lands bills, income and card payments on their days", async () => {
  const { db, service, bank, card, lkr } = await household();
  const recurring = createRecurringService({ db, service });
  recurring.create({ name: "Rent", direction: "out", amount: lkr(50_000n), dueDay: 3, accountId: bank.id, categoryId: "housing", matchText: "Landlord" });
  recurring.create({ name: "Salary", direction: "in", amount: lkr(150_000n), dueDay: 25, accountId: bank.id, categoryId: "income", matchText: "Employer" });
  recurring.create({ name: "Netflix", direction: "out", amount: lkr(2_500n), dueDay: 10, accountId: card.id, categoryId: "entertainment" });
  recurring.create({ name: "Broadband", direction: "out", amount: lkr(4_000n), dueDay: 15, categoryId: "utilities", matchText: null });
  createCardDueService({ db, service }).setDueDay(card.id, 15);

  const forecast = createForecastService({ db, service });
  const plan = forecast.project(LKR, TODAY);
  assert.equal(formatMoney(plan.start), "LKR 379,000.00", "the bank only: savings and the card are not spendable cash");
  assert.equal(plan.historyDays, 90);
  assert.equal(plan.confidence, "good");
  // 90 days from 25 July: 228,500 spent, less 150,000 rent and 7,500 Netflix already recognised as bills.
  assert.equal(formatMoney(plan.dailySpend), "LKR 788.88");
  assert.equal(plan.until, "2026-11-30");
  assert.equal(plan.points.length, 40);
  assert.deepEqual(
    plan.events.map((e) => `${e.date} ${e.label} ${formatMoney(e.amount, { withCode: false })}`),
    [
      "2026-10-22 Broadband -4,000.00",
      "2026-10-25 Salary 150,000.00",
      "2026-11-03 Rent -50,000.00",
      "2026-11-15 Visa payment -10,000.00",
      "2026-11-15 Broadband -4,000.00",
      "2026-11-25 Salary 150,000.00",
    ],
    "Netflix is charged to the card, so it reaches cash through the card payment instead",
  );
  assert.equal(plan.points[0]!.base, 37_500_000n, "today: the overdue bill is counted now");
  assert.equal(plan.points[1]!.base, 37_500_000n - 78_888n);
  assert.ok(plan.points.every((p) => p.conservative <= p.base), "the conservative line never sits above the base line");
  assert.equal(plan.belowBufferOn, null);
  assert.equal(plan.lowest.base.date, "2026-10-24", "the day before the salary lands");
  assert.equal(plan.canSetAside.minor, plan.lowest.conservative.amount.minor, "with no buffer, the cautious line's lowest point is what could be set aside");
  assert.ok(plan.canSetAside.minor < plan.lowest.base.amount.minor, "never the expected line's more generous figure");

  forecast.setBuffer(lkr(400_000n));
  const tight = forecast.project(LKR, TODAY);
  assert.equal(tight.canSetAside.minor, 0n);
  assert.equal(tight.belowBufferOn, TODAY, "already under a 400,000 buffer today");
  assert.equal(formatMoney(forecast.buffer(LKR)), "LKR 400,000.00");
});
