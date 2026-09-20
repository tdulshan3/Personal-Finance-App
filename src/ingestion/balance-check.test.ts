import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { openEncryptedDatabase } from "../core/data/driver.ts";
import { migrate } from "../core/data/migrations.ts";
import { AccountType } from "../core/domain/ledger.ts";
import { LKR, formatMoney, majorUnits } from "../core/domain/money.ts";
import { dateOnlyTime, exactTime, fixedClock, fromIso } from "../core/domain/time.ts";
import { deriveKey, newKdfParams } from "../core/security/passphrase.ts";
import { createBalanceCheckService } from "../core/services/balance-check.ts";
import { createFinanceService } from "../core/services/finance-service.ts";
import { createMessageProcessor } from "./processing.ts";
import { createReviewService } from "./review-service.ts";
import { generateWebhookSecret, parseWebhookPayload, stageWebhookMessage } from "./sms/webhook.ts";

const ZONE = "Asia/Colombo";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("the books balance with themselves, and are checked against what the bank reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pfa-bal-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for balancing", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  const clock = fixedClock(fromIso("2026-09-21T18:00:00+05:30"), ZONE);
  const service = createFinanceService({ db, zone: ZONE, clock });
  service.seedDefaultCategories();
  const boc = service.createAccount({ name: "BOC Savings", type: AccountType.BANK, currency: LKR });
  service.setOpeningBalance({ accountId: boc.id, amount: majorUnits(LKR, 12_500n), occurredAt: dateOnlyTime("2026-09-01", ZONE) });
  db.prepare("INSERT INTO account_aliases (id, account_id, identifier_kind, masked_suffix, created_at) VALUES ('al1', ?, 'masked_suffix', '4521', 0)").run(boc.id);

  const check = createBalanceCheckService({ db, service });
  const review = createReviewService({ db, service });
  const config = generateWebhookSecret(db, clock.now());
  let stamp = fromIso("2026-09-21T09:00:00+05:30");
  const deliver = async (text: string) => {
    stamp += 3_600_000;
    const payload = parseWebhookPayload({ from: "BOC", text, sentStamp: stamp, receivedStamp: stamp, sim: "" });
    stageWebhookMessage(db, config, payload, clock.now());
    db.prepare("UPDATE source_senders SET enabled = 1").run();
    stageWebhookMessage(db, config, payload, clock.now());
    await createMessageProcessor({ db, clock, zone: ZONE }).processPending({ useModel: false });
    return review.listOpen()[0]!;
  };

  // 1. The bank's figure agrees with the books.
  const first = await deliver("BOC: Your A/C ****4521 has been debited Rs 50.00 on 21/09/2026. Available balance Rs 12,450.00.");
  assert.deepEqual([formatMoney(first.balanceCheck!.reported), formatMoney(first.balanceCheck!.projected)], ["LKR 12,450.00", "LKR 12,450.00"], "the card says it will balance before anything is recorded");
  review.accept({ eventId: first.eventId, kind: "expense", accountId: boc.id, categoryId: "utilities", amountText: "50.00", occurredOn: "2026-09-21" });
  assert.equal(check.accounts()[0]!.difference.minor, 0n);

  // 2. Rs 300 left the account without being recorded. The next message exposes it.
  const second = await deliver("BOC: Your A/C ****4521 has been debited Rs 1,000.00 on 21/09/2026. Available balance Rs 11,150.00.");
  assert.equal(formatMoney(second.balanceCheck!.projected), "LKR 11,450.00");
  review.accept({ eventId: second.eventId, kind: "expense", accountId: boc.id, categoryId: "shopping", amountText: "1000.00", occurredOn: "2026-09-21" });
  const gap = check.accounts()[0]!;
  assert.equal(formatMoney(gap.difference, { signed: true }), "LKR -300.00", "reported, never silently applied");
  assert.equal(formatMoney(service.balanceOf(boc.id)), "LKR 11,450.00");

  // 3. The owner records the gap. It is a labelled transaction, and the books still sum to zero.
  service.recordUnknownAdjustment({ accountId: boc.id, displayDelta: gap.difference, occurredAt: exactTime(gap.observedAt, ZONE) });
  assert.equal(check.accounts()[0]!.difference.minor, 0n);
  assert.equal(formatMoney(service.balanceOf(boc.id)), "LKR 11,150.00", "now what the bank says");

  // A later transaction does not disturb a comparison made as of the bank's message.
  const later = majorUnits(LKR, 700n);
  service.createExpense({ accountId: boc.id, amount: later, occurredAt: exactTime(stamp + 7_200_000, ZONE), splits: [{ categoryId: "dining", amount: later }] });
  assert.equal(check.accounts()[0]!.difference.minor, 0n);

  const books = check.books();
  assert.equal(books.ok, true);
  assert.deepEqual(books.residuals, [{ currency: "LKR", residual: 0n }], "every posted entry, summed, is exactly zero");
  assert.equal(books.problems.length, 0);
});
