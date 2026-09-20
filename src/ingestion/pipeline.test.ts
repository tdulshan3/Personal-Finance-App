import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { openEncryptedDatabase } from "../core/data/driver.ts";
import { migrate } from "../core/data/migrations.ts";
import { AccountType } from "../core/domain/ledger.ts";
import { LKR, formatMoney, majorUnits } from "../core/domain/money.ts";
import { dateOnlyTime, fixedClock, fromIso } from "../core/domain/time.ts";
import { deriveKey, newKdfParams } from "../core/security/passphrase.ts";
import { createFinanceService } from "../core/services/finance-service.ts";
import { createMessageProcessor } from "./processing.ts";
import { createReviewService } from "./review-service.ts";
import { generateWebhookSecret, parseWebhookPayload, stageWebhookMessage } from "./sms/webhook.ts";

/** Message -> rules -> review -> accepted transaction with its evidence link (buildspec.md §7, §19.B). */

const ZONE = "Asia/Colombo";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a bank SMS becomes a reviewed transaction exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pfa-pipe-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for pipeline", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  const clock = fixedClock(fromIso("2026-09-21T09:00:00+05:30"), ZONE);
  const service = createFinanceService({ db, zone: ZONE, clock });
  service.seedDefaultCategories();
  const bank = service.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
  service.setOpeningBalance({ accountId: bank.id, amount: majorUnits(LKR, 100_000n), occurredAt: dateOnlyTime("2026-09-01", ZONE) });

  // Deliveries: a purchase, an OTP, and a retry of the purchase.
  const config = generateWebhookSecret(db, clock.now());
  const purchase = { from: "BlueLagoonBank", text: "Purchase of LKR 3,450.00 at KEELLS SUPER using card ****1234 on 20/09/2026. Available balance LKR 96,550.00.", sentStamp: 1758350000000, receivedStamp: 1758350001000, sim: "" };
  const otp = { from: "BlueLagoonBank", text: "482913 is your OTP for a payment of LKR 9,999.00. Do not share it.", sentStamp: 1758350100000, receivedStamp: 1758350101000, sim: "" };
  stageWebhookMessage(db, config, parseWebhookPayload(purchase), clock.now());
  db.prepare("UPDATE source_senders SET enabled = 1").run();
  for (const p of [purchase, otp, purchase]) stageWebhookMessage(db, config, parseWebhookPayload(p), clock.now());

  const processor = createMessageProcessor({ db, clock, zone: ZONE });
  const report = await processor.processPending({ useModel: false });
  assert.equal(report.considered, 2, "the retry was deduplicated at staging");
  assert.equal(report.toReview, 1);
  assert.equal(report.ignored, 1);

  // §18: an OTP's text is dropped the moment it is recognised.
  const otpRow = db.prepare("SELECT body, purged_at FROM source_messages WHERE processing_status='ignored'").get() as Record<string, unknown>;
  assert.equal(otpRow.body, null);
  assert.ok(otpRow.purged_at !== null);

  const review = createReviewService({ db, service });
  const [card] = review.listOpen();
  assert.ok(card);
  assert.equal(card.kind, "posted_expense");
  assert.equal(formatMoney(card.amount!), "LKR 3,450.00", "the purchase amount, not the balance (§7.1)");
  assert.equal(card.occurredOn, "2026-09-20");
  assert.equal(card.accountHint, "1234");
  assert.equal(card.engine, "rules");
  assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 100,000.00", "nothing posts before acceptance");

  const accepted = review.accept({ eventId: card.eventId, kind: "expense", accountId: bank.id, categoryId: "groceries", amountText: "3450.00", occurredOn: "2026-09-20", merchantName: "Keells Super" });
  assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 96,550.00");

  const link = db.prepare("SELECT transaction_id FROM transaction_sources WHERE source_event_id = ?").get(card.eventId) as Record<string, unknown>;
  assert.equal(link.transaction_id, accepted.transactionId, "the transaction keeps its evidence (§1.8)");
  assert.equal(review.listOpen().length, 0);
  assert.throws(() => review.accept({ eventId: card.eventId, kind: "expense", accountId: bank.id, categoryId: "groceries", amountText: "3450.00", occurredOn: "2026-09-20" }), /already handled/);

  // The suffix is remembered, so the next card from ****1234 preselects this account.
  stageWebhookMessage(db, config, parseWebhookPayload({ ...purchase, text: purchase.text.replace("3,450.00", "120.00"), sentStamp: 1758360000000, receivedStamp: 1758360001000 }), clock.now());
  await processor.processPending({ useModel: false });
  const [next] = review.listOpen();
  assert.equal(next?.suggestedAccountId, bank.id);
  assert.equal(next?.suggestedCategoryId, "groceries", "KEELLS SUPER matches the Keells Super accepted before, case-insensitively");
  db.close();
});
