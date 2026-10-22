import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { openEncryptedDatabase } from "../core/data/driver.ts";
import { migrate } from "../core/data/migrations.ts";
import { AccountType } from "../core/domain/ledger.ts";
import { LKR, majorUnits } from "../core/domain/money.ts";
import { dateOnlyTime, fixedClock, fromIso } from "../core/domain/time.ts";
import { deriveKey, newKdfParams } from "../core/security/passphrase.ts";
import { createBudgetService } from "../core/services/budget-service.ts";
import { createFinanceService } from "../core/services/finance-service.ts";
import { createRecurringService } from "../core/services/recurring-service.ts";
import { createIntentRouter } from "./intents.ts";
import { createProposalService } from "./proposals.ts";
import { DEFAULT_PERMISSIONS, createToolExecutor } from "./tools.ts";

const ZONE = "Asia/Colombo";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("bills, budgets and the outlook are answered by rules, from the same figures the model's tools return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pfa-agent-plan-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for agent planning", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  const service = createFinanceService({ db, zone: ZONE, clock: fixedClock(fromIso("2026-10-22T10:00:00+05:30"), ZONE) });
  service.seedDefaultCategories();
  const lkr = (n: bigint) => majorUnits(LKR, n);
  const bank = service.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
  service.setOpeningBalance({ accountId: bank.id, amount: lkr(100_000n), occurredAt: dateOnlyTime("2026-09-01", ZONE) });
  service.createExpense({ accountId: bank.id, amount: lkr(9_000n), occurredAt: dateOnlyTime("2026-10-05", ZONE), merchantName: "Grocer", splits: [{ categoryId: "groceries", amount: lkr(9_000n) }] });
  createRecurringService({ db, service }).create({ name: "Broadband", direction: "out", amount: lkr(4_000n), dueDay: 28, accountId: bank.id, categoryId: "utilities" });
  createBudgetService({ db, service }).set("groceries", lkr(8_000n));

  const proposals = createProposalService({ db, service });
  const router = createIntentRouter({ db, service, proposals, sessionId: "s", permissions: DEFAULT_PERMISSIONS });

  const bills = router.tryAnswer("What bills are due?")!;
  assert.match(bills.text, /2026-10-28 · Broadband · LKR 4,000\.00/);

  const budgets = router.tryAnswer("How am I doing on my budget?")!;
  assert.match(budgets.text, /Groceries: LKR 9,000\.00 of LKR 8,000\.00 \(113%\) — over budget/);

  const outlook = router.tryAnswer("how much can I save this month")!;
  assert.match(outlook.text, /You have \*\*LKR 91,000\.00\*\* to spend now/);
  assert.match(outlook.text, /not a promise/);

  const tools = createToolExecutor({ db, service, proposals, sessionId: "s", model: { endpoint: "x", model: "m", digest: null }, permissions: DEFAULT_PERMISSIONS });
  const forecast = tools.execute("get_cash_forecast", {}).result as { forecasts: { spendable_now: string; could_set_aside: string }[] };
  assert.equal(forecast.forecasts[0]!.spendable_now, "LKR 91,000.00");
  assert.ok(outlook.text.includes(forecast.forecasts[0]!.could_set_aside), "the rules and the tool quote the same figure");
  assert.equal(router.tryAnswer("what is the capital of France"), null, "anything else still falls through to the model");
});
