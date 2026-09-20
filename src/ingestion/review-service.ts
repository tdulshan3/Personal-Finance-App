import { randomUUID } from "node:crypto";

import type { Db } from "../core/data/driver.ts";
import { asBigInt, asNumber, asOptionalText, asText } from "../core/data/driver.ts";
import { notFound, validationError } from "../core/domain/errors.ts";
import { money, parseMajorUnits, requireCurrency } from "../core/domain/money.ts";
import type { Money } from "../core/domain/money.ts";
import { addDays, dateOnlyTime, localDateOf } from "../core/domain/time.ts";
import { createBalanceCheckService } from "../core/services/balance-check.ts";
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
  /**
   * The other half of the same payment. Paying a bill by bank produces two messages — the bank's
   * "debited Rs 50.00" and the biller's "recharge of Rs 50.00 successful". They are one event, so
   * they are shown as one card and recorded as one expense (buildspec.md §8: two sources, one
   * transaction). The bank's message says which account paid; the biller's says what it was for.
   */
  readonly pairedWith: { eventId: string; sender: string; sourceText: string | null } | null;
  /**
   * The balance the bank's message reported, and what the ledger would show for the suggested
   * account once this is recorded. When the two agree, nothing is missing from the books up to
   * this message; when they differ, something was never recorded (or was recorded twice).
   */
  readonly balanceCheck: { reported: Money; projected: Money; accountName: string } | null;
};

/** How far apart the two messages of one payment may arrive. Billers can lag the bank by minutes. */
const PAIR_WINDOW_MS = 30 * 60 * 1000;
const BANK_WORDING = /\b(debited|debit of|withdrawn|withdrawal|purchase|a\/c|acct?)\b/i;
const BILLER_WORDING = /\b(recharge|reload|top-?up|bill payment|payment|paid|thank you)\b/i;
const UTILITY_WORDING = /\b(recharge|reload|top-?up|mobitel|dialog|slt|hutch|airtel|electric|ceb|leco|water|broadband|internet|bill)\b/i;

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

export function createReviewService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;

  /**
   * Which account a message is about: the masked number in its text when it has one, otherwise
   * the account this sender was last recorded against. A bank's sender name is one bank, so
   * "BOC" pre-selects the BOC account even for a message that quotes no account number.
   */
  function suggestAccount(hint: string | null, sender?: string): string | null {
    return suggestBySuffix(hint) ?? (sender ? suggestBySender(sender) : null);
  }

  function suggestBySender(sender: string): string | null {
    const row = db
      .prepare(
        `SELECT s.default_account_id AS id FROM source_senders s
           JOIN ledger_accounts l ON l.id = s.default_account_id
          WHERE s.sender_key = ? AND l.archived_at IS NULL LIMIT 1`,
      )
      .get(sender) as Record<string, unknown> | undefined;
    return row ? asText(row.id, "id") : null;
  }

  function suggestBySuffix(hint: string | null): string | null {
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

  function projectBalance(accountId: string | null, kind: string, amount: Money | null, balanceText: string | null) {
    if (!accountId || !amount || !balanceText) return null;
    const account = service.findAccount(accountId);
    // A card's SMS reports credit left, not the balance; the Accounts screen compares that.
    if (!account || account.kind !== "asset" || account.currency.code !== amount.currency.code) return null;
    try {
      const reported = parseMajorUnits(account.currency, balanceText);
      const now = service.balanceOf(account.id);
      const delta = kind === "posted_income" || kind === "refund" ? amount.minor : -amount.minor;
      return { reported, projected: money(account.currency, now.minor + delta), accountName: account.name };
    } catch {
      return null;
    }
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

  /**
   * Folds a biller's receipt into the bank debit it belongs to.
   *
   * Deliberately strict, because a wrong merge hides a real expense: same amount and currency,
   * different senders, within half an hour, exactly one side that names an account (the bank) and
   * one that does not (the biller). Anything looser stays as two cards for the owner to judge, and
   * `keepApart` lets the owner undo a pairing that was wrong.
   */
  function pairUp(cards: ReviewCard[], keepApart: ReadonlySet<string>): ReviewCard[] {
    const isBank = (c: ReviewCard) => c.accountHint !== null || BANK_WORDING.test(c.sourceText ?? "");
    const isBiller = (c: ReviewCard) => c.accountHint === null && BILLER_WORDING.test(c.sourceText ?? "");
    const used = new Set<string>();
    const merged: ReviewCard[] = [];

    for (const bank of cards) {
      if (used.has(bank.eventId) || keepApart.has(bank.eventId) || bank.kind !== "posted_expense" || !bank.amount || !isBank(bank)) continue;
      const biller = cards.find((c) =>
        c.eventId !== bank.eventId && !used.has(c.eventId) && !keepApart.has(c.eventId) &&
        c.kind === "posted_expense" && c.amount !== null &&
        c.amount.minor === bank.amount!.minor && c.amount.currency.code === bank.amount!.currency.code &&
        c.sender.toLowerCase() !== bank.sender.toLowerCase() &&
        Math.abs(c.receivedAt - bank.receivedAt) <= PAIR_WINDOW_MS && isBiller(c));
      if (!biller) continue;
      used.add(bank.eventId).add(biller.eventId);
      const merchant = biller.merchantText ?? biller.sender;
      merged.push({
        ...bank,
        merchantText: merchant,
        suggestedCategoryId: suggestCategory(merchant) ?? (UTILITY_WORDING.test(`${biller.sourceText ?? ""} ${biller.sender}`) ? "utilities" : bank.suggestedCategoryId),
        flags: [...bank.flags, "paired_messages"],
        pairedWith: { eventId: biller.eventId, sender: biller.sender, sourceText: biller.sourceText },
      });
    }
    // Keep the inbox's newest-first order; a merged card takes its bank message's place.
    return cards.filter((c) => !used.has(c.eventId) || merged.some((m) => m.eventId === c.eventId))
      .map((c) => merged.find((m) => m.eventId === c.eventId) ?? c);
  }

  function listOpen(limit = 50, keepApart: ReadonlySet<string> = new Set()): ReviewCard[] {
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

    const cards = rows.map((row): ReviewCard => {
      const candidate = JSON.parse(asText(row.candidate_json, "candidate_json")) as {
        occurredOn?: string | null;
        flags?: string[];
        balanceText?: string | null;
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
        suggestedAccountId: suggestAccount(hint, asText(row.sender, "sender")),
        suggestedCategoryId: suggestCategory(merchant),
        possibleDuplicate: findPossibleDuplicate(amount, occurredOn),
        pairedWith: null,
        balanceCheck: projectBalance(suggestAccount(hint, asText(row.sender, "sender")), kind, amount, candidate.balanceText ?? null),
      };
    });
    return pairUp(cards, keepApart);
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
    /** The biller's receipt shown on the same card; recorded as supporting evidence, not again. */
    pairedEventId?: string | undefined;
  }): { transactionId: string } {
    const event = db
      .prepare(
        `SELECT e.id, e.status, e.account_hint, e.source_id, e.candidate_json, m.received_at, m.sender
           FROM source_events e JOIN source_messages m ON m.id = e.source_id WHERE e.id = ?`,
      )
      .get(input.eventId) as Record<string, unknown> | undefined;
    if (!event) throw notFound("Review item", input.eventId);
    if (asText(event.status, "status") !== "needs_review") {
      throw validationError("That item was already handled.");
    }

    if (input.pairedEventId) {
      const paired = db.prepare("SELECT status FROM source_events WHERE id = ?").get(input.pairedEventId) as Record<string, unknown> | undefined;
      if (!paired || input.pairedEventId === input.eventId || asText(paired.status, "status") !== "needs_review") {
        throw validationError("The second message on this card was already handled. Reload and try again.");
      }
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

      // Remember which account this sender means, so its next message arrives with it chosen.
      // Only a message that names an account (a bank's) teaches this; a biller's receipt does not.
      if (input.rememberAccount !== false && asOptionalText(event.account_hint, "account_hint")) {
        db.prepare("UPDATE source_senders SET default_account_id = ? WHERE sender_key = ?").run(input.accountId, asText(event.sender, "sender"));
      }

      // Keep what the bank said the balance was. It changes nothing; it is what the books are
      // checked against afterwards (buildspec.md §17.1: observations are appended, never applied).
      try {
        const reportedText = (JSON.parse(asText(event.candidate_json, "candidate_json")) as { balanceText?: string | null }).balanceText;
        if (reportedText) {
          createBalanceCheckService({ db, service }).recordObservation({
            accountId: input.accountId,
            reported: parseMajorUnits(account.currency, reportedText),
            observedAt: asNumber(event.received_at, "received_at"),
            sourceId: asText(event.source_id, "source_id"),
          });
        }
      } catch {
        // An unreadable balance figure is not a reason to refuse the transaction.
      }

      // One expense, two pieces of evidence. The receipt is linked and closed, never posted.
      if (input.pairedEventId) {
        db.prepare(
          `INSERT INTO transaction_sources (id, transaction_id, source_event_id, relation, action_id, created_at)
           VALUES (?,?,?,'supporting',?,?)`,
        ).run(newId("tsrc"), result.transactionId, input.pairedEventId, result.actionId, service.clock.now());
        resolve(input.pairedEventId, "accepted", result.actionId);
      }

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
