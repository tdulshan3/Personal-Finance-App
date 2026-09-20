import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { openEncryptedDatabase } from "../../core/data/driver.ts";
import { migrate } from "../../core/data/migrations.ts";
import { fixedClock, fromIso } from "../../core/domain/time.ts";
import { deriveKey, newKdfParams } from "../../core/security/passphrase.ts";
import type { RawSms } from "./termux-collector.ts";
import { createStaticSmsCollector } from "./termux-collector.ts";
import { createSmsSyncService } from "./sync-service.ts";

/**
 * buildspec.md §5.4/§5.5, as reworked by ADR 0004: the watermark and overlap scan are what make a
 * gap of any length fill itself, and what make repeated scans idempotent.
 *
 * §21 M2's gate: "repeated/overlapping imports and simulated crashes produce no duplicate financial
 * effects."
 */

const ZONE = "Asia/Colombo";
const TEST_KDF = { ...newKdfParams(), N: 1 << 10 };
const BANK = "BlueLagoonBank";
const FRIEND = "+94770000000";

const workspaces: string[] = [];
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function at(iso: string): number {
  return fromIso(iso);
}

function sms(id: number, address: string, body: string, received: number): RawSms {
  return { providerId: id, threadId: 1, address, body, received, type: "inbox", read: true };
}

async function harness(rows: readonly RawSms[], now = at("2026-09-20T18:00:00+05:30")) {
  const dir = mkdtempSync(join(tmpdir(), "pfa-sms-"));
  workspaces.push(dir);
  const db = await openEncryptedDatabase({
    file: join(dir, "l.db"),
    key: await deriveKey("a passphrase for sms tests", TEST_KDF),
  });
  migrate(db);
  const clock = fixedClock(now, ZONE);
  const service = createSmsSyncService({
    db,
    collector: createStaticSmsCollector(rows),
    clock,
    fingerprintSecret: Buffer.alloc(32, 7),
  });
  return { db, clock, service, connectionId: service.ensureConnection() };
}

const BASE_ROWS: readonly RawSms[] = Object.freeze([
  sms(101, BANK, "Purchase of LKR 3,450.00 at KEELLS SUPER on 18/09/2026.", at("2026-09-18T10:00:00+05:30")),
  sms(102, FRIEND, "see you at 6", at("2026-09-18T11:00:00+05:30")),
  sms(103, BANK, "Purchase of LKR 1,200.00 at ODEL on 19/09/2026.", at("2026-09-19T12:00:00+05:30")),
]);

describe("sender discovery before any body is stored", () => {
  // buildspec.md §18 data minimisation: the owner picks senders from names and counts, not content.
  test("a first scan records senders but stages nothing", async () => {
    const { service, db, connectionId } = await harness(BASE_ROWS);
    const report = await service.scan({ trigger: "manual" });

    assert.equal(report.scanned, 3);
    assert.equal(report.staged, 0, "no sender is enabled yet");
    assert.equal(report.filtered, 3);
    assert.equal(report.newSenders, 2);

    const stored = db.prepare("SELECT COUNT(*) AS n FROM source_messages").get() as Record<string, unknown>;
    assert.equal(Number(stored.n), 0, "no message body may be stored before the owner opts in");

    const senders = service.listSenders(connectionId);
    assert.deepEqual(
      senders.map((s) => s.senderKey).sort(),
      [FRIEND, BANK].sort(),
    );
    assert.equal(senders.every((s) => !s.enabled), true);
  });

  test("enabling a sender stages only that sender's messages", async () => {
    const { service, connectionId } = await harness(BASE_ROWS);
    await service.scan({ trigger: "manual" });
    service.setSenderEnabled(connectionId, BANK, true);

    const report = await service.scan({ trigger: "manual" });
    assert.equal(report.staged, 2, "both bank messages");
    assert.equal(report.filtered, 1, "the personal message is not stored");
  });

  test("enabling an unknown sender is refused", async () => {
    const { service, connectionId } = await harness(BASE_ROWS);
    assert.throws(
      () => service.setSenderEnabled(connectionId, "NeverSeen", true),
      /has not been seen/,
    );
  });
});

describe("idempotency", () => {
  // §21 M2 gate: "repeated/overlapping imports ... produce no duplicate financial effects."
  test("scanning repeatedly stages each message exactly once", async () => {
    const { service, db, connectionId } = await harness(BASE_ROWS);
    await service.scan({ trigger: "manual" });
    service.setSenderEnabled(connectionId, BANK, true);

    const first = await service.scan({ trigger: "manual" });
    assert.equal(first.staged, 2);

    for (let i = 0; i < 4; i += 1) {
      const again = await service.scan({ trigger: "interval" });
      assert.equal(again.staged, 0, `scan ${i + 2} must stage nothing new`);
    }

    const stored = db.prepare("SELECT COUNT(*) AS n FROM source_messages").get() as Record<string, unknown>;
    assert.equal(Number(stored.n), 2);
  });

  test("the unique occurrence key is device + generation + provider id", async () => {
    const { service, db, connectionId } = await harness(BASE_ROWS);
    await service.scan({ trigger: "manual" });
    service.setSenderEnabled(connectionId, BANK, true);
    await service.scan({ trigger: "manual" });

    assert.throws(() => {
      db.prepare(
        `INSERT INTO source_messages
           (id, connection_id, provider_generation, external_id, source_kind, sender, received_at,
            body, body_hmac, metadata_json, processing_status, created_at)
         SELECT 'src_dupe', connection_id, provider_generation, external_id, source_kind, sender,
                received_at, body, body_hmac, metadata_json, 'staged', created_at
           FROM source_messages LIMIT 1`,
      ).run();
    }, /UNIQUE constraint failed/i);
  });

  // buildspec.md §8: "two real payments can produce identical text".
  test("two identical messages from the same sender are both kept", async () => {
    const twice = [
      sms(201, BANK, "Purchase of LKR 500.00 at SHOP.", at("2026-09-19T09:00:00+05:30")),
      sms(202, BANK, "Purchase of LKR 500.00 at SHOP.", at("2026-09-19T09:00:00+05:30")),
    ];
    const { service, db, connectionId } = await harness(twice);
    await service.scan({ trigger: "manual" });
    service.setSenderEnabled(connectionId, BANK, true);
    await service.scan({ trigger: "manual" });

    const rows = db.prepare("SELECT body_hmac FROM source_messages").all() as Record<string, unknown>[];
    assert.equal(rows.length, 2, "identical text is not a reason to drop a message");
    assert.equal(rows[0]!.body_hmac, rows[1]!.body_hmac, "their fingerprints do match");
  });
});

describe("filling the gap", () => {
  /*
   * The point of the design: the app does not need to have been running. Android keeps the
   * messages, so a scan after any outage walks back to the watermark and picks up everything.
   */
  test("messages that arrived while the app was down are picked up on the next scan", async () => {
    const { db, service, connectionId, clock } = await harness(BASE_ROWS);
    await service.scan({ trigger: "manual" });
    service.setSenderEnabled(connectionId, BANK, true);
    const before = await service.scan({ trigger: "manual" });
    assert.equal(before.staged, 2);

    // Three weeks pass with the server locked. Four more messages arrive in that time, and
    // Android keeps every one of them — which is why nothing had to be running.
    const later = [
      ...BASE_ROWS,
      sms(104, BANK, "Purchase of LKR 900.00 at CARGILLS on 25/09/2026.", at("2026-09-25T10:00:00+05:30")),
      sms(105, BANK, "Purchase of LKR 80.00 at KIOSK on 02/10/2026.", at("2026-10-02T10:00:00+05:30")),
      sms(106, FRIEND, "dinner?", at("2026-10-05T10:00:00+05:30")),
      sms(107, BANK, "Salary of LKR 185,000.00 credited on 09/10/2026.", at("2026-10-09T10:00:00+05:30")),
    ];

    // Same database, same connection, a collector that now sees the longer history.
    clock.set(at("2026-10-11T18:00:00+05:30"));
    const resumed = createSmsSyncService({
      db,
      collector: createStaticSmsCollector(later),
      clock,
      fingerprintSecret: Buffer.alloc(32, 7),
    });

    const after = await resumed.scan({ trigger: "unlock", connectionId });

    assert.equal(after.staged, 3, "the three new bank messages, and none of the old ones");
    assert.ok(after.duplicates > 0, "the overlap window re-reads what was already staged");
    assert.ok(after.watermarkAfter! > before.watermarkAfter!);
    assert.ok(after.gapMs !== null && after.gapMs > 0, "the outage is measurable");

    const total = db.prepare("SELECT COUNT(*) AS n FROM source_messages").get() as Record<string, unknown>;
    assert.equal(Number(total.n), 5, "two before the outage plus three after");
  });

  test("the watermark only moves forward", async () => {
    const { service, connectionId } = await harness(BASE_ROWS);
    await service.scan({ trigger: "manual" });
    service.setSenderEnabled(connectionId, BANK, true);
    const first = await service.scan({ trigger: "manual" });
    const second = await service.scan({ trigger: "interval" });
    assert.equal(second.watermarkAfter, first.watermarkAfter);
  });

  test("coverage reports what has been scanned and when", async () => {
    const { service, connectionId } = await harness(BASE_ROWS);
    await service.scan({ trigger: "manual" });
    service.setSenderEnabled(connectionId, BANK, true);
    await service.scan({ trigger: "manual" });

    const coverage = service.coverage(connectionId);
    assert.equal(coverage.enabled, true);
    assert.equal(coverage.stagedMessages, 2);
    assert.equal(coverage.pendingMessages, 2, "staged but not yet parsed");
    assert.equal(coverage.enabledSenderCount, 1);
    assert.equal(coverage.lastRunStatus, "complete");
    assert.equal(coverage.watermark !== null, true);
  });
});

describe("capability reporting", () => {
  // The silent-failure case that motivated the whole design (see termux-collector.ts).
  test("an empty collector reports a reason rather than looking like an empty inbox", async () => {
    const { service } = await harness([]);
    const capability = await service.checkCapability();
    assert.equal(capability.state, "empty");
  });
});
