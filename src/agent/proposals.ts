import { createHash, randomUUID } from "node:crypto";

import type { Db } from "../core/data/driver.ts";
import { asNumber, asOptionalText, asText } from "../core/data/driver.ts";
import { FinanceError, FinanceErrorCode, validationError } from "../core/domain/errors.ts";
import { formatMoney, parseMajorUnits } from "../core/domain/money.ts";
import { ActorKind } from "../core/domain/posting.ts";
import { dateOnlyTime, localDateOf } from "../core/domain/time.ts";
import type { FinanceService } from "../core/services/finance-service.ts";

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
    if (value > today()) throw validationError("That date is in the future");
    return value;
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
    if (actionType === ActionType.DELETE_TRANSACTION && canonical(rebuilt.targets) !== canonical(targets)) {
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
        } else {
          const id = String(args.transaction_id);
          service.deleteTransaction({ transactionId: id, expectedRevision: targets[id] ?? 0 }, write);
          summary = "Moved to Trash. You can restore it from Activity.";
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
