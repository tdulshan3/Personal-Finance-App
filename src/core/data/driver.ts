import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { FinanceError, FinanceErrorCode, validationError } from "../domain/errors.ts";

/**
 * The encrypted SQLite connection.
 *
 * buildspec.md §17: "Encrypt the entire database, including journal/WAL files and full-text
 * indexes, through the selected storage integration." SQLCipher encrypts the WAL alongside the
 * main file, which is why the whole app goes through this one opener rather than touching
 * `better-sqlite3` directly anywhere else.
 *
 * ADR 0003 records why the key arrives here as raw bytes derived by scrypt rather than from Android
 * Keystore: Termux has no Keystore.
 */

/* The native module's surface, narrowed to what this file uses. It is loaded dynamically so a
 * failed `npm rebuild` on the phone produces an actionable message instead of a module-resolution
 * stack trace at import time. */
type Statement = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  safeIntegers(enabled: boolean): Statement;
};

type RawDatabase = {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) & {
    immediate(...args: A): R;
  };
  close(): void;
  defaultSafeIntegers(enabled: boolean): void;
  readonly open: boolean;
  readonly name: string;
};

type DatabaseConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => RawDatabase;

let cachedConstructor: DatabaseConstructor | undefined;

async function loadDriver(): Promise<DatabaseConstructor> {
  if (cachedConstructor) return cachedConstructor;
  try {
    const mod = (await import("better-sqlite3-multiple-ciphers")) as unknown as {
      default: DatabaseConstructor;
    };
    cachedConstructor = mod.default;
    return cachedConstructor;
  } catch (cause) {
    throw new FinanceError(
      FinanceErrorCode.UNSUPPORTED_OPERATION,
      "The encrypted SQLite driver is not available. On the phone run `npm rebuild " +
        "better-sqlite3-multiple-ciphers` inside Termux; the prebuilt binaries do not match " +
        "Termux's libc. See docs/termux-setup.md.",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

export type OpenDatabaseOptions = {
  /** Path to the database file. Parent directories are created if missing. */
  readonly file: string;
  /** The raw 32-byte key from `deriveKey`. Never a passphrase. */
  readonly key: Buffer;
  readonly readonly?: boolean;
  /** How long to wait on a locked database before failing, in ms. */
  readonly busyTimeoutMs?: number;
};

export type Db = {
  /**
   * Prepares a statement. Integers come back as `bigint` — see `openEncryptedDatabase` for why —
   * so callers must convert non-money columns explicitly with `asNumber`.
   */
  prepare(sql: string): Statement;
  exec(sql: string): void;
  /**
   * Runs `fn` inside a single immediate transaction.
   *
   * buildspec.md §9.3: "All steps, source links, bill allocations, revision increments, audit
   * records, and derived-data invalidation commit atomically. Failure rolls everything back."
   * `immediate` takes the write lock up front so two concurrent writers fail fast rather than
   * deadlocking halfway through a posting plan.
   */
  transaction<T>(fn: () => T): T;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
  readonly isOpen: boolean;
  readonly file: string;
};

/**
 * Formats the raw key the way SQLCipher expects it: `PRAGMA key = "x'<hex>'"`.
 *
 * The double quotes matter. Without them SQLite parses `x'...'` as a blob literal and rejects it in
 * a pragma; with them SQLCipher receives the text and reads it as a raw key rather than running its
 * own PBKDF2 over a passphrase.
 */
function keyToHexLiteral(key: Buffer): string {
  if (key.length < 16) {
    throw validationError("Database key must be at least 16 bytes");
  }
  return `"x'${key.toString("hex")}'"`;
}

/**
 * Opens (or creates) the encrypted database and applies the connection pragmas.
 *
 * The key is passed as a hex literal so SQLCipher uses it as the raw key rather than running its
 * own PBKDF2 over it. The expensive work already happened in `deriveKey`; doing it twice would just
 * make unlocking slower without adding strength.
 */
export async function openEncryptedDatabase(options: OpenDatabaseOptions): Promise<Db> {
  const Database = await loadDriver();
  mkdirSync(dirname(options.file), { recursive: true });

  const raw = new Database(options.file, {
    readonly: options.readonly ?? false,
    timeout: options.busyTimeoutMs ?? 5_000,
  });

  try {
    raw.pragma("cipher='sqlcipher'");
    // `PRAGMA key = x'<hex>'` hands SQLCipher the raw key. The hex comes from `deriveKey`, so the
    // value is never attacker-controlled text and cannot carry a quote.
    raw.pragma(`key=${keyToHexLiteral(options.key)}`);
  } catch (cause) {
    raw.close();
    throw new FinanceError(
      FinanceErrorCode.LOCKED,
      "Could not apply the database key.",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }

  /*
   * Touch the schema before anything else. With a wrong key SQLCipher cannot read the header and
   * fails here, which is what turns "file is not a database" into a clean wrong-passphrase error.
   */
  try {
    raw.prepare("select count(*) from sqlite_schema").get();
  } catch (cause) {
    raw.close();
    throw new FinanceError(
      FinanceErrorCode.LOCKED,
      "That passphrase does not open this database.",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }

  /*
   * buildspec.md §16 stores money as 64-bit integers. better-sqlite3 silently rounds anything past
   * 2^53 when safe integers are off — 9007199254740995 reads back as ...996 — so this is switched
   * on globally and non-money columns are narrowed explicitly with `asNumber`. Losing a rupee to a
   * float is exactly the failure buildspec.md §1.6 forbids.
   */
  raw.defaultSafeIntegers(true);

  raw.pragma("journal_mode=WAL");
  raw.pragma("foreign_keys=ON");
  // buildspec.md §20: "Disk full or crash mid-write | Transaction rollback; recover jobs without
  // partial ledger/audit state." A phone loses power without warning, so durability wins here.
  raw.pragma("synchronous=FULL");
  raw.pragma(`busy_timeout=${options.busyTimeoutMs ?? 5_000}`);
  // Keep temp material in memory rather than writing plaintext spill files next to the database.
  raw.pragma("temp_store=MEMORY");

  return {
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn).immediate();
    },
    pragma: (source, opts) => raw.pragma(source, opts),
    close: () => {
      // Fold the WAL back into the main file so a copy of the database file is complete
      // (buildspec.md §18: "Never copy a live SQLite main file while ignoring its WAL").
      try {
        raw.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // A checkpoint failure must not stop the connection from closing.
      }
      raw.close();
    },
    get isOpen() {
      return raw.open;
    },
    file: raw.name,
  };
}

/**
 * Narrows a `bigint` column to a JS number, refusing values that would lose precision.
 *
 * Used for revisions, counts and timestamps — never for money, which stays `bigint` end to end.
 */
export function asNumber(value: unknown, column: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw validationError(`Column '${column}' does not fit a JS number`, {
        column,
        value: value.toString(),
      });
    }
    return Number(value);
  }
  throw validationError(`Column '${column}' is not an integer`, { column, type: typeof value });
}

/** Reads a money column, which must stay a `bigint`. */
export function asBigInt(value: unknown, column: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw validationError(`Column '${column}' arrived as an unsafe number`, { column });
    }
    return BigInt(value);
  }
  throw validationError(`Column '${column}' is not an integer`, { column, type: typeof value });
}

export function asText(value: unknown, column: string): string {
  if (typeof value === "string") return value;
  throw validationError(`Column '${column}' is not text`, { column, type: typeof value });
}

export function asOptionalText(value: unknown, column: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return asText(value, column);
}

export function asOptionalNumber(value: unknown, column: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return asNumber(value, column);
}

export function asBoolean(value: unknown, column: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "number") return value !== 0;
  throw validationError(`Column '${column}' is not a boolean`, { column, type: typeof value });
}
