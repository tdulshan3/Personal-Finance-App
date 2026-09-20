import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FinanceError, FinanceErrorCode, validationError } from "../domain/errors.ts";
import type { KdfParams } from "../security/passphrase.ts";
import { deriveKey, newKdfParams, parseKdfParams } from "../security/passphrase.ts";
import type { Db } from "./driver.ts";
import { asBigInt, asNumber, asText, openEncryptedDatabase } from "./driver.ts";
import { currentSchemaVersion } from "./migrations.ts";

/**
 * Encrypted backup and restore.
 *
 * buildspec.md §18: "Create versioned encrypted backups using a maintained authenticated-encryption
 * library. Use an independently recoverable password/key mechanism with a modern password KDF and
 * random salt; include algorithm/version parameters, manifest checksums, and schema version. Do not
 * rely on a Keystore key that cannot be recovered on another phone. Avoid inventing a cryptographic
 * protocol."
 *
 * The payload is an ordinary SQLCipher database keyed by a scrypt hash of the **backup** password,
 * which is what makes it recoverable on a different device that has never seen this phone's vault.
 * The copy is produced by replaying the schema into an `ATTACH`ed, differently-keyed database and
 * streaming rows across, so a decrypted copy never touches the disk. That is the one piece of
 * custom protocol here; the encryption itself is SQLCipher's, not ours.
 *
 * File layout — the header must stay readable without the password, because the salt lives in it:
 *
 * ```text
 * PFA-BACKUP-1\n
 * {"kdf":{...},"schemaVersion":1,"payloadSha256":"...","payloadBytes":12288,...}\n
 * <SQLCipher database bytes>
 * ```
 */

const MAGIC = "PFA-BACKUP-1";
const MAX_MANIFEST_BYTES = 8 * 1024;

export type BackupManifest = {
  readonly format: typeof MAGIC;
  readonly createdAt: number;
  readonly kdf: KdfParams;
  /** The `schema_migrations` version the payload was written at. */
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  /** Row counts at capture time, so a restore can report what it is about to install. */
  readonly counts: Readonly<Record<string, number>>;
};

/* -------------------------------------------------------------------------------------------- */
/* Invariants                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export type InvariantProblem = { readonly check: string; readonly detail: string };

/**
 * Re-derives the money invariants directly from the rows.
 *
 * buildspec.md §18 requires a restore to "validate ledger invariants" before swapping anything in,
 * and §21 M1's gate is that "a fresh restore reproduces totals". Checking the arithmetic rather
 * than trusting the file is the only way to honour either.
 */
export function validateLedgerInvariants(db: Db): InvariantProblem[] {
  const problems: InvariantProblem[] = [];

  const unbalanced = db
    .prepare(
      `SELECT j.id AS id, SUM(e.amount_minor_signed) AS residual
         FROM journals j JOIN journal_entries e ON e.journal_id = j.id
        WHERE j.state = 'posted'
        GROUP BY j.id HAVING SUM(e.amount_minor_signed) <> 0`,
    )
    .all() as Record<string, unknown>[];
  for (const row of unbalanced) {
    problems.push({
      check: "journal_balances",
      detail: `journal ${asText(row.id, "id")} has residual ${asBigInt(row.residual, "residual")}`,
    });
  }

  const thin = db
    .prepare(
      `SELECT j.id AS id, COUNT(e.id) AS n
         FROM journals j LEFT JOIN journal_entries e ON e.journal_id = j.id
        WHERE j.state = 'posted'
        GROUP BY j.id HAVING COUNT(e.id) < 2`,
    )
    .all() as Record<string, unknown>[];
  for (const row of thin) {
    problems.push({
      check: "journal_entry_count",
      detail: `journal ${asText(row.id, "id")} has ${asNumber(row.n, "n")} entries, needs at least 2`,
    });
  }

  const currencyMismatch = db
    .prepare(
      `SELECT e.id AS id FROM journal_entries e
         JOIN journals j ON j.id = e.journal_id
         JOIN ledger_accounts a ON a.id = e.ledger_account_id
        WHERE a.currency <> j.currency`,
    )
    .all() as Record<string, unknown>[];
  for (const row of currencyMismatch) {
    problems.push({
      check: "entry_currency",
      detail: `entry ${asText(row.id, "id")} posts an account whose currency differs from its journal`,
    });
  }

  const danglingRevision = db
    .prepare(
      `SELECT t.id AS id FROM transactions t
        WHERE NOT EXISTS (SELECT 1 FROM transaction_revisions r
                           WHERE r.transaction_id = t.id AND r.revision = t.current_revision)`,
    )
    .all() as Record<string, unknown>[];
  for (const row of danglingRevision) {
    problems.push({
      check: "current_revision_exists",
      detail: `transaction ${asText(row.id, "id")} points at a revision that is not stored`,
    });
  }

  // buildspec.md §9.4: "A record cannot simultaneously be history-only and have an active financial journal."
  const scopeConflict = db
    .prepare(
      `SELECT t.id AS id FROM transactions t
         JOIN journals j ON j.transaction_id = t.id
        WHERE t.accounting_scope = 'history_only' AND j.state = 'posted'`,
    )
    .all() as Record<string, unknown>[];
  for (const row of scopeConflict) {
    problems.push({
      check: "history_only_has_no_journal",
      detail: `transaction ${asText(row.id, "id")} is history-only but carries a posted journal`,
    });
  }

  const fkProblems = db.pragma("foreign_key_check") as unknown[];
  if (Array.isArray(fkProblems) && fkProblems.length > 0) {
    problems.push({
      check: "foreign_keys",
      detail: `${fkProblems.length} foreign key violation(s)`,
    });
  }

  return problems;
}

/* -------------------------------------------------------------------------------------------- */
/* Capture                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const COUNTED_TABLES = [
  "ledger_accounts",
  "transactions",
  "transaction_revisions",
  "journals",
  "journal_entries",
  "categories",
  "audit_events",
] as const;

function countRows(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown>;
    counts[table] = asNumber(row.n, "n");
  }
  return counts;
}

/**
 * Copies every object and row from `db` into an attached database held under a different key.
 *
 * Order matters: tables and their rows first, then indexes, triggers and views. Creating the
 * triggers up front would make this project's own immutability guards fire during the copy.
 */
function exportToAttached(db: Db, targetPath: string, targetKeyHex: string): void {
  db.exec(`ATTACH DATABASE '${targetPath.replace(/'/g, "''")}' AS bk KEY "x'${targetKeyHex}'"`);
  try {
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_schema
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Record<string, unknown>[];

    const bySql = (type: string) =>
      objects.filter((o) => asText(o.type, "type") === type).map((o) => ({
        name: asText(o.name, "name"),
        sql: asText(o.sql, "sql"),
      }));

    db.transaction(() => {
      for (const table of bySql("table")) {
        db.exec(table.sql.replace(/^CREATE\s+TABLE\s+/i, "CREATE TABLE bk."));
      }
      for (const table of bySql("table")) {
        db.exec(`INSERT INTO bk."${table.name}" SELECT * FROM main."${table.name}"`);
      }
      for (const index of bySql("index")) {
        db.exec(index.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_m, u) => `CREATE ${u ?? ""}INDEX bk.`));
      }
      for (const trigger of bySql("trigger")) {
        db.exec(trigger.sql.replace(/^CREATE\s+TRIGGER\s+/i, "CREATE TRIGGER bk."));
      }
      for (const view of bySql("view")) {
        db.exec(view.sql.replace(/^CREATE\s+VIEW\s+/i, "CREATE VIEW bk."));
      }
    });
  } finally {
    db.exec("DETACH DATABASE bk");
  }
}

export type CreateBackupOptions = {
  readonly db: Db;
  /** The password that will be needed to restore. Independent of the device passphrase. */
  readonly backupPassphrase: string;
  readonly targetPath: string;
  readonly appVersion?: string;
};

/** Writes a versioned, encrypted, self-describing backup file. */
export async function createBackup(options: CreateBackupOptions): Promise<BackupManifest> {
  const { db, backupPassphrase, targetPath } = options;
  if (backupPassphrase.length < 12) {
    throw validationError(
      "The backup password must be at least 12 characters. It is the only way to open this file.",
    );
  }

  const problems = validateLedgerInvariants(db);
  if (problems.length > 0) {
    // Refusing here is deliberate: a backup of a broken ledger silently propagates the damage.
    throw new FinanceError(
      FinanceErrorCode.UNBALANCED_JOURNAL,
      `Refusing to back up: ${problems.length} ledger invariant(s) failed.`,
      { first: problems[0]!.detail },
    );
  }

  const kdf = newKdfParams();
  const key = await deriveKey(backupPassphrase, kdf);
  const staging = mkdtempSync(join(tmpdir(), "pfa-backup-"));
  const payloadPath = join(staging, "payload.db");

  try {
    exportToAttached(db, payloadPath, key.toString("hex"));

    const payload = readFileSync(payloadPath);
    const manifest: BackupManifest = {
      format: MAGIC,
      createdAt: Date.now(),
      kdf,
      schemaVersion: currentSchemaVersion(),
      appVersion: options.appVersion ?? "0.1.0",
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      payloadBytes: payload.length,
      counts: countRows(db),
    };

    const header = Buffer.from(`${MAGIC}\n${JSON.stringify(manifest)}\n`, "utf8");
    writeFileSync(targetPath, Buffer.concat([header, payload]), { mode: 0o600 });
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    key.fill(0);
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Inspect and restore                                                                            */
/* -------------------------------------------------------------------------------------------- */

type ParsedBackup = { manifest: BackupManifest; payloadOffset: number };

/** Reads the header without needing the password — the salt lives here, so it cannot be encrypted. */
export function inspectBackup(path: string): BackupManifest {
  return parseHeader(path).manifest;
}

function parseHeader(path: string): ParsedBackup {
  const size = statSync(path).size;
  const window = Buffer.alloc(Math.min(size, MAX_MANIFEST_BYTES + MAGIC.length + 2));
  const fd = openSync(path, "r");
  try {
    readSync(fd, window, 0, window.length, 0);
  } finally {
    closeSync(fd);
  }

  const firstBreak = window.indexOf(0x0a);
  if (firstBreak === -1 || window.subarray(0, firstBreak).toString("utf8") !== MAGIC) {
    throw validationError("That file is not a Personal Finance backup.");
  }
  const secondBreak = window.indexOf(0x0a, firstBreak + 1);
  if (secondBreak === -1) throw validationError("The backup header is truncated.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(window.subarray(firstBreak + 1, secondBreak).toString("utf8"));
  } catch {
    throw validationError("The backup manifest is not valid JSON.");
  }

  const candidate = parsed as Record<string, unknown>;
  const manifest: BackupManifest = {
    format: MAGIC,
    createdAt: Number(candidate.createdAt ?? 0),
    kdf: parseKdfParams(candidate.kdf),
    schemaVersion: Number(candidate.schemaVersion ?? 0),
    appVersion: String(candidate.appVersion ?? "unknown"),
    payloadSha256: String(candidate.payloadSha256 ?? ""),
    payloadBytes: Number(candidate.payloadBytes ?? 0),
    counts: (candidate.counts ?? {}) as Record<string, number>,
  };
  return { manifest, payloadOffset: secondBreak + 1 };
}

export type RestoreReport = {
  readonly manifest: BackupManifest;
  readonly counts: Readonly<Record<string, number>>;
  readonly invariantProblems: readonly InvariantProblem[];
};

export type OpenBackupOptions = {
  readonly path: string;
  readonly backupPassphrase: string;
};

/**
 * Decrypts a backup into a temporary location and checks it, without touching the live database.
 *
 * buildspec.md §18: "Restore into temporary storage, authenticate/decrypt, check integrity and
 * schema compatibility, validate ledger invariants, then swap atomically after a pre-restore
 * backup." This function performs everything up to the swap, and the caller owns `dispose`.
 */
export async function openBackup(options: OpenBackupOptions): Promise<
  RestoreReport & { db: Db; dispose: () => void }
> {
  const { manifest, payloadOffset } = parseHeader(options.path);

  const whole = readFileSync(options.path);
  const payload = whole.subarray(payloadOffset);

  if (payload.length !== manifest.payloadBytes) {
    throw validationError(
      `The backup is truncated: the manifest says ${manifest.payloadBytes} bytes but ` +
        `${payload.length} are present.`,
    );
  }
  const actualDigest = createHash("sha256").update(payload).digest("hex");
  if (actualDigest !== manifest.payloadSha256) {
    throw validationError("The backup failed its checksum. The file is damaged or incomplete.");
  }
  if (manifest.schemaVersion > currentSchemaVersion()) {
    throw validationError(
      `This backup was written by a newer version (schema ${manifest.schemaVersion}; this app ` +
        `understands ${currentSchemaVersion()}). Update the app before restoring.`,
    );
  }

  const staging = mkdtempSync(join(tmpdir(), "pfa-restore-"));
  const payloadPath = join(staging, "payload.db");
  writeFileSync(payloadPath, payload, { mode: 0o600 });

  const key = await deriveKey(options.backupPassphrase, manifest.kdf);
  let db: Db;
  try {
    db = await openEncryptedDatabase({ file: payloadPath, key });
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true });
    key.fill(0);
    throw new FinanceError(
      FinanceErrorCode.LOCKED,
      "That backup password is not correct.",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  key.fill(0);

  const invariantProblems = validateLedgerInvariants(db);

  return {
    manifest,
    counts: countRows(db),
    invariantProblems,
    db,
    dispose: () => {
      try {
        db.close();
      } finally {
        rmSync(staging, { recursive: true, force: true });
        try {
          unlinkSync(payloadPath);
        } catch {
          // Already removed with the staging directory.
        }
      }
    },
  };
}

/**
 * Writes the contents of an opened backup into a new database file under `targetKey`.
 *
 * The caller is responsible for the atomic swap and for taking a pre-restore backup first; keeping
 * those out of here is what lets the runtime decide the ordering while this stays testable.
 */
export function writeRestoredDatabase(
  backupDb: Db,
  targetPath: string,
  targetKey: Buffer,
): void {
  exportToAttached(backupDb, targetPath, targetKey.toString("hex"));
}
