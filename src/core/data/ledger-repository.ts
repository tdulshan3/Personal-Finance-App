import { createHash } from "node:crypto";

import { FinanceError, FinanceErrorCode, notFound, validationError } from "../domain/errors.ts";
import type { AccountLookup, Journal, LedgerAccount, PostedEntry } from "../domain/ledger.ts";
import {
  AccountKind,
  AccountType,
  JournalState,
  LiquidityRole,
  displayBalance,
} from "../domain/ledger.ts";
import type { Currency, Money } from "../domain/money.ts";
import { money, requireCurrency } from "../domain/money.ts";
import type { AuditEvent, PostingPlan } from "../domain/posting.ts";
import type { Instant } from "../domain/time.ts";
import { TimePrecision, localDateOf } from "../domain/time.ts";
import type { Transaction, TransactionRevision } from "../domain/transaction.ts";
import type { AccountingScope, TransactionStatus } from "../domain/transaction.ts";
import type { Db } from "./driver.ts";
import { asBigInt, asBoolean, asNumber, asOptionalNumber, asOptionalText, asText } from "./driver.ts";

/**
 * Persistence for accounts, transactions and journals.
 *
 * The domain builds a [PostingPlan]; this file is the only thing that writes one. buildspec.md §9.3
 * requires every part of a change — journals, revisions, audit, revision counters — to "commit
 * atomically. Failure rolls everything back", so `applyPostingPlan` is a single immediate
 * transaction and nothing here exposes a partial write.
 */

/* -------------------------------------------------------------------------------------------- */
/* Row mapping                                                                                    */
/* -------------------------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

function mapAccount(row: Row): LedgerAccount {
  return {
    id: asText(row.id, "id"),
    name: asText(row.name, "name"),
    kind: asText(row.kind, "kind") as AccountKind,
    type: asText(row.type, "type") as AccountType,
    currency: requireCurrency(asText(row.currency, "currency")),
    isUserVisible: asBoolean(row.is_user_visible, "is_user_visible"),
    liquidityRole: asText(row.liquidity_role, "liquidity_role") as LiquidityRole,
    institution: asOptionalText(row.institution, "institution"),
    trackingStartAt: asOptionalNumber(row.tracking_start_at, "tracking_start_at"),
    revision: asNumber(row.revision, "revision"),
    archivedAt: asOptionalNumber(row.archived_at, "archived_at"),
  };
}

function mapTransaction(row: Row): Transaction {
  return {
    id: asText(row.id, "id"),
    kind: asText(row.kind, "kind") as Transaction["kind"],
    currentRevision: asNumber(row.current_revision, "current_revision"),
    accountingScope: asText(row.accounting_scope, "accounting_scope") as AccountingScope,
    status: asText(row.status, "status") as TransactionStatus,
    createdAt: asNumber(row.created_at, "created_at"),
    updatedAt: asNumber(row.updated_at, "updated_at"),
    deletedAt: asOptionalNumber(row.deleted_at, "deleted_at"),
    mergedIntoId: asOptionalText(row.merged_into_id, "merged_into_id"),
  };
}

function mapRevision(row: Row): TransactionRevision {
  const currency = requireCurrency(asText(row.currency, "currency"));
  return {
    transactionId: asText(row.transaction_id, "transaction_id"),
    revision: asNumber(row.revision, "revision"),
    occurredAt: {
      instant: asNumber(row.occurred_at, "occurred_at"),
      zone: asText(row.occurred_zone, "occurred_zone"),
      precision: asText(row.occurred_precision, "occurred_precision") as TimePrecision,
    },
    merchantId: asOptionalText(row.merchant_id, "merchant_id"),
    merchantName: asOptionalText(row.merchant_name, "merchant_name"),
    categoryId: asOptionalText(row.category_id, "category_id"),
    displayAmount: money(currency, asBigInt(row.display_amount_minor, "display_amount_minor")),
    notes: asOptionalText(row.notes, "notes"),
    manualOverrideFields: JSON.parse(asText(row.manual_override_fields, "manual_override_fields")),
    journalId: asOptionalText(row.journal_id, "journal_id"),
    actionId: asText(row.action_id, "action_id"),
    recordedAt: asNumber(row.recorded_at, "recorded_at"),
  };
}

function mapJournal(row: Row, entries: Row[]): Journal {
  return {
    id: asText(row.id, "id"),
    transactionId: asText(row.transaction_id, "transaction_id"),
    transactionRevision: asNumber(row.transaction_revision, "transaction_revision"),
    purpose: asText(row.purpose, "purpose") as Journal["purpose"],
    currency: requireCurrency(asText(row.currency, "currency")),
    effectiveAt: asNumber(row.effective_at, "effective_at"),
    recordedAt: asNumber(row.recorded_at, "recorded_at"),
    state: asText(row.state, "state") as typeof JournalState.POSTED,
    reversesJournalId: asOptionalText(row.reverses_journal_id, "reverses_journal_id"),
    actionId: asText(row.action_id, "action_id"),
    entries: entries.map((entry) => ({
      id: asText(entry.id, "id"),
      accountId: asText(entry.ledger_account_id, "ledger_account_id"),
      amountMinorSigned: asBigInt(entry.amount_minor_signed, "amount_minor_signed"),
      categoryId: asOptionalText(entry.category_id, "category_id"),
      memo: asOptionalText(entry.memo, "memo"),
    })),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Repository                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export type AccountInput = {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly type: AccountType;
  readonly currency: Currency;
  readonly liquidityRole: LiquidityRole;
  readonly isUserVisible?: boolean;
  readonly institution?: string | undefined;
  readonly trackingStartAt?: Instant | undefined;
};

export type ApplyPlanOptions = {
  /**
   * buildspec.md §16: "Mutations require an idempotency key scoped to actor, operation, and
   * canonical request hash. Same key with different content returns IDEMPOTENCY_CONFLICT."
   */
  readonly idempotency?:
    | {
        readonly scope: string;
        readonly key: string;
        readonly requestHash: string;
      }
    | undefined;
};

export type ApplyPlanResult = {
  readonly actionId: string;
  /** True when the plan was already executed under the same idempotency key and was not re-applied. */
  readonly replayed: boolean;
};

export function createLedgerRepository(db: Db) {
  const accountLookup: AccountLookup = {
    findAccount: (id: string) => findAccount(id),
  };

  function findAccount(id: string): LedgerAccount | undefined {
    const row = db.prepare("SELECT * FROM ledger_accounts WHERE id = ?").get(id) as Row | undefined;
    return row ? mapAccount(row) : undefined;
  }

  function listAccounts(options: { includeArchived?: boolean; includeInternal?: boolean } = {}) {
    const clauses: string[] = [];
    if (!options.includeArchived) clauses.push("archived_at IS NULL");
    if (!options.includeInternal) clauses.push("is_user_visible = 1");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (db.prepare(`SELECT * FROM ledger_accounts ${where} ORDER BY name`).all() as Row[]).map(
      mapAccount,
    );
  }

  function insertAccount(input: AccountInput, now: Instant): LedgerAccount {
    db.prepare(
      `INSERT INTO ledger_accounts
         (id, name, kind, type, currency, is_user_visible, liquidity_role, institution,
          tracking_start_at, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.kind,
      input.type,
      input.currency.code,
      input.isUserVisible ?? true ? 1 : 0,
      input.liquidityRole,
      input.institution ?? null,
      input.trackingStartAt ?? null,
      now,
      now,
    );
    return findAccount(input.id)!;
  }

  /**
   * Resolves (creating on first use) the ledger account a category posts to for one currency.
   *
   * buildspec.md §17.1 makes `category_accounts` the authoritative mapping. Creating it lazily is
   * what lets the owner add a second currency later without a migration.
   */
  function categoryAccountFor(
    categoryId: string,
    currency: Currency,
    kind: typeof AccountKind.EXPENSE | typeof AccountKind.INCOME,
    now: Instant,
  ): string {
    const existing = db
      .prepare("SELECT ledger_account_id FROM category_accounts WHERE category_id = ? AND currency = ?")
      .get(categoryId, currency.code) as Row | undefined;
    if (existing) return asText(existing.ledger_account_id, "ledger_account_id");

    const category = db.prepare("SELECT name FROM categories WHERE id = ?").get(categoryId) as
      | Row
      | undefined;
    if (!category) throw notFound("Category", categoryId);

    const accountId = `catacct_${kind === AccountKind.EXPENSE ? "exp" : "inc"}_${categoryId}_${currency.code}`;
    if (!findAccount(accountId)) {
      insertAccount(
        {
          id: accountId,
          name: `${asText(category.name, "name")} (${currency.code})`,
          kind,
          type: kind === AccountKind.EXPENSE ? AccountType.CATEGORY_EXPENSE : AccountType.CATEGORY_INCOME,
          currency,
          liquidityRole: LiquidityRole.NOT_APPLICABLE,
          isUserVisible: false,
        },
        now,
      );
    }
    db.prepare(
      "INSERT INTO category_accounts (category_id, currency, ledger_account_id, created_at) VALUES (?,?,?,?)",
    ).run(categoryId, currency.code, accountId, now);
    return accountId;
  }

  /** The internal equity accounts of buildspec.md §9.2, created on first use. */
  function systemAccountFor(role: "opening" | "reconciliation", currency: Currency, now: Instant) {
    const accountId = `sysacct_${role}_${currency.code}`;
    if (!findAccount(accountId)) {
      insertAccount(
        {
          id: accountId,
          name:
            role === "opening"
              ? `Opening balances (${currency.code})`
              : `Unexplained differences (${currency.code})`,
          kind: AccountKind.EQUITY,
          type: AccountType.SYSTEM_EQUITY,
          currency,
          liquidityRole: LiquidityRole.NOT_APPLICABLE,
          isUserVisible: false,
        },
        now,
      );
    }
    return accountId;
  }

  function postedEntriesFor(accountId: string, asOf?: Instant): PostedEntry[] {
    const sql = asOf
      ? `SELECT e.ledger_account_id, e.amount_minor_signed, j.effective_at
           FROM journal_entries e JOIN journals j ON j.id = e.journal_id
          WHERE e.ledger_account_id = ? AND j.state = 'posted' AND j.effective_at <= ?`
      : `SELECT e.ledger_account_id, e.amount_minor_signed, j.effective_at
           FROM journal_entries e JOIN journals j ON j.id = e.journal_id
          WHERE e.ledger_account_id = ? AND j.state = 'posted'`;
    const rows = (asOf ? db.prepare(sql).all(accountId, asOf) : db.prepare(sql).all(accountId)) as Row[];
    return rows.map((row) => ({
      accountId: asText(row.ledger_account_id, "ledger_account_id"),
      amountMinorSigned: asBigInt(row.amount_minor_signed, "amount_minor_signed"),
      effectiveAt: asNumber(row.effective_at, "effective_at"),
    }));
  }

  /**
   * buildspec.md §9.3: "Balance queries sum all posted journal entries, including originals and
   * reversals." The sum happens in SQL; the sign convention is applied by the domain.
   */
  function balanceOf(accountId: string, asOf?: Instant): Money {
    const account = findAccount(accountId);
    if (!account) throw notFound("Ledger account", accountId);
    return displayBalance(account, postedEntriesFor(accountId, asOf), asOf);
  }

  function findTransaction(id: string): Transaction | undefined {
    const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapTransaction(row) : undefined;
  }

  function findRevision(transactionId: string, revision: number): TransactionRevision | undefined {
    const row = db
      .prepare("SELECT * FROM transaction_revisions WHERE transaction_id = ? AND revision = ?")
      .get(transactionId, revision) as Row | undefined;
    return row ? mapRevision(row) : undefined;
  }

  function findJournal(journalId: string): Journal | undefined {
    const row = db.prepare("SELECT * FROM journals WHERE id = ?").get(journalId) as Row | undefined;
    if (!row) return undefined;
    const entries = db
      .prepare("SELECT * FROM journal_entries WHERE journal_id = ? ORDER BY id")
      .all(journalId) as Row[];
    return mapJournal(row, entries);
  }

  /** Loads the snapshot the correction builders in `posting.ts` expect. */
  function snapshotOf(transactionId: string) {
    const transaction = findTransaction(transactionId);
    if (!transaction) throw notFound("Transaction", transactionId);
    const currentRevision = findRevision(transactionId, transaction.currentRevision);
    if (!currentRevision) {
      throw new FinanceError(
        FinanceErrorCode.VALIDATION_ERROR,
        `Transaction '${transactionId}' has no revision ${transaction.currentRevision}`,
      );
    }
    const currentJournal = currentRevision.journalId
      ? findJournal(currentRevision.journalId)
      : undefined;
    return { transaction, currentRevision, currentJournal };
  }

  function writeAudit(event: AuditEvent, auditId: string): void {
    /*
     * buildspec.md §15: "Optionally chain audit hashes and anchor backup digests, but do not claim
     * this defeats an attacker who controls the unlocked device and its keys." The chain makes
     * accidental gaps and out-of-band edits visible; it is not tamper-proofing.
     */
    const previous = db
      .prepare("SELECT event_hash FROM audit_events ORDER BY recorded_at DESC, id DESC LIMIT 1")
      .get() as Row | undefined;
    const previousHash = previous ? asText(previous.event_hash, "event_hash") : null;

    const payload = JSON.stringify({
      actionId: event.actionId,
      actor: event.actor,
      origin: event.origin,
      entityRefs: event.entityRefs,
      before: event.before,
      after: event.after,
      reason: event.reason,
      recordedAt: event.recordedAt,
    });
    const eventHash = createHash("sha256")
      .update(`${previousHash ?? ""}\u0000${payload}`)
      .digest("hex");

    db.prepare(
      `INSERT INTO audit_events
         (id, action_id, actor_kind, actor_session, model_identity, origin, entity_refs_json,
          before_json, after_json, reason, recorded_at, previous_hash, event_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      auditId,
      event.actionId,
      event.actor.kind,
      event.actor.sessionId ?? null,
      event.actor.modelIdentity ?? null,
      event.origin,
      JSON.stringify(event.entityRefs),
      event.before === null || event.before === undefined ? null : JSON.stringify(event.before),
      event.after === null || event.after === undefined ? null : JSON.stringify(event.after),
      event.reason,
      event.recordedAt,
      previousHash,
      eventHash,
    );
  }

  /**
   * Writes a whole posting plan, or nothing.
   *
   * buildspec.md §20: "Proposal confirmed twice | Same result returned once; no duplicate write."
   * The idempotency check happens inside the same transaction as the writes, so two concurrent
   * submissions of the same key cannot both pass it.
   */
  function applyPostingPlan(plan: PostingPlan, options: ApplyPlanOptions = {}): ApplyPlanResult {
    return db.transaction(() => {
      const { idempotency } = options;

      if (idempotency) {
        const existing = db
          .prepare(
            "SELECT request_hash, result_json FROM executed_actions WHERE idempotency_scope = ? AND idempotency_key = ?",
          )
          .get(idempotency.scope, idempotency.key) as Row | undefined;
        if (existing) {
          if (asText(existing.request_hash, "request_hash") !== idempotency.requestHash) {
            throw new FinanceError(
              FinanceErrorCode.IDEMPOTENCY_CONFLICT,
              "That idempotency key was already used with different arguments.",
              { scope: idempotency.scope, key: idempotency.key },
            );
          }
          const stored = JSON.parse(asText(existing.result_json, "result_json")) as {
            actionId: string;
          };
          return { actionId: stored.actionId, replayed: true };
        }
      }

      upsertTransaction(plan.transaction);
      for (const revision of plan.revisions) insertRevision(revision);
      for (const journal of plan.journals) insertJournal(journal);
      writeAudit(plan.audit, `aud_${plan.actionId}`);

      if (idempotency) {
        db.prepare(
          `INSERT INTO executed_actions
             (id, idempotency_scope, idempotency_key, request_hash, result_json, executed_at)
           VALUES (?,?,?,?,?,?)`,
        ).run(
          `exec_${plan.actionId}`,
          idempotency.scope,
          idempotency.key,
          idempotency.requestHash,
          JSON.stringify({ actionId: plan.actionId }),
          plan.audit.recordedAt,
        );
      }

      return { actionId: plan.actionId, replayed: false };
    });
  }

  function upsertTransaction(transaction: Transaction): void {
    db.prepare(
      `INSERT INTO transactions
         (id, kind, current_revision, accounting_scope, status, created_at, updated_at, deleted_at, merged_into_id)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         current_revision = excluded.current_revision,
         accounting_scope = excluded.accounting_scope,
         status           = excluded.status,
         updated_at       = excluded.updated_at,
         deleted_at       = excluded.deleted_at,
         merged_into_id   = excluded.merged_into_id`,
    ).run(
      transaction.id,
      transaction.kind,
      transaction.currentRevision,
      transaction.accountingScope,
      transaction.status,
      transaction.createdAt,
      transaction.updatedAt,
      transaction.deletedAt ?? null,
      transaction.mergedIntoId ?? null,
    );
  }

  function insertRevision(revision: TransactionRevision): void {
    db.prepare(
      `INSERT INTO transaction_revisions
         (transaction_id, revision, occurred_at, occurred_zone, occurred_precision,
          occurred_local_date, merchant_id, merchant_name, category_id, display_amount_minor,
          currency, notes, manual_override_fields, journal_id, action_id, recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      revision.transactionId,
      revision.revision,
      revision.occurredAt.instant,
      revision.occurredAt.zone,
      revision.occurredAt.precision,
      localDateOf(revision.occurredAt.instant, revision.occurredAt.zone),
      revision.merchantId ?? null,
      revision.merchantName ?? null,
      revision.categoryId ?? null,
      revision.displayAmount.minor,
      revision.displayAmount.currency.code,
      revision.notes ?? null,
      JSON.stringify(revision.manualOverrideFields),
      revision.journalId ?? null,
      revision.actionId,
      revision.recordedAt,
    );
  }

  function insertJournal(journal: Journal): void {
    if (journal.state !== JournalState.POSTED) {
      throw validationError("Only posted journals are persisted in version 1");
    }
    db.prepare(
      `INSERT INTO journals
         (id, transaction_id, transaction_revision, purpose, currency, effective_at, recorded_at,
          state, reverses_journal_id, action_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      journal.id,
      journal.transactionId,
      journal.transactionRevision,
      journal.purpose,
      journal.currency.code,
      journal.effectiveAt,
      journal.recordedAt,
      journal.state,
      journal.reversesJournalId ?? null,
      journal.actionId,
    );

    const insertEntry = db.prepare(
      `INSERT INTO journal_entries (id, journal_id, ledger_account_id, amount_minor_signed, category_id, memo)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const entry of journal.entries) {
      insertEntry.run(
        entry.id,
        journal.id,
        entry.accountId,
        entry.amountMinorSigned,
        entry.categoryId ?? null,
        entry.memo ?? null,
      );
    }
  }

  return {
    accountLookup,
    findAccount,
    listAccounts,
    insertAccount,
    categoryAccountFor,
    systemAccountFor,
    balanceOf,
    postedEntriesFor,
    findTransaction,
    findRevision,
    findJournal,
    snapshotOf,
    applyPostingPlan,
  };
}

export type LedgerRepository = ReturnType<typeof createLedgerRepository>;
