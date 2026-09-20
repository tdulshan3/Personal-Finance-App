import { createHash } from "node:crypto";

import { FinanceError, FinanceErrorCode } from "../domain/errors.ts";
import type { Db } from "./driver.ts";
import { asNumber, asText } from "./driver.ts";

/**
 * Transactional schema migrations.
 *
 * buildspec.md §17: "Use SQLite foreign keys, indexed lookups, transactional migrations, and a
 * single serialized financial writer." §17.2 requires `schema_migrations` to keep "an auditable
 * migration history" with a checksum, so an edited migration is caught rather than silently
 * diverging from what was actually applied.
 *
 * Migrations are embedded as strings rather than read from `.sql` files so the Next.js standalone
 * bundle carries them without extra file-copy steps (ADR 0002).
 */

export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

/* -------------------------------------------------------------------------------------------- */
/* 001 — ledger foundation (buildspec.md §17.1, the tables M1 needs)                              */
/* -------------------------------------------------------------------------------------------- */

const MIGRATION_001 = /* sql */ `
-- Owner preferences. buildspec.md §17.2: "Typed, versioned owner preferences; no secret values."
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
) STRICT;

-- buildspec.md §17.1 ledger_accounts. One currency per account, which is what makes the
-- per-currency journal balance check a simple sum.
CREATE TABLE ledger_accounts (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('asset','liability','expense','income','equity')),
  type              TEXT NOT NULL,
  currency          TEXT NOT NULL CHECK (length(currency) = 3),
  is_user_visible   INTEGER NOT NULL CHECK (is_user_visible IN (0,1)),
  liquidity_role    TEXT NOT NULL,
  institution       TEXT,
  tracking_start_at INTEGER,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER
) STRICT;

CREATE INDEX idx_accounts_visible ON ledger_accounts (is_user_visible, archived_at);
CREATE INDEX idx_accounts_currency ON ledger_accounts (currency);

-- buildspec.md §17.1: "Multiple accounts may share a suffix; resolve with institution/context,
-- never global suffix-only uniqueness." Hence no unique constraint on masked_suffix.
CREATE TABLE account_aliases (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES ledger_accounts(id),
  institution     TEXT,
  sender_key      TEXT,
  identifier_kind TEXT NOT NULL,
  masked_suffix   TEXT NOT NULL,
  valid_from      INTEGER,
  valid_to        INTEGER,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_account_aliases_suffix ON account_aliases (masked_suffix, institution);
CREATE INDEX idx_account_aliases_account ON account_aliases (account_id);

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES categories(id),
  icon_key    TEXT,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER
) STRICT;

CREATE INDEX idx_categories_parent ON categories (parent_id);

-- buildspec.md §17.1: "Use category_accounts as the authoritative category-to-ledger mapping,
-- including when the owner currently uses only one currency."
CREATE TABLE category_accounts (
  category_id       TEXT NOT NULL REFERENCES categories(id),
  currency          TEXT NOT NULL,
  ledger_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (category_id, currency)
) STRICT;

CREATE INDEX idx_category_accounts_ledger ON category_accounts (ledger_account_id);

CREATE TABLE merchants (
  id             TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  notes          TEXT,
  revision       INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  archived_at    INTEGER
) STRICT;

CREATE TABLE merchant_aliases (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL REFERENCES merchants(id),
  normalized_descriptor TEXT NOT NULL,
  sender_scope          TEXT,
  account_scope         TEXT,
  created_at            INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_merchant_aliases_descriptor ON merchant_aliases (normalized_descriptor);

-- buildspec.md §17.1 transactions: "Stable user-facing identity; history_only or ledger; pending
-- has no posted journal."
CREATE TABLE transactions (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  accounting_scope TEXT NOT NULL CHECK (accounting_scope IN ('ledger','history_only')),
  status           TEXT NOT NULL CHECK (status IN ('posted','pending','deleted','merged')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  merged_into_id   TEXT REFERENCES transactions(id)
) STRICT;

CREATE INDEX idx_transactions_status ON transactions (status, updated_at DESC);
CREATE INDEX idx_transactions_scope ON transactions (accounting_scope, status);

-- buildspec.md §17.1: "Immutable versioned business state; unique transaction + revision."
CREATE TABLE transaction_revisions (
  transaction_id        TEXT NOT NULL REFERENCES transactions(id),
  revision              INTEGER NOT NULL,
  occurred_at           INTEGER NOT NULL,
  occurred_zone         TEXT NOT NULL,
  occurred_precision    TEXT NOT NULL CHECK (occurred_precision IN ('exact','date_only','inferred')),
  occurred_local_date   TEXT NOT NULL,
  merchant_id           TEXT REFERENCES merchants(id),
  merchant_name         TEXT,
  category_id           TEXT REFERENCES categories(id),
  display_amount_minor  INTEGER NOT NULL,
  currency              TEXT NOT NULL,
  notes                 TEXT,
  manual_override_fields TEXT NOT NULL DEFAULT '[]',
  journal_id            TEXT,
  action_id             TEXT NOT NULL,
  recorded_at           INTEGER NOT NULL,
  PRIMARY KEY (transaction_id, revision)
) STRICT;

CREATE INDEX idx_revisions_local_date ON transaction_revisions (occurred_local_date DESC);
CREATE INDEX idx_revisions_merchant ON transaction_revisions (merchant_id);
CREATE INDEX idx_revisions_category ON transaction_revisions (category_id);
CREATE INDEX idx_revisions_journal ON transaction_revisions (journal_id);

-- buildspec.md §17.1 journals: "Immutable after posting; one reversal of a given journal;
-- draft->posted only."
CREATE TABLE journals (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT NOT NULL REFERENCES transactions(id),
  transaction_revision INTEGER NOT NULL,
  purpose             TEXT NOT NULL,
  currency            TEXT NOT NULL,
  effective_at        INTEGER NOT NULL,
  recorded_at         INTEGER NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('draft','posted')),
  reverses_journal_id TEXT REFERENCES journals(id),
  action_id           TEXT NOT NULL
) STRICT;

CREATE INDEX idx_journals_transaction ON journals (transaction_id, transaction_revision);
CREATE INDEX idx_journals_effective ON journals (effective_at, state);
-- "one reversal of a given journal"
CREATE UNIQUE INDEX uq_journals_reverses ON journals (reverses_journal_id)
  WHERE reverses_journal_id IS NOT NULL;

-- buildspec.md §17.1 journal_entries: "At least two nonzero entries; account currency matches
-- journal; sum zero." The cross-row rules live in the domain transaction; the per-row non-zero
-- rule is cheap to guard here too (§17.3: "with database guards where practical").
CREATE TABLE journal_entries (
  id                  TEXT PRIMARY KEY,
  journal_id          TEXT NOT NULL REFERENCES journals(id),
  ledger_account_id   TEXT NOT NULL REFERENCES ledger_accounts(id),
  amount_minor_signed INTEGER NOT NULL CHECK (amount_minor_signed <> 0),
  category_id         TEXT REFERENCES categories(id),
  memo                TEXT
) STRICT;

CREATE INDEX idx_entries_account_journal ON journal_entries (ledger_account_id, journal_id);
CREATE INDEX idx_entries_journal ON journal_entries (journal_id);

-- buildspec.md §17.3: "Posted financial journals cannot be updated or deleted through normal
-- repository methods." Enforced in the database so a future code path cannot quietly bypass it.
CREATE TRIGGER trg_journals_immutable_update
BEFORE UPDATE ON journals
FOR EACH ROW WHEN OLD.state = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'posted journals are immutable');
END;

CREATE TRIGGER trg_journals_immutable_delete
BEFORE DELETE ON journals
FOR EACH ROW WHEN OLD.state = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'posted journals cannot be deleted');
END;

CREATE TRIGGER trg_entries_immutable_update
BEFORE UPDATE ON journal_entries
FOR EACH ROW WHEN (SELECT state FROM journals WHERE id = OLD.journal_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'entries of a posted journal are immutable');
END;

CREATE TRIGGER trg_entries_immutable_delete
BEFORE DELETE ON journal_entries
FOR EACH ROW WHEN (SELECT state FROM journals WHERE id = OLD.journal_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'entries of a posted journal cannot be deleted');
END;

-- buildspec.md §17.1: "Original/refund, pending/settled, transfer candidates".
CREATE TABLE transaction_relations (
  id                  TEXT PRIMARY KEY,
  from_transaction_id TEXT NOT NULL REFERENCES transactions(id),
  to_transaction_id   TEXT NOT NULL REFERENCES transactions(id),
  relation            TEXT NOT NULL,
  allocated_minor     INTEGER,
  created_at          INTEGER NOT NULL,
  action_id           TEXT NOT NULL
) STRICT;

CREATE INDEX idx_relations_from ON transaction_relations (from_transaction_id, relation);
CREATE INDEX idx_relations_to ON transaction_relations (to_transaction_id, relation);

-- buildspec.md §17.1: "Append observations; never directly overwrite balance."
CREATE TABLE balance_observations (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES ledger_accounts(id),
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  balance_type TEXT NOT NULL CHECK (balance_type IN ('ledger','available','statement','credit_limit','unknown')),
  observed_at  INTEGER NOT NULL,
  precision    TEXT NOT NULL,
  source_id    TEXT,
  entered_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_observations_account ON balance_observations (account_id, observed_at DESC);

-- buildspec.md §17.1: "Status: reconciled/unresolved/stale; recheck after backdated changes."
CREATE TABLE reconciliation_checkpoints (
  id                      TEXT PRIMARY KEY,
  account_id              TEXT NOT NULL REFERENCES ledger_accounts(id),
  observation_id          TEXT NOT NULL REFERENCES balance_observations(id),
  cutoff_at               INTEGER NOT NULL,
  calculated_before_minor INTEGER NOT NULL,
  delta_minor             INTEGER NOT NULL,
  ledger_revision         INTEGER NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('reconciled','unresolved','stale')),
  action_id               TEXT NOT NULL,
  created_at              INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_checkpoints_account_cutoff ON reconciliation_checkpoints (account_id, cutoff_at DESC);

CREATE TABLE unknown_adjustments (
  id                          TEXT PRIMARY KEY,
  checkpoint_id               TEXT REFERENCES reconciliation_checkpoints(id),
  transaction_id              TEXT NOT NULL REFERENCES transactions(id),
  remaining_unexplained_minor INTEGER NOT NULL,
  currency                    TEXT NOT NULL,
  status                      TEXT NOT NULL,
  superseded_by_id            TEXT REFERENCES unknown_adjustments(id),
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_adjustments_status ON unknown_adjustments (status);

-- buildspec.md §17.1: "Prevents explaining the same difference twice."
CREATE TABLE adjustment_explanations (
  id                        TEXT PRIMARY KEY,
  adjustment_id             TEXT NOT NULL REFERENCES unknown_adjustments(id),
  explaining_transaction_id TEXT NOT NULL REFERENCES transactions(id),
  allocated_minor           INTEGER NOT NULL,
  action_id                 TEXT NOT NULL,
  created_at                INTEGER NOT NULL,
  ended_at                  INTEGER
) STRICT;

CREATE INDEX idx_explanations_adjustment ON adjustment_explanations (adjustment_id, ended_at);

-- buildspec.md §17.2: "Unique idempotency scope + key; used by manual/import actions too."
CREATE TABLE executed_actions (
  id                TEXT PRIMARY KEY,
  proposal_id       TEXT,
  idempotency_scope TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  result_json       TEXT NOT NULL,
  undo_of_action_id TEXT,
  executed_at       INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_executed_idempotency ON executed_actions (idempotency_scope, idempotency_key);

-- buildspec.md §17.2 audit_events: "Append-only under normal operation".
CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,
  action_id       TEXT NOT NULL,
  actor_kind      TEXT NOT NULL,
  actor_session   TEXT,
  model_identity  TEXT,
  origin          TEXT NOT NULL,
  entity_refs_json TEXT NOT NULL,
  before_json     TEXT,
  after_json      TEXT,
  reason          TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,
  previous_hash   TEXT,
  event_hash      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_action ON audit_events (action_id);
CREATE INDEX idx_audit_recorded ON audit_events (recorded_at DESC);

-- buildspec.md §15: "Agent/import code cannot edit audit rows."
CREATE TRIGGER trg_audit_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
`;

/* -------------------------------------------------------------------------------------------- */
/* 002 — inference endpoints (buildspec.md §17.2 `ai_endpoints`)                                  */
/* -------------------------------------------------------------------------------------------- */

const MIGRATION_002 = /* sql */ `
-- buildspec.md §17.2: "Exactly one active extraction role and one active agent role; extraction
-- model identity is locked." §7.2 requires two independent configurations with separate clients.
CREATE TABLE ai_endpoints (
  role            TEXT PRIMARY KEY CHECK (role IN ('extraction','agent')),
  provider_kind   TEXT NOT NULL CHECK (provider_kind IN ('openai-compatible','ollama-native')),
  base_url        TEXT NOT NULL,
  -- buildspec.md §17.2: credentials live behind a secret-storage abstraction, never in this row.
  credential_ref  TEXT,
  model_name      TEXT,
  -- §7.2: "Save its digest and parser/prompt version with each extraction."
  model_digest    TEXT,
  quantization    TEXT,
  parameter_size  TEXT,
  context_limit   INTEGER,
  options_json    TEXT NOT NULL DEFAULT '{}',
  allowlist_json  TEXT NOT NULL DEFAULT '{}',
  model_locked    INTEGER NOT NULL DEFAULT 0 CHECK (model_locked IN (0,1)),
  last_test_at    INTEGER,
  last_test_ok    INTEGER CHECK (last_test_ok IN (0,1)),
  last_test_detail TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1
) STRICT;

-- A record of every connection test, so "it worked yesterday" is checkable rather than remembered.
--
-- The role column deliberately carries NO foreign key to ai_endpoints. The owner tests a host
-- BEFORE saving it, which is the whole point of the button, so the endpoint row usually does not
-- exist yet when the first test is logged. A reference would reject exactly the attempts most worth
-- recording, including the failed ones.
CREATE TABLE ai_endpoint_tests (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('extraction','agent')),
  base_url      TEXT NOT NULL,
  provider_kind TEXT,
  ok            INTEGER NOT NULL CHECK (ok IN (0,1)),
  detail        TEXT NOT NULL,
  model_count   INTEGER,
  latency_ms    INTEGER,
  tested_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_endpoint_tests_role ON ai_endpoint_tests (role, tested_at DESC);
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, name: "ledger-foundation", sql: MIGRATION_001 }),
  Object.freeze({ version: 2, name: "inference-endpoints", sql: MIGRATION_002 }),
]);

function checksumOf(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}:${migration.name}:${migration.sql}`)
    .digest("hex");
}

export type MigrationResult = {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
};

/**
 * Applies pending migrations, each inside its own transaction.
 *
 * An already-applied migration whose text changed is a hard error: it means the running code and
 * the database on disk disagree about the schema, and guessing which one is right is how data gets
 * corrupted (buildspec.md §22: "Test database migrations from each shipped schema").
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = new Map<number, { name: string; checksum: string }>();
  for (const row of db.prepare("SELECT version, name, checksum FROM schema_migrations").all()) {
    const record = row as Record<string, unknown>;
    applied.set(asNumber(record.version, "version"), {
      name: asText(record.name, "name"),
      checksum: asText(record.checksum, "checksum"),
    });
  }

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const appliedNow: number[] = [];

  for (const migration of ordered) {
    const checksum = checksumOf(migration);
    const existing = applied.get(migration.version);

    if (existing) {
      if (existing.checksum !== checksum) {
        throw new FinanceError(
          FinanceErrorCode.VALIDATION_ERROR,
          `Migration ${migration.version} ('${migration.name}') has changed since it was applied. ` +
            `Add a new migration instead of editing a released one.`,
          { version: String(migration.version), expected: existing.checksum, actual: checksum },
        );
      }
      continue;
    }

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, checksum, Date.now());
    });
    appliedNow.push(migration.version);
  }

  const currentVersion = ordered.length > 0 ? ordered[ordered.length - 1]!.version : 0;
  return { appliedVersions: appliedNow, currentVersion };
}

export function currentSchemaVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}
