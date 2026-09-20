import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { openEncryptedDatabase } from "../core/data/driver.ts";
import { migrate } from "../core/data/migrations.ts";
import { AccountType } from "../core/domain/ledger.ts";
import { LKR, formatMoney } from "../core/domain/money.ts";
import { fixedClock, fromIso } from "../core/domain/time.ts";
import { deriveKey, newKdfParams } from "../core/security/passphrase.ts";
import { createFinanceService } from "../core/services/finance-service.ts";
import { createMessageProcessor } from "./processing.ts";
import { createReviewService } from "./review-service.ts";
import { generateWebhookSecret, parseWebhookPayload, stageWebhookMessage } from "./sms/webhook.ts";

const ZONE = "Asia/Colombo";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a card stuck as 'enter it by hand' is re-read once the rules learn its phrasing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pfa-requeue-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for requeue", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  const clock = fixedClock(fromIso("2026-09-21T09:00:00+05:30"), ZONE);
  const service = createFinanceService({ db, zone: ZONE, clock });
  service.seedDefaultCategories();
  service.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });

  // The noun form ("Transfer Debit Rs ...") that the rules could not read, arriving with no card number typed in Settings.
  const config = generateWebhookSecret(db, clock.now());
  const text = "Online Transfer Debit Rs 75.00 From A/C No XXXXXXXXXX482. Balance available Rs 1,210.40 - Thank you for banking with SAMPLE";
  const outcome = stageWebhookMessage(db, config, parseWebhookPayload({ from: "SAMPLE", text, sentStamp: 1758400000000, receivedStamp: 1758400000500, sim: "" }), clock.now());
  assert.equal(outcome.staged, true, "kept without anyone pressing Keep");

  const processor = createMessageProcessor({ db, clock, zone: ZONE });
  const review = createReviewService({ db, service });
  await processor.processPending({ useModel: false });
  const [card] = review.listOpen();
  assert.equal(card!.kind, "posted_expense");
  assert.equal(formatMoney(card!.amount!), "LKR 75.00", "the debit, not the balance");
  assert.equal(card!.accountHint, "482");

  // Wind the clock back: pretend this message had been processed by older rules and left as a
  // manual card, which is the state the owner's real messages are in.
  db.prepare("UPDATE source_events SET kind = 'unknown', amount_minor = NULL").run();
  db.prepare("DELETE FROM settings WHERE key = 'ingestion.requeued_for_rules'").run();
  assert.equal(review.listOpen()[0]!.amount, null, "the stuck 'enter it by hand' card");

  await processor.processPending({ useModel: false });
  const open = review.listOpen();
  assert.equal(open.length, 1, "replaced, not duplicated");
  assert.equal(formatMoney(open[0]!.amount!), "LKR 75.00", "re-read by the improved rules with nobody touching it");
  const superseded = db.prepare("SELECT COUNT(*) AS n FROM source_events WHERE status = 'superseded'").get() as Record<string, unknown>;
  assert.equal(Number(superseded.n), 1, "the old card is kept as history, not deleted");

  // Once per rules version: a second pass must not churn.
  const before = db.prepare("SELECT COUNT(*) AS n FROM source_events").get() as Record<string, unknown>;
  await processor.processPending({ useModel: false });
  const afterwards = db.prepare("SELECT COUNT(*) AS n FROM source_events").get() as Record<string, unknown>;
  assert.equal(Number(afterwards.n), Number(before.n));
});
