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

/** A bill paid by bank arrives as two messages. It is one expense (buildspec.md §8). */

const ZONE = "Asia/Colombo";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a bank debit and the biller's receipt become one expense from the bank account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pfa-pair-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for pairing", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  const clock = fixedClock(fromIso("2026-09-21T09:00:00+05:30"), ZONE);
  const service = createFinanceService({ db, zone: ZONE, clock });
  service.seedDefaultCategories();
  const boc = service.createAccount({ name: "BOC Savings", type: AccountType.BANK, currency: LKR });
  service.setOpeningBalance({ accountId: boc.id, amount: majorUnits(LKR, 12_500n), occurredAt: dateOnlyTime("2026-09-01", ZONE) });

  const config = generateWebhookSecret(db, clock.now());
  const base = 1758400000000;
  const messages = [
    { from: "BOC", text: "BOC: Your A/C ****4521 has been debited Rs 50.00 on 21/09/2026 for bill payment. Available balance Rs 12,450.00.", at: base },
    { from: "Mobitel", text: "Recharge of Rs.50.00 successful for 0711234567. Thank you for using Mobitel.", at: base + 40_000 },
    // Two banks, same amount, same minute: both name an account, so neither is a receipt.
    { from: "BOC", text: "BOC: Your A/C ****4521 has been debited Rs 900.00 on 21/09/2026. Available balance Rs 11,550.00.", at: base + 60_000 },
    { from: "SampleBank", text: "Purchase of LKR 900.00 at SAMPLE STORE using card ****7788 on 21/09/2026.", at: base + 90_000 },
  ];
  const stage = () => { for (const m of messages) stageWebhookMessage(db, config, parseWebhookPayload({ from: m.from, text: m.text, sentStamp: m.at, receivedStamp: m.at + 500, sim: "" }), clock.now()); };
  stage();
  db.prepare("UPDATE source_senders SET enabled = 1").run();
  stage();
  await createMessageProcessor({ db, clock, zone: ZONE }).processPending({ useModel: false });

  const review = createReviewService({ db, service });
  const cards = review.listOpen();
  assert.equal(cards.length, 3, "four messages, three cards: the recharge pair is one");
  const pair = cards.find((c) => c.pairedWith !== null)!;
  assert.equal(pair.sender, "BOC");
  assert.equal(pair.pairedWith!.sender, "Mobitel");
  assert.equal(formatMoney(pair.amount!), "LKR 50.00", "the debit, not the balance after it");
  assert.equal(pair.accountHint, "4521", "the bank's message says which account paid");
  assert.equal(pair.suggestedCategoryId, "utilities", "the biller's message says what it was for");
  assert.equal(cards.filter((c) => formatMoney(c.amount!) === "LKR 900.00").every((c) => c.pairedWith === null), true, "two bank debits are two expenses");

  // The owner can say a pairing is wrong.
  assert.equal(review.listOpen(50, new Set([pair.eventId])).length, 4);

  review.accept({ eventId: pair.eventId, pairedEventId: pair.pairedWith!.eventId, kind: "expense", accountId: boc.id, categoryId: "utilities", amountText: "50.00", occurredOn: "2026-09-21", merchantName: "Mobitel" });
  assert.equal(formatMoney(service.balanceOf(boc.id)), "LKR 12,450.00", "reduced once, and it matches the balance the bank reported");
  assert.equal(review.listOpen().length, 2, "both messages are closed");
  const links = db.prepare("SELECT relation FROM transaction_sources ORDER BY relation").all() as Record<string, unknown>[];
  assert.deepEqual(links.map((l) => l.relation), ["canonical", "supporting"], "one transaction, two pieces of evidence");
  assert.throws(() => review.accept({ eventId: pair.pairedWith!.eventId, kind: "expense", accountId: boc.id, categoryId: "utilities", amountText: "50.00", occurredOn: "2026-09-21" }), /already handled/, "the receipt cannot be posted a second time");
});
