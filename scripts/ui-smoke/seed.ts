/**
 * Seeds a throwaway vault with a synthetic household for the UI smoke run (scripts/ui-smoke/run.sh).
 * Run with PFA_DATA_DIR pointing at an empty directory. Every name, figure and message here is
 * invented; the four bank messages are the repo's synthetic fixtures.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AccountType } from "../../src/core/domain/ledger.ts";
import { LKR, majorUnits } from "../../src/core/domain/money.ts";
import { addDays, dateOnlyTime, localDateOf } from "../../src/core/domain/time.ts";
import { createBudgetService } from "../../src/core/services/budget-service.ts";
import { createCardDueService } from "../../src/core/services/card-dues.ts";
import { createForecastService } from "../../src/core/services/forecast-service.ts";
import { createGoalService } from "../../src/core/services/goal-service.ts";
import { createRecurringService } from "../../src/core/services/recurring-service.ts";
import { generateWebhookSecret, stageWebhookMessage } from "../../src/ingestion/sms/webhook.ts";
import { currentProcessor } from "../../src/server/background.ts";
import { initialise, lock, requireDb, requireService } from "../../src/server/runtime.ts";

const ZONE = "Asia/Colombo";
const out = process.env.PFA_SMOKE_OUT ?? ".";

await initialise({ passphrase: process.env.PFA_PASS ?? "synthetic smoke passphrase", zone: ZONE, currency: "LKR" });
const service = requireService();
const db = requireDb();
const today = localDateOf(Date.now(), ZONE);
const lkr = (n: bigint) => majorUnits(LKR, n);
const on = (date: string) => dateOnlyTime(date, ZONE);
/** "YYYY-MM-DD" for day `dd` of the month `offset` months from this one. */
const day = (offset: number, dd: number) => {
  const first = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + offset);
  return `${first.toISOString().slice(0, 7)}-${String(dd).padStart(2, "0")}`;
};
const past = (date: string) => date <= today;

const bank = service.createAccount({ name: "Everyday Bank", type: AccountType.BANK, currency: LKR, institution: "Sample Bank" });
const cash = service.createAccount({ name: "Cash", type: AccountType.CASH, currency: LKR });
const card = service.createAccount({ name: "Sample Visa", type: AccountType.CREDIT_CARD, currency: LKR, creditLimit: lkr(300_000n), institution: "Sample Bank" });
const savings = service.createAccount({ name: "Rainy Day Savings", type: AccountType.SAVINGS, currency: LKR });
service.setOpeningBalance({ accountId: bank.id, amount: lkr(240_000n), occurredAt: on(day(-4, 1)) });
service.setOpeningBalance({ accountId: savings.id, amount: lkr(85_000n), occurredAt: on(day(-4, 1)) });
service.setOpeningBalance({ accountId: cash.id, amount: lkr(18_500n), occurredAt: on(day(-4, 1)) });

const spend = (accountId: string, n: bigint, date: string, categoryId: string, merchantName: string) => {
  if (!past(date)) return;
  service.createExpense({ accountId, amount: lkr(n), occurredAt: on(date), merchantName, splits: [{ categoryId, amount: lkr(n) }] });
};
for (const m of [-3, -2, -1, 0]) {
  const shift = BigInt(m * -1);
  if (past(day(m, 25))) service.createIncome({ accountId: bank.id, amount: lkr(185_000n), occurredAt: on(day(m, 25)), merchantName: "Acme Employer", splits: [{ categoryId: "income", amount: lkr(185_000n) }] });
  spend(bank.id, 65_000n, day(m, 3), "housing", "Sample Landlord");
  spend(card.id, 2_990n, day(m, 9), "entertainment", "Streamflix");
  spend(bank.id, 6_200n, day(m, 14), "utilities", "Sample Broadband");
  // Everyday spending varies, as real spending does, so it is never mistaken for a bill.
  spend(card.id, 4_800n + shift * 1_350n, day(m, 6), "groceries", "Fresh Mart");
  spend(card.id, 9_400n - shift * 1_900n, day(m, 13), "groceries", "Fresh Mart");
  spend(bank.id, 7_100n + shift * 2_400n, day(m, 21 - Number(shift)), "groceries", "Corner Grocer");
  spend(card.id, 3_250n + shift * 1_100n, day(m, 11 + Number(shift)), "dining", "Cafe Sample");
  spend(cash.id, 1_450n + shift * 700n, day(m, 17 - Number(shift) * 2), "dining", "Rice & Curry Spot");
  spend(card.id, 5_600n + shift * 900n, day(m, 19), "transport", "City Fuel");
  spend(cash.id, 900n + shift * 450n, day(m, 8 + Number(shift)), "transport", "Tuk Ride");
  if (m === -2) spend(card.id, 18_750n, day(m, 15), "shopping", "Sample Electronics");
  if (m === -1) spend(bank.id, 12_000n, day(m, 18), "healthcare", "Sample Clinic");
  if (m === 0) spend(bank.id, 2_400n, day(m, 4), "uncategorized", "Unknown Merchant");
  if (past(day(m, 26))) service.createTransfer({ fromAccountId: bank.id, toAccountId: savings.id, amount: lkr(20_000n), occurredAt: on(day(m, 26)) });
}
service.createTransfer({ fromAccountId: bank.id, toAccountId: card.id, amount: lkr(40_000n), occurredAt: on(addDays(today, -20) < day(0, 1) ? day(0, 1) : addDays(today, -20)) });
service.createRefund({ accountId: card.id, amount: lkr(1_200n), occurredAt: on(day(-1, 20)), categoryId: "groceries", merchantName: "Fresh Mart" });

createCardDueService({ db, service }).setDueDay(card.id, 15);
const recurring = createRecurringService({ db, service });
recurring.create({ name: "Rent", direction: "out", amount: lkr(65_000n), dueDay: 3, accountId: bank.id, categoryId: "housing", matchText: "Sample Landlord" });
recurring.create({ name: "Salary", direction: "in", amount: lkr(185_000n), dueDay: 25, accountId: bank.id, categoryId: "income", matchText: "Acme Employer" });
recurring.create({ name: "Streamflix", direction: "out", amount: lkr(2_990n), dueDay: 9, accountId: card.id, categoryId: "entertainment" });
const budgets = createBudgetService({ db, service });
budgets.set("groceries", lkr(22_000n));
budgets.set("dining", lkr(6_000n));
budgets.set("transport", lkr(9_000n));
const goals = createGoalService({ db, service });
goals.create({ name: "Emergency fund", target: lkr(300_000n), targetDate: `${Number(today.slice(0, 4)) + 1}-06-30`, accountId: savings.id });
const trip = goals.create({ name: "Holiday in the hills", target: lkr(120_000n), targetDate: `${Number(today.slice(0, 4)) + 1}-03-31` });
goals.contribute(trip, lkr(30_000n));
createForecastService({ db, service }).setBuffer(lkr(50_000n));

// Four synthetic bank messages through the real webhook staging path, read by the rules, for Review.
const config = generateWebhookSecret(db, Date.now());
for (const name of ["sms_posted_purchase_keells", "sms_refund_online_store", "sms_salary_credit", "sms_transfer_debit_noun"]) {
  const fixture = JSON.parse(readFileSync(new URL(`../../fixtures/messages/${name}.json`, import.meta.url), "utf8")) as { sender: string; source_text: string };
  const at = Date.now() - 3_600_000;
  stageWebhookMessage(db, config, { from: fixture.sender, text: fixture.source_text, sentStamp: at, receivedStamp: at, sim: null }, Date.now());
}
await currentProcessor()?.processPending({ limit: 50 });

writeFileSync(join(out, "ids.json"), JSON.stringify({ tx: service.searchTransactions({ limit: 1 })[0]?.id }));
console.log("seeded", { today, accounts: service.listAccounts().length, transactions: service.searchTransactions({ limit: 200 }).length });
lock("seeded");
process.exit(0);
