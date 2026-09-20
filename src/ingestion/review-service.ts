import { randomUUID } from "node:crypto";

import type { Db } from "../core/data/driver.ts";
import { asBigInt, asNumber, asOptionalText, asText } from "../core/data/driver.ts";
import { notFound, validationError } from "../core/domain/errors.ts";
import { money, parseMajorUnits, requireCurrency } from "../core/domain/money.ts";
import type { Money } from "../core/domain/money.ts";
import { addDays, dateOnlyTime, localDateOf } from "../core/domain/time.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import { POSTABLE_KINDS } from "./processing.ts";

/**
 * The review inbox: where a message becomes a transaction, by the owner's hand.
 *
 * buildspec.md §7.4: "Review items show exact source, proposed fields, highlighted evidence,
 * rejection reasons, and edit/accept/ignore controls." §1.5: "A message is evidence, not a
 * transaction" — accepting is the step that creates one, through the same `finance-service` the
 * manual forms use (§1: one set of rules for every write path).
 */

export type ReviewCard = {
  readonly eventId: string;
  readonly sourceId: string;
  readonly kind: string;
  readonly postable: boolean;
  readonly sender: string;
  readonly receivedAt: number;
  readonly sourceText: string | null;
  readonly amount: Money | null;
  readonly merchantText: string | null;
  readonly accountHint: string | null;
  readonly occurredOn: string | null;
  readonly flags: readonly string[];
  readonly engine: "rules" | "model";
  readonly modelName: string | null;
  /** Preselected from a remembered suffix mapping, when exactly one account matches. */
  readonly suggestedAccountId: string | null;
  /** The category last used for this merchant, if any. */
  readonly suggestedCategoryId: string | null;
  /** buildspec.md §8: a fuzzy match is a *suggestion*, never an automatic merge. */
  readonly possibleDuplicate: { transactionId: string; label: string } | null;
};

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

export function createReviewService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;

  function suggestAccount(hint: string | null): string | null {
    if (!hint) return null;
    const rows = db
      .prepare(
        `SELECT DISTINCT a.account_id FROM account_aliases a
           JOIN ledger_accounts l ON l.id = a.account_id
          WHERE a.masked_suffix = ? AND l.archived_at IS NULL`,
      )
      .all(hint) as Record<string, unknown>[];
    // §17.1: several accounts may share a suffix. Only an unambiguous match is offered.
    return rows.length === 1 ? asText(rows[0]!.account_id, "account_id") : null;
  }

  function suggestCategory(merchant: string | null): string | null {
    if (!merchant) return null;
    const row = db
      .prepare(
        `SELECT category_id FROM transaction_revisions
          WHERE lower(merchant_name) = lower(?) AND category_id IS NOT NULL
          ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get(merchant) as Record<string, unknown> | undefined;
    return row ? asText(row.category_id, "category_id") : null;
  }

  function findPossibleDuplicate(amount: Money | null, occurredOn: string | null) {
    if (!amount || !occurredOn) return null;
    const row = db
      .prepare(
        `SELECT t.id, r.merchant_name, r.occurred_local_date FROM transactions t
           JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
          WHERE t.status = 'posted' AND r.display_amount_minor = ? AND r.currency = ?
            AND r.occurred_local_date BETWEEN ? AND ?
          LIMIT 1`,
      )
      .get(amount.minor, amount.currency.code, addDays(occurredOn, -1), addDays(occurredOn, 1)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      transactionId: asText(row.id, "id"),
      label: `${asOptionalText(row.merchant_name, "merchant_name") ?? "a transaction"} on ${asText(
        row.occurred_local_date,
        "occurred_local_date",
      )}`,
    };
  }

  function listOpen(limit = 50): ReviewCard[] {
    const rows = db
      .prepare(
        `SELECT e.id AS event_id, e.source_id, e.kind, e.amount_minor, e.currency, e.account_hint,
                e.merchant_text, e.candidate_json, m.sender, m.received_at, m.body,
                x.engine, x.model_name
           FROM source_events e
           JOIN source_messages m ON m.id = e.source_id
           JOIN extraction_runs x ON x.id = e.extraction_run_id
          WHERE e.status = 'needs_review'
          ORDER BY m.received_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => {
      const candidate = JSON.parse(asText(row.candidate_json, "candidate_json")) as {
        occurredOn?: string | null;
        flags?: string[];
      };
      const currencyCode = asOptionalText(row.currency, "currency");
      const amount =
        row.amount_minor !== null && currencyCode
          ? money(requireCurrency(currencyCode), asBigInt(row.amount_minor, "amount_minor"))
          : null;
      const merchant = asOptionalText(row.merchant_text, "merchant_text") ?? null;
      const hint = asOptionalText(row.account_hint, "account_hint") ?? null;
      const occurredOn = candidate.occurredOn ?? null;
      const kind = asText(row.kind, "kind");

      return {
        eventId: asText(row.event_id, "event_id"),
        sourceId: asText(row.source_id, "source_id"),
        kind,
        postable: POSTABLE_KINDS.includes(kind) || kind === "unknown",
        sender: asText(row.sender, "sender"),
        receivedAt: asNumber(row.received_at, "received_at"),
        sourceText: asOptionalText(row.body, "body") ?? null,
        amount,
        merchantText: merchant,
        accountHint: hint,
        occurredOn,
        flags: candidate.flags ?? [],
        engine: asText(row.engine, "engine") as "rules" | "model",
        modelName: asOptionalText(row.model_name, "model_name") ?? null,
        suggestedAccountId: suggestAccount(hint),
        suggestedCategoryId: suggestCategory(merchant),
        possibleDuplicate: findPossibleDuplicate(amount, occurredOn),
      };
    });
  }

  function resolve(eventId: string, status: "accepted" | "ignored", actionId: string | null): void {
    const now = service.clock.now();
    db.prepare("UPDATE source_events SET status = ? WHERE id = ?").run(status, eventId);
    db.prepare(
      `UPDATE review_items SET status = ?, resolved_action_id = ?, updated_at = ?
        WHERE target_type = 'source_event' AND target_id = ? AND status = 'open'`,
    ).run(status === "accepted" ? "resolved" : "ignored", actionId, now, eventId);

    // The message is done once none of its events are still waiting.
    db.prepare(
      `UPDATE source_messages SET processing_status = 'reviewed'
        WHERE id = (SELECT source_id FROM source_events WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM source_events e2
                           WHERE e2.source_id = source_messages.id AND e2.status = 'needs_review')`,
    ).run(eventId);
  }

  /**
   * Turns a reviewed event into a ledger transaction.
   *
   * One outer transaction wraps the posting, the evidence link, the review resolution and the
   * remembered alias, so an accepted card can never be half-applied (§9.3: "All steps, source
   * links ... commit atomically"). The inner posting becomes a savepoint.
   */
  function accept(input: {
    eventId: string;
    kind: "expense" | "income" | "refund";
    accountId: string;
    categoryId: string;
    amountText: string;
    occurredOn: string;
    merchantName?: string | undefined;
    notes?: string | undefined;
    rememberAccount?: boolean | undefined;
  }): { transactionId: string } {
    const event = db
      .prepare("SELECT id, status, account_hint FROM source_events WHERE id = ?")
      .get(input.eventId) as Record<string, unknown> | undefined;
    if (!event) throw notFound("Review item", input.eventId);
    if (asText(event.status, "status") !== "needs_review") {
      throw validationError("That item was already handled.");
    }

    const account = service.findAccount(input.accountId);
    if (!account) throw validationError("Choose an account.");
    const amount = parseMajorUnits(account.currency, input.amountText);
    const occurredAt = dateOnlyTime(input.occurredOn, service.zone);
    if (input.occurredOn > localDateOf(service.clock.now(), service.zone)) {
      throw validationError("That date is in the future.");
    }

    // §16: a double tap on Accept must not post twice.
    const write = { idempotencyKey: `review:${input.eventId}`, origin: "ui.review.accept",
                    reason: "Owner accepted a message from the review inbox" };

    return db.transaction(() => {
      const common = { accountId: input.accountId, amount, occurredAt,
                       merchantName: input.merchantName, notes: input.notes };
      const result =
        input.kind === "expense"
          ? service.createExpense({ ...common, splits: [{ categoryId: input.categoryId, amount }] }, write)
          : input.kind === "income"
            ? service.createIncome({ ...common, splits: [{ categoryId: input.categoryId, amount }] }, write)
            : service.createRefund({ ...common, categoryId: input.categoryId }, write);

      db.prepare(
        `INSERT INTO transaction_sources (id, transaction_id, source_event_id, relation, action_id, created_at)
         VALUES (?,?,?,'canonical',?,?)`,
      ).run(newId("tsrc"), result.transactionId, input.eventId, result.actionId, service.clock.now());

      resolve(input.eventId, "accepted", result.actionId);

      // "Map masked identifiers" (§13): remember which account this suffix means.
      const hint = asOptionalText(event.account_hint, "account_hint");
      if (hint && input.rememberAccount !== false) {
        const known = db
          .prepare("SELECT 1 AS ok FROM account_aliases WHERE account_id = ? AND masked_suffix = ?")
          .get(input.accountId, hint);
        if (!known) {
          db.prepare(
            `INSERT INTO account_aliases (id, account_id, identifier_kind, masked_suffix, created_at)
             VALUES (?,?,'masked_suffix',?,?)`,
          ).run(newId("alias"), input.accountId, hint, service.clock.now());
        }
      }
      return { transactionId: result.transactionId };
    });
  }

  function ignore(eventId: string): void {
    db.transaction(() => resolve(eventId, "ignored", null));
  }

  return { listOpen, accept, ignore };
}

export type ReviewService = ReturnType<typeof createReviewService>;
