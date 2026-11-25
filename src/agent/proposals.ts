import { createHash, randomUUID } from "node:crypto";

import type { Db } from "../core/data/driver.ts";
import { asNumber, asOptionalText, asText } from "../core/data/driver.ts";
import { FinanceError, FinanceErrorCode, validationError } from "../core/domain/errors.ts";
import { AccountKind } from "../core/domain/ledger.ts";
import type { Currency } from "../core/domain/money.ts";
import { formatMoney, money, parseMajorUnits, requireCurrency } from "../core/domain/money.ts";
import { ActorKind } from "../core/domain/posting.ts";
import { dateOnlyTime, localDateOf, parseLocalDate } from "../core/domain/time.ts";
import { createBudgetService } from "../core/services/budget-service.ts";
import { createCategoryService } from "../core/services/category-service.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import { createGoalService } from "../core/services/goal-service.ts";
import { createRecurringService } from "../core/services/recurring-service.ts";

/**
 * Proposals: the only way the assistant can change anything.
 *
 * buildspec.md §14.3, which this file implements line by line:
 *
 *   "Write tools create proposals only... Only a real owner interaction through the trusted UI
 *    produces an approval receipt. A model-generated 'yes', a message containing 'approved', or a
 *    Boolean argument is never authorization."
 *
 * The model can call `propose_*` tools, which land here as `createProposal`. It has no tool that
 * reaches `approveAndExecute` — that function is only called from a server action behind the
 * owner's session cookie. Between the two sit the checks §14.3 lists: hash binding (the executed
 * arguments are byte-for-byte the ones that were shown), expiry, target revisions, and the model
 * identity that produced the proposal.
 */

export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

export const ActionType = {
  CREATE_TRANSACTION: "transaction.create",
  CREATE_TRANSFER: "transaction.transfer",
  DELETE_TRANSACTION: "transaction.delete",
  EDIT_TRANSACTION: "transaction.edit",
  RESTORE_TRANSACTION: "transaction.restore",
  SET_BUDGET: "budget.set",
  CREATE_BILL: "bill.create",
  CREATE_GOAL: "goal.create",
  CREATE_CATEGORY: "category.create",
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

export type ModelIdentity = { endpoint: string; model: string; digest: string | null };

export type ProposalPreview = {
  readonly title: string;
  readonly lines: readonly { label: string; value: string }[];
  /** What the owner's balances will do, in words. */
  readonly effects: readonly string[];
  readonly risk: "low" | "high";
};

export type ProposalRecord = {
  readonly id: string;
  readonly actionType: ActionType;
  readonly status: string;
  readonly hash: string;
  readonly expiresAt: number;
  readonly preview: ProposalPreview;
  readonly createdAt: number;
  readonly resultText?: string | undefined;
};

/** Deterministic JSON, so the same arguments always hash the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function hashOf(actionType: string, args: unknown, targets: unknown): string {
  return createHash("sha256").update(`${actionType}\u0000${canonical(args)}\u0000${canonical(targets)}`).digest("hex");
}

const str = (args: Record<string, unknown>, key: string, max = 200): string => {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`'${key}' is required and must be text`);
  }
  if (value.length > max) throw validationError(`'${key}' is too long`);
  return value.trim();
};
const optStr = (args: Record<string, unknown>, key: string, max = 300): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw validationError(`'${key}' must be text`);
  return value.trim().slice(0, max);
};

export function createProposalService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;
  const today = () => localDateOf(service.clock.now(), service.zone);

  function requireDate(args: Record<string, unknown>, key: string): string {
    const value = str(args, key, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validationError(`'${key}' must be YYYY-MM-DD`);
    parseLocalDate(value);
    if (value > today()) throw validationError("That date is in the future");
    return value;
  }

  function defaultCurrency(): Currency {
    const visible = service.listAccounts().filter((a) => a.isUserVisible && a.archivedAt === undefined);
    return visible[0]?.currency ?? requireCurrency("LKR");
  }

  /**
   * Validates arguments and builds the owner-facing preview. Everything is checked *now*, against
   * real records, so the card never shows something that could not execute; and everything is
   * checked *again* at execution, because the world can change in ten minutes.
   */
  function build(actionType: ActionType, raw: Record<string, unknown>) {
    switch (actionType) {
      case ActionType.CREATE_TRANSACTION: {
        const kind = str(raw, "kind", 10);
        if (!["expense", "income", "refund"].includes(kind)) throw validationError("kind must be expense, income or refund");
        const account = service.findAccount(str(raw, "account_id"));
        if (!account || account.archivedAt !== undefined) throw validationError("Unknown or archived account_id. Call list_accounts.");
        // Models handle "3450.00" far more reliably than minor units; the strict parser keeps it exact.
        const amount = parseMajorUnits(account.currency, str(raw, "amount", 30));
        if (amount.minor <= 0n) throw validationError("amount must be positive");
        const date = requireDate(raw, "date");
        const categoryId = optStr(raw, "category_id") ?? (kind === "income" ? "income" : "uncategorized");
        const category = service.listCategories().find((c) => c.id === categoryId);
        if (!category) throw validationError("Unknown category_id. Call list_categories.");
        const merchant = optStr(raw, "merchant", 120);
        const notes = optStr(raw, "notes");

        const args = { kind, account_id: account.id, amount: formatMoney(amount, { withCode: false, grouping: false }),
                       currency: account.currency.code, date, category_id: categoryId, merchant, notes };
        const direction = kind === "expense" ? "falls" : "rises";
        const owed = account.kind === "liability";
        return {
          args,
          targets: { [account.id]: account.revision },
          preview: {
            title: kind === "expense" ? "Record an expense" : kind === "income" ? "Record income" : "Record a refund",
            lines: [
              { label: "Amount", value: formatMoney(amount) },
              { label: "Account", value: account.name },
              { label: "Date", value: date },
              { label: "Category", value: category.name },
              ...(merchant ? [{ label: kind === "income" ? "From" : "Merchant", value: merchant }] : []),
              ...(notes ? [{ label: "Notes", value: notes }] : []),
            ],
            effects: [
              owed
                ? `${account.name}: balance owed ${kind === "expense" ? "rises" : "falls"} by ${formatMoney(amount)}`
                : `${account.name}: balance ${direction} by ${formatMoney(amount)}`,
            ],
            risk: "low" as const,
          },
        };
      }

      case ActionType.CREATE_TRANSFER: {
        const from = service.findAccount(str(raw, "from_account_id"));
        const to = service.findAccount(str(raw, "to_account_id"));
        if (!from || !to) throw validationError("Unknown account id. Call list_accounts.");
        if (from.id === to.id) throw validationError("A transfer needs two different accounts");
        if (from.currency.code !== to.currency.code) throw validationError("Cross-currency transfers are not supported yet");
        const amount = parseMajorUnits(from.currency, str(raw, "amount", 30));
        if (amount.minor <= 0n) throw validationError("amount must be positive");
        const date = requireDate(raw, "date");
        const notes = optStr(raw, "notes");
        return {
          args: { from_account_id: from.id, to_account_id: to.id,
                  amount: formatMoney(amount, { withCode: false, grouping: false }), currency: from.currency.code, date, notes },
          targets: { [from.id]: from.revision, [to.id]: to.revision },
          preview: {
            title: to.kind === "liability" ? "Record a card payment" : "Record a transfer",
            lines: [
              { label: "Amount", value: formatMoney(amount) },
              { label: "From", value: from.name },
              { label: "To", value: to.name },
              { label: "Date", value: date },
            ],
            effects: [
              `${from.name}: balance falls by ${formatMoney(amount)}`,
              to.kind === "liability"
                ? `${to.name}: balance owed falls by ${formatMoney(amount)}`
                : `${to.name}: balance rises by ${formatMoney(amount)}`,
              "This is a transfer, not spending.",
            ],
            risk: "low" as const,
          },
        };
      }

      case ActionType.DELETE_TRANSACTION: {
        const id = str(raw, "transaction_id");
        const detail = service.getTransactionDetail(id);
        if (detail.transaction.status !== "posted") throw validationError("That transaction is not active");
        const rev = detail.currentRevision;
        return {
          args: { transaction_id: id },
          // §14.3: "Exact affected IDs and their revisions, not a live search expression."
          targets: { [id]: detail.transaction.currentRevision },
          preview: {
            title: "Move a transaction to Trash",
            lines: [
              { label: "Transaction", value: rev.merchantName ?? detail.transaction.kind },
              { label: "Amount", value: formatMoney(rev.displayAmount) },
              { label: "Date", value: localDateOf(rev.occurredAt.instant, rev.occurredAt.zone) },
            ],
            effects: ["Its effect on your balances is reversed.", "It can be restored from Activity → Trash."],
            risk: "high" as const,
          },
        };
      }

      case ActionType.EDIT_TRANSACTION: {
        const id = str(raw, "transaction_id");
        const detail = service.getTransactionDetail(id);
        if (detail.transaction.status !== "posted") throw validationError("Only an active posted transaction can be edited");
        if (detail.transaction.kind !== "expense" && detail.transaction.kind !== "income") {
          throw validationError("Only expenses and income can be edited with this tool");
        }
        const rev = detail.currentRevision;
        const nextAccountId = optStr(raw, "account_id") ?? detail.accounts[0]?.id;
        if (!nextAccountId) throw validationError("account_id is required");
        const account = service.findAccount(nextAccountId);
        if (!account || account.archivedAt !== undefined || !account.isUserVisible) {
          throw validationError("Unknown or archived account_id. Call list_accounts.");
        }
        if (detail.transaction.kind === "income" && account.kind !== AccountKind.ASSET) {
          throw validationError("Income must be received into an asset account");
        }
        const amountInput = optStr(raw, "amount", 30);
        const amount = amountInput ? parseMajorUnits(account.currency, amountInput) : rev.displayAmount;
        if (amount.minor <= 0n) throw validationError("amount must be positive");
        if (amount.currency.code !== account.currency.code) {
          throw validationError(`Amount currency (${amount.currency.code}) must match ${account.name} (${account.currency.code})`);
        }
        const date = optStr(raw, "date", 10)
          ? requireDate(raw, "date")
          : localDateOf(rev.occurredAt.instant, rev.occurredAt.zone);
        const categoryInput = optStr(raw, "category_id");
        const multiSplitPreserved =
          amountInput === undefined &&
          categoryInput === undefined &&
          rev.categoryId === undefined &&
          (detail.journal?.entries.filter((e) => e.categoryId !== undefined).length ?? 0) > 1;
        const categoryId = categoryInput ?? rev.categoryId ?? (detail.transaction.kind === "income" ? "income" : "uncategorized");
        const category = service.listCategories(true).find((c) => c.id === categoryId);
        if (!multiSplitPreserved) {
          if (!category || (categoryInput !== undefined && category.archivedAt !== undefined)) {
            throw validationError("Unknown category_id. Call list_categories.");
          }
          if (category.kind !== detail.transaction.kind) {
            throw validationError(`Category '${category.name}' is for ${category.kind}, not ${detail.transaction.kind}`);
          }
        }
        const merchant = raw.merchant === undefined ? rev.merchantName : optStr(raw, "merchant", 120);
        const notes = raw.notes === undefined ? rev.notes : optStr(raw, "notes");
        return {
          args: {
            transaction_id: id,
            kind: detail.transaction.kind,
            account_id: account.id,
            amount: formatMoney(amount, { withCode: false, grouping: false }),
            currency: account.currency.code,
            date,
            category_id: categoryId,
            preserve_splits: multiSplitPreserved,
            merchant,
            notes,
          },
          targets: { [id]: detail.transaction.currentRevision, [account.id]: account.revision },
          preview: {
            title: detail.transaction.kind === "expense" ? "Edit expense" : "Edit income",
            lines: [
              { label: "Amount", value: formatMoney(amount) },
              { label: "Account", value: account.name },
              { label: "Date", value: date },
              { label: "Category", value: multiSplitPreserved ? "Multiple categories (unchanged)" : (category?.name ?? categoryId) },
              ...(merchant ? [{ label: detail.transaction.kind === "income" ? "From" : "Merchant", value: merchant }] : []),
              ...(notes ? [{ label: "Notes", value: notes }] : []),
            ],
            effects: ["Replaces the active revision with an auditable reversal + replacement journal."],
            risk: "low" as const,
          },
        };
      }

      case ActionType.RESTORE_TRANSACTION: {
        const id = str(raw, "transaction_id");
        const detail = service.getTransactionDetail(id);
        if (detail.transaction.status !== "deleted") throw validationError("That transaction is not in Trash");
        const rev = detail.currentRevision;
        return {
          args: { transaction_id: id },
          targets: { [id]: detail.transaction.currentRevision },
          preview: {
            title: "Restore a transaction from Trash",
            lines: [
              { label: "Transaction", value: rev.merchantName ?? detail.transaction.kind },
              { label: "Amount", value: formatMoney(rev.displayAmount) },
              { label: "Date", value: localDateOf(rev.occurredAt.instant, rev.occurredAt.zone) },
            ],
            effects: ["Its effect on your balances is restored."],
            risk: "low" as const,
          },
        };
      }

      case ActionType.SET_BUDGET: {
        const categoryId = str(raw, "category_id");
        const category = service.listCategories(false).find((c) => c.id === categoryId);
        if (!category) throw validationError("Unknown or archived category_id. Call list_categories.");
        if (category.kind !== "expense") throw validationError("Budgets are only for spending categories.");
        const remove = raw.remove === true;
        if (remove) {
          return {
            args: { category_id: category.id, remove: true },
            targets: {},
            preview: {
              title: "Remove monthly budget",
              lines: [{ label: "Category", value: category.name }],
              effects: [`Removes the monthly budget limit for ${category.name} on the Plan screen.`],
              risk: "low" as const,
            },
          };
        }
        const curCode = optStr(raw, "currency", 10);
        const cur = curCode ? requireCurrency(curCode) : defaultCurrency();
        const amount = parseMajorUnits(cur, str(raw, "amount", 30));
        if (amount.minor <= 0n) throw validationError("Budget amount must be positive");
        return {
          args: {
            category_id: category.id,
            currency: cur.code,
            amount: formatMoney(amount, { withCode: false, grouping: false }),
            remove: false,
          },
          targets: {},
          preview: {
            title: "Set monthly budget",
            lines: [
              { label: "Category", value: category.name },
              { label: "Monthly limit", value: formatMoney(amount) },
            ],
            effects: [`Sets the ${category.name} monthly limit to ${formatMoney(amount)} on the Plan screen.`],
            risk: "low" as const,
          },
        };
      }

      case ActionType.CREATE_BILL: {
        const name = str(raw, "name", 60);
        const dirRaw = str(raw, "direction", 10).toLowerCase();
        const direction = dirRaw === "income" || dirRaw === "in" ? "in" : dirRaw === "bill" || dirRaw === "out" ? "out" : null;
        if (!direction) throw validationError("'direction' must be 'bill' or 'income'");
        const dueDay = typeof raw.due_day === "number"
          ? Math.trunc(raw.due_day)
          : typeof raw.due_day === "string" && /^\d+$/.test(raw.due_day.trim())
            ? Number(raw.due_day.trim())
            : NaN;
        if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
          throw validationError("'due_day' must be a day of the month from 1 to 31");
        }
        const accountId = optStr(raw, "account_id");
        const account = accountId ? service.findAccount(accountId) : undefined;
        if (accountId && (!account || !account.isUserVisible || account.archivedAt !== undefined)) {
          throw validationError("Unknown or archived account_id. Call list_accounts.");
        }
        if (account && direction === "in" && account.kind !== AccountKind.ASSET) {
          throw validationError("Expected income must arrive in a bank, cash, or wallet account");
        }
        const categoryId = optStr(raw, "category_id");
        const category = categoryId ? service.listCategories(false).find((c) => c.id === categoryId) : undefined;
        if (categoryId && !category) throw validationError("Unknown category_id. Call list_categories.");
        const curCode = optStr(raw, "currency", 10);
        const cur = account?.currency ?? (curCode ? requireCurrency(curCode) : defaultCurrency());
        const amount = parseMajorUnits(cur, str(raw, "amount", 30));
        if (amount.minor <= 0n) throw validationError("amount must be positive");
        return {
          args: {
            name,
            direction,
            amount: formatMoney(amount, { withCode: false, grouping: false }),
            currency: cur.code,
            due_day: dueDay,
            account_id: account?.id,
            category_id: category?.id,
          },
          targets: account ? { [account.id]: account.revision } : {},
          preview: {
            title: direction === "in" ? "Add expected income" : "Add recurring bill",
            lines: [
              { label: "Name", value: name },
              { label: "Amount", value: formatMoney(amount) },
              { label: "Due day", value: `Day ${dueDay} each month` },
              ...(account ? [{ label: "Account", value: account.name }] : []),
              ...(category ? [{ label: "Category", value: category.name }] : []),
            ],
            effects: ["Adds this recurring item to the Bills screen and cash forecast."],
            risk: "low" as const,
          },
        };
      }

      case ActionType.CREATE_GOAL: {
        const name = str(raw, "name", 60);
        const accountId = optStr(raw, "account_id");
        const account = accountId ? service.findAccount(accountId) : undefined;
        if (accountId && (!account || !account.isUserVisible || account.archivedAt !== undefined || account.kind !== AccountKind.ASSET)) {
          throw validationError("Goal account must be an active bank, cash, wallet, or savings account");
        }
        const curCode = optStr(raw, "currency", 10);
        const cur = account?.currency ?? (curCode ? requireCurrency(curCode) : defaultCurrency());
        const target = parseMajorUnits(cur, str(raw, "target_amount", 30));
        if (target.minor <= 0n) throw validationError("target_amount must be positive");
        const targetDate = optStr(raw, "target_date", 10);
        if (targetDate) parseLocalDate(targetDate);
        const savedInput = optStr(raw, "saved_amount", 30);
        if (savedInput && account) {
          throw validationError("A goal linked to an account tracks that account's balance automatically; omit saved_amount.");
        }
        const saved = savedInput ? parseMajorUnits(cur, savedInput) : undefined;
        if (saved && saved.minor < 0n) throw validationError("saved_amount cannot be negative");
        return {
          args: {
            name,
            target_amount: formatMoney(target, { withCode: false, grouping: false }),
            currency: cur.code,
            target_date: targetDate,
            account_id: account?.id,
            saved_amount: saved ? formatMoney(saved, { withCode: false, grouping: false }) : undefined,
          },
          targets: account ? { [account.id]: account.revision } : {},
          preview: {
            title: "Create savings goal",
            lines: [
              { label: "Goal", value: name },
              { label: "Target", value: formatMoney(target) },
              ...(targetDate ? [{ label: "Target date", value: targetDate }] : []),
              ...(account ? [{ label: "Linked account", value: account.name }] : []),
              ...(saved ? [{ label: "Starting saved", value: formatMoney(saved) }] : []),
            ],
            effects: ["Adds this savings goal to the Plan screen."],
            risk: "low" as const,
          },
        };
      }

      case ActionType.CREATE_CATEGORY: {
        const name = str(raw, "name", 40).replace(/\s+/g, " ");
        const kind = str(raw, "kind", 10);
        if (kind !== "expense" && kind !== "income") throw validationError("kind must be expense or income");
        const clash = service.listCategories(false).find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (clash) throw validationError(`There is already a category called '${clash.name}'`);
        return {
          args: { name, kind },
          targets: {},
          preview: {
            title: "Create category",
            lines: [
              { label: "Name", value: name },
              { label: "Kind", value: kind === "income" ? "Income" : "Spending" },
            ],
            effects: ["Adds this category to the Categories screen."],
            risk: "low" as const,
          },
        };
      }
    }
  }

  function createProposal(input: {
    actionType: ActionType;
    args: Record<string, unknown>;
    sessionId: string;
    model: ModelIdentity;
  }): ProposalRecord {
    const built = build(input.actionType, input.args);
    const now = service.clock.now();
    const id = `prop_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
    const hash = hashOf(input.actionType, built.args, built.targets);
    db.prepare(
      `INSERT INTO action_proposals
         (id, actor_kind, session_id, model_identity_json, action_type, arguments_json,
          target_versions_json, preview_json, hash, expires_at, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`,
    ).run(id, ActorKind.AGENT, input.sessionId, JSON.stringify(input.model), input.actionType,
          JSON.stringify(built.args), JSON.stringify(built.targets), JSON.stringify(built.preview),
          hash, now + PROPOSAL_TTL_MS, now);
    return { id, actionType: input.actionType, status: "pending", hash, expiresAt: now + PROPOSAL_TTL_MS,
             preview: built.preview, createdAt: now };
  }

  function mapRow(row: Record<string, unknown>): ProposalRecord {
    const result = asOptionalText(row.result_json, "result_json");
    return {
      id: asText(row.id, "id"),
      actionType: asText(row.action_type, "action_type") as ActionType,
      status: asText(row.status, "status"),
      hash: asText(row.hash, "hash"),
      expiresAt: asNumber(row.expires_at, "expires_at"),
      preview: JSON.parse(asText(row.preview_json, "preview_json")) as ProposalPreview,
      createdAt: asNumber(row.created_at, "created_at"),
      resultText: result ? (JSON.parse(result) as { text?: string }).text : undefined,
    };
  }

  function get(id: string): ProposalRecord | undefined {
    const row = db.prepare("SELECT * FROM action_proposals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  function finish(id: string, status: string, text: string): void {
    db.prepare("UPDATE action_proposals SET status = ?, result_json = ?, resolved_at = ? WHERE id = ?")
      .run(status, JSON.stringify({ text }), service.clock.now(), id);
  }

  /**
   * The owner pressed Confirm. Called ONLY from the trusted UI's server action.
   *
   * §14.3: "The executor checks capabilities, approval binding, expiry, hash, referenced versions,
   * and current state again inside a transaction... Execution is idempotent; repeating the same
   * approved request returns its original result."
   */
  function approveAndExecute(input: { proposalId: string; shownHash: string; currentModel: ModelIdentity | null }): ProposalRecord {
    const row = db.prepare("SELECT * FROM action_proposals WHERE id = ?").get(input.proposalId) as Record<string, unknown> | undefined;
    if (!row) throw new FinanceError(FinanceErrorCode.NOT_FOUND, "That proposal no longer exists.");
    const status = asText(row.status, "status");
    if (status === "executed") return mapRow(row); // confirmed twice: same result, no second write (§20)
    if (status !== "pending") throw new FinanceError(FinanceErrorCode.STALE_PROPOSAL, `That proposal was already ${status}.`);

    const now = service.clock.now();
    if (now > asNumber(row.expires_at, "expires_at")) {
      finish(input.proposalId, "expired", "Expired before it was confirmed.");
      throw new FinanceError(FinanceErrorCode.STALE_PROPOSAL, "That proposal expired. Ask again for a fresh one.");
    }

    const actionType = asText(row.action_type, "action_type") as ActionType;
    const args = JSON.parse(asText(row.arguments_json, "arguments_json")) as Record<string, unknown>;
    const targets = JSON.parse(asText(row.target_versions_json, "target_versions_json")) as Record<string, number>;

    // The card the owner saw carried this hash. Anything else is not what they approved.
    if (input.shownHash !== asText(row.hash, "hash") || hashOf(actionType, args, targets) !== input.shownHash) {
      throw new FinanceError(FinanceErrorCode.STALE_PROPOSAL, "This proposal does not match what was shown. Nothing was changed.");
    }

    // §14.1: "Changing models invalidates unapproved proposals unless revalidated."
    const proposedBy = JSON.parse(asText(row.model_identity_json, "model_identity_json")) as ModelIdentity;
    // A draft made by the built-in rules has no model behind it, so there is nothing to go stale.
    const draftedByModel = proposedBy.endpoint !== "local";
    if (draftedByModel && input.currentModel && (proposedBy.model !== input.currentModel.model || proposedBy.digest !== input.currentModel.digest)) {
      finish(input.proposalId, "stale", "The assistant model changed after this was proposed.");
      throw new FinanceError(FinanceErrorCode.STALE_PROPOSAL, "The assistant model changed since this was proposed. Ask again.");
    }

    // Re-validate against the present: accounts archived, records edited or deleted meanwhile.
    let rebuilt;
    try {
      rebuilt = build(actionType, args);
    } catch (error) {
      finish(input.proposalId, "stale", error instanceof Error ? error.message : "No longer valid.");
      throw new FinanceError(FinanceErrorCode.STALE_PROPOSAL, `This can no longer be done: ${error instanceof Error ? error.message : "state changed"}`);
    }
    if (
      (actionType === ActionType.DELETE_TRANSACTION ||
        actionType === ActionType.EDIT_TRANSACTION ||
        actionType === ActionType.RESTORE_TRANSACTION) &&
      canonical(rebuilt.targets) !== canonical(targets)
    ) {
      finish(input.proposalId, "stale", "The transaction was edited after this was proposed.");
      throw new FinanceError(FinanceErrorCode.STALE_PROPOSAL, "That transaction changed since this was proposed. Ask again for a fresh preview.");
    }

    const write = {
      actor: { kind: ActorKind.AGENT, modelIdentity: `${proposedBy.model}${proposedBy.digest ? `@${proposedBy.digest.slice(0, 12)}` : ""}` },
      origin: "assistant.proposal",
      reason: `Owner confirmed an assistant proposal (${actionType})`,
      idempotencyKey: `proposal:${input.proposalId}`,
    };

    try {
      const text = db.transaction(() => {
        db.prepare("INSERT INTO approval_receipts (id, proposal_id, proposal_hash, approved_at, consumed_at) VALUES (?,?,?,?,?)")
          .run(`appr_${randomUUID().replace(/-/g, "").slice(0, 22)}`, input.proposalId, input.shownHash, now, now);

        let summary: string;
        if (actionType === ActionType.CREATE_TRANSACTION) {
          const account = service.findAccount(String(args.account_id))!;
          const amount = parseMajorUnits(account.currency, String(args.amount));
          const occurredAt = dateOnlyTime(String(args.date), service.zone);
          const common = { accountId: account.id, amount, occurredAt,
                           merchantName: args.merchant as string | undefined, notes: args.notes as string | undefined };
          const categoryId = String(args.category_id);
          if (args.kind === "expense") service.createExpense({ ...common, splits: [{ categoryId, amount }] }, write);
          else if (args.kind === "income") service.createIncome({ ...common, splits: [{ categoryId, amount }] }, write);
          else service.createRefund({ ...common, categoryId }, write);
          summary = `Recorded ${formatMoney(amount)} on ${account.name}.`;
        } else if (actionType === ActionType.CREATE_TRANSFER) {
          const from = service.findAccount(String(args.from_account_id))!;
          const amount = parseMajorUnits(from.currency, String(args.amount));
          service.createTransfer({ fromAccountId: from.id, toAccountId: String(args.to_account_id), amount,
                                   occurredAt: dateOnlyTime(String(args.date), service.zone), notes: args.notes as string | undefined }, write);
          summary = `Transferred ${formatMoney(amount)}.`;
        } else if (actionType === ActionType.DELETE_TRANSACTION) {
          const id = String(args.transaction_id);
          service.deleteTransaction({ transactionId: id, expectedRevision: targets[id] ?? 0 }, write);
          summary = "Moved to Trash. You can restore it from Activity.";
        } else if (actionType === ActionType.EDIT_TRANSACTION) {
          const id = String(args.transaction_id);
          const account = service.findAccount(String(args.account_id))!;
          const amount = parseMajorUnits(account.currency, String(args.amount));
          const occurredAt = dateOnlyTime(String(args.date), service.zone);
          const detail = service.getTransactionDetail(id);
          const splits = args.preserve_splits && detail.journal
            ? detail.journal.entries
                .filter((e) => e.categoryId !== undefined)
                .map((e) => ({
                  categoryId: e.categoryId!,
                  amount: money(account.currency, e.amountMinorSigned < 0n ? -e.amountMinorSigned : e.amountMinorSigned),
                }))
            : [{ categoryId: String(args.category_id), amount }];
          const editInput = {
            transactionId: id,
            expectedRevision: targets[id] ?? 0,
            accountId: account.id,
            amount,
            occurredAt,
            splits,
            merchantName: args.merchant as string | undefined,
            notes: args.notes as string | undefined,
          };
          if (args.kind === "income") service.editIncome(editInput, write);
          else service.editExpense(editInput, write);
          summary = `Updated transaction to ${formatMoney(amount)} on ${account.name}.`;
        } else if (actionType === ActionType.RESTORE_TRANSACTION) {
          const id = String(args.transaction_id);
          service.restoreTransaction({ transactionId: id, expectedRevision: targets[id] ?? 0 }, write);
          summary = "Restored from Trash.";
        } else if (actionType === ActionType.SET_BUDGET) {
          const budgets = createBudgetService({ db, service });
          const categoryId = String(args.category_id);
          if (args.remove) {
            budgets.set(categoryId, null);
            summary = "Removed monthly budget.";
          } else {
            const amount = parseMajorUnits(requireCurrency(String(args.currency)), String(args.amount));
            budgets.set(categoryId, amount);
            summary = `Set monthly budget to ${formatMoney(amount)}.`;
          }
        } else if (actionType === ActionType.CREATE_BILL) {
          const cur = requireCurrency(String(args.currency));
          const amount = parseMajorUnits(cur, String(args.amount));
          const created = createRecurringService({ db, service }).create({
            name: String(args.name),
            direction: args.direction === "in" ? "in" : "out",
            amount,
            dueDay: Number(args.due_day),
            accountId: (args.account_id as string | undefined) ?? null,
            categoryId: (args.category_id as string | undefined) ?? null,
          });
          summary = `Added recurring item "${created.name}" (${formatMoney(amount)}).`;
        } else if (actionType === ActionType.CREATE_GOAL) {
          const cur = requireCurrency(String(args.currency));
          const target = parseMajorUnits(cur, String(args.target_amount));
          const saved = args.saved_amount ? parseMajorUnits(cur, String(args.saved_amount)) : undefined;
          createGoalService({ db, service }).create({
            name: String(args.name),
            target,
            targetDate: (args.target_date as string | undefined) ?? null,
            accountId: (args.account_id as string | undefined) ?? null,
            saved,
          });
          summary = `Created savings goal "${String(args.name)}" (${formatMoney(target)}).`;
        } else {
          const created = createCategoryService({ db, service }).create({
            name: String(args.name),
            kind: args.kind === "income" ? "income" : "expense",
          });
          summary = `Created category "${created.name}".`;
        }
        finish(input.proposalId, "executed", summary);
        return summary;
      });
      void text;
    } catch (error) {
      finish(input.proposalId, "failed", error instanceof Error ? error.message : "Failed.");
      throw error;
    }
    return get(input.proposalId)!;
  }

  function cancel(proposalId: string): void {
    db.prepare("UPDATE action_proposals SET status='cancelled', resolved_at=? WHERE id=? AND status='pending'")
      .run(service.clock.now(), proposalId);
  }

  function listForSession(sessionId: string): ProposalRecord[] {
    return (db.prepare("SELECT * FROM action_proposals WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as Record<string, unknown>[]).map(mapRow);
  }

  return { createProposal, approveAndExecute, cancel, get, listForSession };
}

export type ProposalService = ReturnType<typeof createProposalService>;
