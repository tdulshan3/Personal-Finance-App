import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { FinanceErrorCode, isFinanceError } from "../domain/errors.ts";
import { AccountType } from "../domain/ledger.ts";
import { LKR, formatMoney, majorUnits } from "../domain/money.ts";
import { dateOnlyTime, fixedClock, fromIso } from "../domain/time.ts";
import { deriveKey, newKdfParams } from "../security/passphrase.ts";
import { createFinanceService } from "../services/finance-service.ts";
import {
  createBackup,
  inspectBackup,
  openBackup,
  validateLedgerInvariants,
  writeRestoredDatabase,
} from "./backup.ts";
import { openEncryptedDatabase } from "./driver.ts";
import { migrate } from "./migrations.ts";

/**
 * buildspec.md §21 M1 gate: "a fresh restore reproduces totals", and §22's definition of done:
 * "Backups restore on a clean installation with correct balances, source links, and bill state."
 */

const ZONE = "Asia/Colombo";
const AT = (date: string) => dateOnlyTime(date, ZONE);
const TEST_KDF = { ...newKdfParams(), N: 1 << 10 };
const BACKUP_PASSWORD = "a separate backup password";

const workspaces: string[] = [];
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pfa-backup-test-"));
  workspaces.push(dir);
  return dir;
}

async function seededLedger(dir: string, devicePassphrase = "the device passphrase") {
  const file = join(dir, "ledger.db");
  const key = await deriveKey(devicePassphrase, TEST_KDF);
  const db = await openEncryptedDatabase({ file, key });
  migrate(db);

  let counter = 0;
  const service = createFinanceService({
    db,
    zone: ZONE,
    clock: fixedClock(fromIso("2026-09-20T12:00:00+05:30"), ZONE),
    ids: { next: (prefix) => `${prefix}_${++counter}` },
  });
  service.seedDefaultCategories();

  const bank = service.createAccount({ name: "Everyday bank", type: AccountType.BANK, currency: LKR });
  const card = service.createAccount({
    name: "Credit card",
    type: AccountType.CREDIT_CARD,
    currency: LKR,
  });
  service.setOpeningBalance({
    accountId: bank.id,
    amount: majorUnits(LKR, 100_000n),
    occurredAt: AT("2026-09-01"),
  });
  service.createExpense({
    accountId: card.id,
    amount: majorUnits(LKR, 3_450n),
    occurredAt: AT("2026-09-05"),
    merchantName: "Keells Super",
    splits: [{ categoryId: "groceries", amount: majorUnits(LKR, 3_450n) }],
  });
  const deleted = service.createExpense({
    accountId: bank.id,
    amount: majorUnits(LKR, 900n),
    occurredAt: AT("2026-09-06"),
    splits: [{ categoryId: "dining", amount: majorUnits(LKR, 900n) }],
  });
  service.deleteTransaction({ transactionId: deleted.transactionId, expectedRevision: 1 });

  return { db, service, file, bank, card };
}

describe("creating a backup", () => {
  test("writes a readable manifest and an encrypted payload", async () => {
    const dir = workspace();
    const { db, service, bank } = await seededLedger(dir);
    const target = join(dir, "ledger.backup.pfa");

    const manifest = await createBackup({ db, backupPassphrase: BACKUP_PASSWORD, targetPath: target });

    assert.equal(manifest.format, "PFA-BACKUP-1");
    assert.equal(manifest.schemaVersion >= 1, true);
    assert.equal(manifest.kdf.algorithm, "scrypt");
    assert.equal(manifest.counts.ledger_accounts! > 0, true);

    // The header must be readable without the password, because the salt lives in it.
    const inspected = inspectBackup(target);
    assert.equal(inspected.payloadSha256, manifest.payloadSha256);
    assert.deepEqual(inspected.kdf, manifest.kdf);

    // ...but nothing else may be.
    const raw = readFileSync(target);
    assert.equal(raw.includes(Buffer.from("Keells Super")), false, "merchant text must not leak");
    assert.equal(raw.includes(Buffer.from("Everyday bank")), false, "account names must not leak");
    assert.equal(raw.includes(Buffer.from(BACKUP_PASSWORD)), false, "the password must not be stored");

    assert.equal(formatMoney(service.balanceOf(bank.id)), "LKR 100,000.00");
    db.close();
  });

  test("a short backup password is refused", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir);
    await assert.rejects(
      () => createBackup({ db, backupPassphrase: "short", targetPath: join(dir, "x.pfa") }),
      /at least 12 characters/,
    );
    db.close();
  });

  // A backup of a broken ledger would silently carry the damage to the new device.
  test("a ledger that fails its invariants is not backed up", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir);

    // Forge an unbalanced journal directly, bypassing the domain.
    db.exec(`
      INSERT INTO journals (id,transaction_id,transaction_revision,purpose,currency,effective_at,recorded_at,state,action_id)
        SELECT 'jrn_bad', id, 1, 'original', 'LKR', 0, 0, 'posted', 'act_bad' FROM transactions LIMIT 1;
      INSERT INTO journal_entries (id,journal_id,ledger_account_id,amount_minor_signed)
        SELECT 'ent_bad', 'jrn_bad', id, 1 FROM ledger_accounts LIMIT 1;
    `);

    assert.equal(validateLedgerInvariants(db).length > 0, true);
    try {
      await createBackup({ db, backupPassphrase: BACKUP_PASSWORD, targetPath: join(dir, "x.pfa") });
      assert.fail("expected the backup to be refused");
    } catch (error) {
      assert.ok(isFinanceError(error));
      assert.equal(error.code, FinanceErrorCode.UNBALANCED_JOURNAL);
    }
    db.close();
  });
});

describe("restoring on a clean installation", () => {
  test("reproduces every balance, the trashed record and the audit trail", async () => {
    const source = workspace();
    const { db, service, bank, card } = await seededLedger(source);
    const target = join(source, "ledger.backup.pfa");
    await createBackup({ db, backupPassphrase: BACKUP_PASSWORD, targetPath: target });

    const before = {
      bank: formatMoney(service.balanceOf(bank.id)),
      card: formatMoney(service.balanceOf(card.id)),
      visible: service.searchTransactions().length,
      trashed: service.searchTransactions({ status: "deleted" }).length,
      spending: service.spendingByCategory("2026-09-01", "2026-09-30"),
    };
    db.close();

    // A different device: new directory, new device passphrase, no vault in common.
    const fresh = workspace();
    const opened = await openBackup({ path: target, backupPassphrase: BACKUP_PASSWORD });
    assert.deepEqual(opened.invariantProblems, [], "a good backup validates cleanly");

    const newDeviceKey = await deriveKey("a completely different device passphrase", TEST_KDF);
    const restoredPath = join(fresh, "ledger.db");
    writeRestoredDatabase(opened.db, restoredPath, newDeviceKey);
    opened.dispose();

    const restoredDb = await openEncryptedDatabase({ file: restoredPath, key: newDeviceKey });
    const restored = createFinanceService({ db: restoredDb, zone: ZONE });

    assert.equal(formatMoney(restored.balanceOf(bank.id)), before.bank);
    assert.equal(formatMoney(restored.balanceOf(card.id)), before.card);
    assert.equal(restored.searchTransactions().length, before.visible);
    assert.equal(restored.searchTransactions({ status: "deleted" }).length, before.trashed);
    assert.deepEqual(restored.spendingByCategory("2026-09-01", "2026-09-30"), before.spending);
    assert.deepEqual(validateLedgerInvariants(restoredDb), []);

    // buildspec.md §15: the audit trail is part of the record, not a cache.
    const audits = restoredDb.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as Record<
      string,
      unknown
    >;
    assert.equal(Number(audits.n) > 0, true, "audit history survives the restore");

    // The §17.3 guards must come back with the schema, not be left behind.
    assert.throws(
      () => restoredDb.prepare("UPDATE audit_events SET reason='rewritten'").run(),
      /append-only/,
    );
    restoredDb.close();
  });

  test("the wrong backup password is reported as such", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir);
    const target = join(dir, "ledger.backup.pfa");
    await createBackup({ db, backupPassphrase: BACKUP_PASSWORD, targetPath: target });
    db.close();

    try {
      await openBackup({ path: target, backupPassphrase: "not the backup password" });
      assert.fail("expected the restore to be refused");
    } catch (error) {
      assert.ok(isFinanceError(error));
      assert.equal(error.code, FinanceErrorCode.LOCKED);
      assert.match(error.message, /backup password is not correct/);
    }
  });

  test("the device passphrase does not open a backup", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir, "the device passphrase");
    const target = join(dir, "ledger.backup.pfa");
    await createBackup({ db, backupPassphrase: BACKUP_PASSWORD, targetPath: target });
    db.close();

    await assert.rejects(
      () => openBackup({ path: target, backupPassphrase: "the device passphrase" }),
      /backup password is not correct/,
    );
  });

  test("a corrupted payload fails the checksum before any decryption is attempted", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir);
    const target = join(dir, "ledger.backup.pfa");
    await createBackup({ db, backupPassphrase: BACKUP_PASSWORD, targetPath: target });
    db.close();

    const bytes = readFileSync(target);
    // Flip a byte deep inside the payload, past the header.
    bytes[bytes.length - 64] = (bytes[bytes.length - 64]! ^ 0xff) & 0xff;
    writeFileSync(target, bytes);

    await assert.rejects(
      () => openBackup({ path: target, backupPassphrase: BACKUP_PASSWORD }),
      /failed its checksum/,
    );
  });

  test("a truncated file is detected", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir);
    const target = join(dir, "ledger.backup.pfa");
    await createBackup({ db, backupPassphrase: BACKUP_PASSWORD, targetPath: target });
    db.close();

    const bytes = readFileSync(target);
    writeFileSync(target, bytes.subarray(0, bytes.length - 2048));

    await assert.rejects(
      () => openBackup({ path: target, backupPassphrase: BACKUP_PASSWORD }),
      /truncated/,
    );
  });

  test("a file that is not a backup at all is rejected clearly", async () => {
    const dir = workspace();
    const notABackup = join(dir, "holiday.jpg");
    writeFileSync(notABackup, Buffer.from("this is definitely not a backup file"));
    assert.throws(() => inspectBackup(notABackup), /not a Personal Finance backup/);
  });

  // buildspec.md §18: "check integrity and schema compatibility".
  test("a backup from a newer schema is refused rather than half-restored", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir);
    const target = join(dir, "ledger.backup.pfa");
    await createBackup({ db, backupPassphrase: BACKUP_PASSWORD, targetPath: target });
    db.close();

    // Rewrite the manifest to claim a future schema, keeping the payload and checksum intact.
    const bytes = readFileSync(target);
    const firstBreak = bytes.indexOf(0x0a);
    const secondBreak = bytes.indexOf(0x0a, firstBreak + 1);
    const manifest = JSON.parse(bytes.subarray(firstBreak + 1, secondBreak).toString("utf8"));
    manifest.schemaVersion = 9_999;
    const rebuilt = Buffer.concat([
      Buffer.from(`PFA-BACKUP-1\n${JSON.stringify(manifest)}\n`, "utf8"),
      bytes.subarray(secondBreak + 1),
    ]);
    writeFileSync(target, rebuilt);

    await assert.rejects(
      () => openBackup({ path: target, backupPassphrase: BACKUP_PASSWORD }),
      /newer version/,
    );
  });
});

describe("invariant checking", () => {
  test("a healthy ledger reports no problems", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir);
    assert.deepEqual(validateLedgerInvariants(db), []);
    db.close();
  });

  test("an unbalanced journal is caught", async () => {
    const dir = workspace();
    const { db } = await seededLedger(dir);
    db.exec(`
      INSERT INTO journals (id,transaction_id,transaction_revision,purpose,currency,effective_at,recorded_at,state,action_id)
        SELECT 'jrn_bad', id, 1, 'original', 'LKR', 0, 0, 'posted', 'act_bad' FROM transactions LIMIT 1;
      INSERT INTO journal_entries (id,journal_id,ledger_account_id,amount_minor_signed)
        SELECT 'ent_bad', 'jrn_bad', id, 7 FROM ledger_accounts LIMIT 1;
    `);
    const problems = validateLedgerInvariants(db);
    assert.equal(problems.some((p) => p.check === "journal_balances"), true);
    assert.equal(problems.some((p) => p.check === "journal_entry_count"), true);
    db.close();
  });
});
