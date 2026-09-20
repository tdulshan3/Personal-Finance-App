import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { FinanceErrorCode, isFinanceError } from "../domain/errors.ts";
import {
  deriveFingerprintSecret,
  deriveKey,
  deriveVerifier,
  newKdfParams,
  parseKdfParams,
  verifierMatches,
} from "../security/passphrase.ts";
import type { Db } from "./driver.ts";
import { asBigInt, openEncryptedDatabase } from "./driver.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

/**
 * buildspec.md §21 M0 gate: "Create project, architecture modules, dependency pins, CI, encrypted
 * storage proof". This file is that proof, plus the §17.3 invariants that are enforced in SQL
 * rather than in TypeScript.
 */

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pfa-db-test-"));
  workspaces.push(dir);
  return dir;
}

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/* Keep the KDF cheap in tests; production parameters are exercised in the passphrase tests. */
const TEST_KDF = { ...newKdfParams(), N: 1 << 10 };

async function openFresh(file: string, passphrase = "correct horse battery staple"): Promise<Db> {
  const key = await deriveKey(passphrase, TEST_KDF);
  const db = await openEncryptedDatabase({ file, key });
  migrate(db);
  return db;
}

describe("encrypted storage", () => {
  test("the database file is encrypted on disk", async () => {
    const file = join(workspace(), "ledger.db");
    const db = await openFresh(file);
    db.prepare(
      `INSERT INTO merchants (id, canonical_name, revision, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run("mch_1", "KEELLS SUPER", Date.now(), Date.now());
    db.close();

    const raw = readFileSync(file);
    assert.equal(
      raw.includes(Buffer.from("KEELLS SUPER")),
      false,
      "merchant text must not be readable in the raw file",
    );
    assert.notEqual(
      raw.subarray(0, 16).toString("latin1"),
      "SQLite format 3\u0000",
      "an encrypted database must not carry the plaintext SQLite header",
    );
  });

  test("a wrong passphrase is reported as locked, not as a corrupt file", async () => {
    const file = join(workspace(), "ledger.db");
    const db = await openFresh(file, "the right passphrase");
    db.close();

    const wrongKey = await deriveKey("the wrong passphrase", TEST_KDF);
    try {
      await openEncryptedDatabase({ file, key: wrongKey });
      assert.fail("a wrong key must not open the database");
    } catch (error) {
      assert.ok(isFinanceError(error));
      assert.equal(error.code, FinanceErrorCode.LOCKED);
    }
  });

  test("the same passphrase reopens the database and preserves data", async () => {
    const file = join(workspace(), "ledger.db");
    const first = await openFresh(file);
    first
      .prepare(
        `INSERT INTO merchants (id, canonical_name, revision, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .run("mch_1", "Demo Internet Provider", Date.now(), Date.now());
    first.close();

    const second = await openFresh(file);
    const row = second.prepare("SELECT canonical_name FROM merchants WHERE id = ?").get("mch_1") as
      | Record<string, unknown>
      | undefined;
    assert.equal(row?.canonical_name, "Demo Internet Provider");
    second.close();
  });

  // buildspec.md §16: money is 64-bit. The driver silently rounds past 2^53 without safe integers.
  test("a money value beyond 2^53 survives a write/read round trip", async () => {
    const file = join(workspace(), "ledger.db");
    const db = await openFresh(file);
    const huge = 9_007_199_254_740_995n;
    // account_id carries a foreign key, so the account has to exist first.
    db.prepare(
      `INSERT INTO ledger_accounts
         (id, name, kind, type, currency, is_user_visible, liquidity_role, revision, created_at, updated_at)
       VALUES ('acct_1','Bank','asset','bank','LKR',1,'liquid',1,?,?)`,
    ).run(Date.now(), Date.now());
    db.prepare(
      `INSERT INTO balance_observations
         (id, account_id, amount_minor, currency, balance_type, observed_at, precision, entered_by, created_at)
       VALUES ('obs_1','acct_1',?,'LKR','ledger',?, 'exact','owner',?)`,
    ).run(huge, Date.now(), Date.now());

    const row = db.prepare("SELECT amount_minor FROM balance_observations WHERE id='obs_1'").get() as
      | Record<string, unknown>
      | undefined;
    assert.equal(asBigInt(row?.amount_minor, "amount_minor"), huge);
    db.close();
  });
});

describe("migrations", () => {
  test("apply once and are idempotent", async () => {
    const file = join(workspace(), "ledger.db");
    const key = await deriveKey("a passphrase for migrations", TEST_KDF);
    const db = await openEncryptedDatabase({ file, key });

    const first = migrate(db);
    assert.deepEqual(first.appliedVersions, [1, 2, 3, 4, 5, 6]);

    const second = migrate(db);
    assert.deepEqual(second.appliedVersions, [], "re-running applies nothing");
    assert.equal(second.currentVersion, 6);
    db.close();
  });

  // buildspec.md §17.2: schema_migrations exists to make drift detectable.
  test("an edited migration is refused rather than silently diverging", async () => {
    const file = join(workspace(), "ledger.db");
    const key = await deriveKey("a passphrase for drift", TEST_KDF);
    const db = await openEncryptedDatabase({ file, key });
    migrate(db);

    const tampered = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: `${m.sql}\n-- an innocent looking edit` } : m,
    );
    try {
      migrate(db, tampered);
      assert.fail("a changed migration must be rejected");
    } catch (error) {
      assert.ok(isFinanceError(error));
      assert.equal(error.code, FinanceErrorCode.VALIDATION_ERROR);
      assert.match(error.message, /has changed since it was applied/);
    }
    db.close();
  });

  test("foreign keys are enforced", async () => {
    const db = await openFresh(join(workspace(), "ledger.db"));
    assert.throws(() => {
      db.prepare(
        `INSERT INTO category_accounts (category_id, currency, ledger_account_id, created_at)
         VALUES ('cat_missing','LKR','acct_missing',?)`,
      ).run(Date.now());
    }, /FOREIGN KEY/i);
    db.close();
  });
});

describe("§17.3 invariants enforced in SQL", () => {
  async function seedPostedJournal(db: Db): Promise<void> {
    const now = Date.now();
    db.exec(`
      INSERT INTO ledger_accounts (id,name,kind,type,currency,is_user_visible,liquidity_role,revision,created_at,updated_at)
        VALUES ('acct_bank','Bank','asset','bank','LKR',1,'liquid',1,${now},${now}),
               ('acct_exp','Groceries','expense','category_expense','LKR',0,'not_applicable',1,${now},${now});
      INSERT INTO transactions (id,kind,current_revision,accounting_scope,status,created_at,updated_at)
        VALUES ('txn_1','expense',1,'ledger','posted',${now},${now});
      INSERT INTO journals (id,transaction_id,transaction_revision,purpose,currency,effective_at,recorded_at,state,action_id)
        VALUES ('jrn_1','txn_1',1,'original','LKR',${now},${now},'posted','act_1');
      INSERT INTO journal_entries (id,journal_id,ledger_account_id,amount_minor_signed)
        VALUES ('ent_1','jrn_1','acct_exp',345000),
               ('ent_2','jrn_1','acct_bank',-345000);
    `);
  }

  test("a posted journal cannot be updated or deleted", async () => {
    const db = await openFresh(join(workspace(), "ledger.db"));
    await seedPostedJournal(db);

    assert.throws(
      () => db.prepare("UPDATE journals SET purpose='replacement' WHERE id='jrn_1'").run(),
      /posted journals are immutable/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM journals WHERE id='jrn_1'").run(),
      /posted journals cannot be deleted/,
    );
    db.close();
  });

  test("entries of a posted journal cannot be edited or removed", async () => {
    const db = await openFresh(join(workspace(), "ledger.db"));
    await seedPostedJournal(db);

    assert.throws(
      () => db.prepare("UPDATE journal_entries SET amount_minor_signed=1 WHERE id='ent_1'").run(),
      /entries of a posted journal are immutable/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM journal_entries WHERE id='ent_1'").run(),
      /entries of a posted journal cannot be deleted/,
    );
    db.close();
  });

  test("a zero-value journal entry is rejected by the schema", async () => {
    const db = await openFresh(join(workspace(), "ledger.db"));
    await seedPostedJournal(db);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO journal_entries (id,journal_id,ledger_account_id,amount_minor_signed)
         VALUES ('ent_zero','jrn_1','acct_bank',0)`,
      ).run();
    }, /CHECK constraint failed/i);
    db.close();
  });

  // buildspec.md §15: "Agent/import code cannot edit audit rows."
  test("audit events are append-only", async () => {
    const db = await openFresh(join(workspace(), "ledger.db"));
    const now = Date.now();
    db.prepare(
      `INSERT INTO audit_events (id,action_id,actor_kind,origin,entity_refs_json,reason,recorded_at,event_hash)
       VALUES ('aud_1','act_1','owner','ui.test','[]','because',?,'hash')`,
    ).run(now);
    assert.throws(
      () => db.prepare("UPDATE audit_events SET reason='rewritten' WHERE id='aud_1'").run(),
      /append-only/,
    );
    db.close();
  });

  // buildspec.md §17.1: "one reversal of a given journal".
  test("a journal can only be reversed once", async () => {
    const db = await openFresh(join(workspace(), "ledger.db"));
    await seedPostedJournal(db);
    const now = Date.now();
    const insertReversal = (id: string) =>
      db
        .prepare(
          `INSERT INTO journals (id,transaction_id,transaction_revision,purpose,currency,effective_at,recorded_at,state,reverses_journal_id,action_id)
           VALUES (?,'txn_1',2,'correction_reversal','LKR',?,?,'posted','jrn_1','act_2')`,
        )
        .run(id, now, now);

    insertReversal("jrn_rev_1");
    assert.throws(() => insertReversal("jrn_rev_2"), /UNIQUE constraint failed/i);
    db.close();
  });

  // buildspec.md §16: "Same key with different content returns IDEMPOTENCY_CONFLICT."
  test("the idempotency key is unique per scope", async () => {
    const db = await openFresh(join(workspace(), "ledger.db"));
    const insert = (id: string, hash: string) =>
      db
        .prepare(
          `INSERT INTO executed_actions (id,idempotency_scope,idempotency_key,request_hash,result_json,executed_at)
           VALUES (?,'owner:transaction.create','turn-4-create',?, '{}', ?)`,
        )
        .run(id, hash, Date.now());

    insert("exec_1", "hash-a");
    assert.throws(() => insert("exec_2", "hash-b"), /UNIQUE constraint failed/i);
    db.close();
  });
});

describe("passphrase and key derivation", () => {
  test("the same passphrase and salt produce the same key", async () => {
    const params = { ...newKdfParams(), N: 1 << 10 };
    const a = await deriveKey("a shared secret phrase", params);
    const b = await deriveKey("a shared secret phrase", params);
    assert.equal(a.equals(b), true);
    assert.equal(a.length, params.keyLengthBytes);
  });

  test("a different salt produces a different key", async () => {
    const a = await deriveKey("a shared secret phrase", { ...newKdfParams(), N: 1 << 10 });
    const b = await deriveKey("a shared secret phrase", { ...newKdfParams(), N: 1 << 10 });
    assert.equal(a.equals(b), false);
  });

  test("the verifier distinguishes right from wrong without exposing the key", async () => {
    const params = { ...newKdfParams(), N: 1 << 10 };
    const right = await deriveVerifier(await deriveKey("the right phrase", params));
    const same = await deriveVerifier(await deriveKey("the right phrase", params));
    const wrong = await deriveVerifier(await deriveKey("the wrong phrase", params));

    assert.equal(verifierMatches(right, same), true);
    assert.equal(verifierMatches(right, wrong), false);
  });

  test("the fingerprint secret is domain-separated from the key and the verifier", async () => {
    const key = await deriveKey("a shared secret phrase", { ...newKdfParams(), N: 1 << 10 });
    const verifier = await deriveVerifier(key);
    const fingerprint = await deriveFingerprintSecret(key);
    assert.equal(fingerprint.equals(verifier), false);
    assert.equal(fingerprint.equals(key), false);
  });

  test("stored KDF parameters round-trip and malformed ones are rejected", () => {
    const params = newKdfParams();
    assert.deepEqual(parseKdfParams(JSON.parse(JSON.stringify(params))), params);

    for (const bad of [
      null,
      {},
      { ...params, algorithm: "md5" },
      { ...params, N: 1000 }, // not a power of two
      { ...params, N: 1 },
      { ...params, keyLengthBytes: 8 },
      { ...params, salt: "" },
    ]) {
      assert.throws(() => parseKdfParams(bad), /FinanceError|KDF|passphrase|salt/i);
    }
  });
});
