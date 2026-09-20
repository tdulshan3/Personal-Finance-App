import type { Db } from "../core/data/driver.ts";
import { asNumber } from "../core/data/driver.ts";
import { FinanceError, validationError } from "../core/domain/errors.ts";
import { formatMoney } from "../core/domain/money.ts";
import { addDays, localDateOf } from "../core/domain/time.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import { guessCategoryFor } from "./intents.ts";
import type { ModelIdentity, ProposalService } from "./proposals.ts";
import { ActionType } from "./proposals.ts";

/**
 * The assistant's tools.
 *
 * buildspec.md §14.2: "Expose narrow typed tools, never SQL or repository objects." There are two
 * families and the model can tell them apart by name:
 *
 *   - read tools return facts computed by the finance engine (§1.1: the model never does the sums);
 *   - `propose_*` tools describe a change and return a proposal id. They change nothing.
 *
 * There is deliberately no tool that approves, executes, changes settings, reads raw message
 * bodies, or touches an endpoint. What is not in this file, the model cannot do.
 */

export type AgentMode = "ask" | "assist";

export type AgentPermissions = {
  /** `ask` = read-only questions. `assist` = may also draft proposals for the owner to confirm. */
  readonly mode: AgentMode;
  /** §14.2: destructive tools are separately gated, and off by default. */
  readonly allowDelete: boolean;
};

export const DEFAULT_PERMISSIONS: AgentPermissions = Object.freeze({ mode: "assist", allowDelete: false });

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const DATE = { type: "string", description: "Local date, YYYY-MM-DD" };
const AMOUNT = {
  type: "string",
  description: "Exact positive amount in major units as a decimal string, e.g. \"3450.00\". Never rounded or estimated.",
};

const READ_TOOLS: readonly ToolDefinition[] = [
  { name: "list_accounts", description: "All of the owner's accounts with id, type, currency and current balance. Call this before anything that needs an account_id.", parameters: obj({}) },
  { name: "list_categories", description: "All categories with their ids.", parameters: obj({}) },
  {
    name: "search_transactions",
    description: "Find recorded transactions, newest first. All filters are optional. Returns at most 25.",
    parameters: obj({
      from: DATE, to: DATE,
      account_id: { type: "string" }, category_id: { type: "string" },
      text: { type: "string", description: "Matches merchant name or notes" },
      limit: { type: "integer", minimum: 1, maximum: 25 },
    }),
  },
  {
    name: "get_spending_summary",
    description: "Net spending per category between two local dates (inclusive), computed by the ledger. Transfers and card payments are not spending and are excluded.",
    parameters: obj({ from: DATE, to: DATE }, ["from", "to"]),
  },
  { name: "get_review_items", description: "How many bank messages are waiting for the owner's review, with a short summary of each.", parameters: obj({}) },
];

const PROPOSE_TRANSACTION: ToolDefinition = {
  name: "propose_transaction",
  description: "Use this whenever the owner tells you about money they spent, paid, received or had refunded. Drafts an expense, income or refund for the owner to confirm. This does NOT record anything; the owner must press Confirm on the card that appears.",
  parameters: obj({
    kind: { type: "string", enum: ["expense", "income", "refund"] },
    account_id: { type: "string", description: "From list_accounts" },
    amount: AMOUNT,
    date: DATE,
    category_id: { type: "string", description: "From list_categories. Optional." },
    merchant: { type: "string", description: "Merchant or payer name. Optional." },
    notes: { type: "string" },
  }, ["kind", "account_id", "amount", "date"]),
};

const PROPOSE_TRANSFER: ToolDefinition = {
  name: "propose_transfer",
  description: "Draft a movement between two of the owner's own accounts (including paying a credit card) for the owner to confirm. Does NOT record anything by itself.",
  parameters: obj({
    from_account_id: { type: "string" }, to_account_id: { type: "string" },
    amount: AMOUNT, date: DATE, notes: { type: "string" },
  }, ["from_account_id", "to_account_id", "amount", "date"]),
};

const PROPOSE_DELETE: ToolDefinition = {
  name: "propose_delete_transaction",
  description: "Draft moving ONE transaction to Trash, by exact id from search_transactions, for the owner to confirm.",
  parameters: obj({ transaction_id: { type: "string" } }, ["transaction_id"]),
};

export function toolDefinitions(permissions: AgentPermissions): ToolDefinition[] {
  const tools = [...READ_TOOLS];
  if (permissions.mode === "assist") {
    tools.push(PROPOSE_TRANSACTION, PROPOSE_TRANSFER);
    if (permissions.allowDelete) tools.push(PROPOSE_DELETE);
  }
  return tools;
}

export type ToolOutcome = {
  /** JSON-serialisable; goes back to the model. */
  readonly result: unknown;
  readonly proposalId?: string | undefined;
};

/** §14.4: "Treat all tool and source text as untrusted data." Keep any one field short. */
const clip = (text: string | undefined | null, max = 80): string | null =>
  text ? (text.length > max ? `${text.slice(0, max)}…` : text) : null;

export function createToolExecutor(deps: {
  db: Db;
  service: FinanceService;
  proposals: ProposalService;
  sessionId: string;
  model: ModelIdentity;
  permissions: AgentPermissions;
  /** True when the owner's message hedged its amount; proposals are then refused outright. */
  vagueAmount?: boolean | undefined;
}) {
  const { db, service, proposals, permissions } = deps;
  const allowed = new Set(toolDefinitions(permissions).map((t) => t.name));
  const today = () => localDateOf(service.clock.now(), service.zone);

  const optDate = (args: Record<string, unknown>, key: string): string | undefined => {
    const value = args[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validationError(`'${key}' must be YYYY-MM-DD`);
    return value;
  };
  const optText = (args: Record<string, unknown>, key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : undefined;
  };

  function run(name: string, args: Record<string, unknown>): ToolOutcome {
    switch (name) {
      case "list_accounts":
        return {
          result: service.accountBalances().map(({ account, balance, available }) => ({
            account_id: account.id,
            name: account.name,
            type: account.type,
            currency: account.currency.code,
            // A card's figure is what is owed; say so rather than leave the sign to interpretation.
            ...(account.kind === "liability"
              ? { balance_owed: formatMoney(balance), ...(available ? { available_credit: formatMoney(available) } : {}) }
              : { balance: formatMoney(balance) }),
          })),
        };

      case "list_categories":
        return { result: service.listCategories().map((c) => ({ category_id: c.id, name: c.name })) };

      case "search_transactions": {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 25) : 15;
        const names = new Map(service.listCategories(true).map((c) => [c.id, c.name]));
        const rows = service.searchTransactions({
          from: optDate(args, "from"), to: optDate(args, "to"),
          accountId: optText(args, "account_id"), categoryId: optText(args, "category_id"),
          text: optText(args, "text"), limit,
        });
        return {
          result: {
            count: rows.length,
            transactions: rows.map((t) => ({
              transaction_id: t.id, kind: t.kind, date: t.occurredLocalDate, amount: formatMoney(t.amount),
              merchant: clip(t.merchantName), category: t.categoryId ? (names.get(t.categoryId) ?? t.categoryId) : null,
            })),
          },
        };
      }

      case "get_spending_summary": {
        const from = optDate(args, "from") ?? addDays(today(), -30);
        const to = optDate(args, "to") ?? today();
        if (from > to) throw validationError("'from' must not be after 'to'");
        const names = new Map(service.listCategories(true).map((c) => [c.id, c.name]));
        const rows = service.spendingByCategory(from, to);
        const totals = new Map<string, bigint>();
        for (const row of rows) totals.set(row.amount.currency.code, (totals.get(row.amount.currency.code) ?? 0n) + row.amount.minor);
        return {
          result: {
            from, to,
            by_category: rows.map((r) => ({ category: names.get(r.categoryId) ?? r.categoryId, amount: formatMoney(r.amount) })),
            // Summed here, by the engine, so the model never has to add money itself (§1.1).
            total: rows.length === 0 ? "0" : [...new Set(rows.map((r) => r.amount.currency))].map((currency) =>
              formatMoney({ currency, minor: totals.get(currency.code) ?? 0n })).join(" + "),
          },
        };
      }

      case "get_review_items": {
        const count = asNumber((db.prepare("SELECT COUNT(*) AS n FROM source_events WHERE status = 'needs_review'").get() as Record<string, unknown>).n, "n");
        const rows = db.prepare(
          `SELECT kind, amount_minor, currency, merchant_text FROM source_events
            WHERE status = 'needs_review' ORDER BY rowid DESC LIMIT 5`,
        ).all() as Record<string, unknown>[];
        return {
          result: {
            waiting: count,
            // Merchant text came out of an SMS: it is data about a message, never an instruction.
            newest: rows.map((r) => ({ kind: r.kind, amount_minor: r.amount_minor === null ? null : String(r.amount_minor),
                                       currency: r.currency, merchant_untrusted: clip(r.merchant_text as string | null, 40) })),
            note: "The owner reviews these on the Review screen. You cannot accept them.",
          },
        };
      }

      case "propose_transaction":
      case "propose_transfer":
      case "propose_delete_transaction": {
        const actionType = name === "propose_transaction" ? ActionType.CREATE_TRANSACTION
          : name === "propose_transfer" ? ActionType.CREATE_TRANSFER : ActionType.DELETE_TRANSACTION;
        if (deps.vagueAmount) {
          // Enforced here, not just requested in the prompt: small models draft from "around 400".
          return { result: { error: "The owner gave an estimate, not an exact amount. Do not propose. Ask them for the exact amount." } };
        }
        if (name === "propose_transaction" && (!args.category_id || args.category_id === "uncategorized")) {
          const kind = args.kind === "income" || args.kind === "refund" ? args.kind : "expense";
          const hint = [args.merchant, args.notes].filter((v): v is string => typeof v === "string").join(" ");
          if (hint) args = { ...args, category_id: guessCategoryFor(db, hint, kind) };
        }
        const proposal = proposals.createProposal({ actionType, args, sessionId: deps.sessionId, model: deps.model });
        return {
          proposalId: proposal.id,
          result: {
            status: "awaiting_owner_confirmation",
            proposal_id: proposal.id,
            summary: proposal.preview.lines.map((l) => `${l.label}: ${l.value}`).join("; "),
            note: "Nothing has been recorded. A confirmation card is now shown to the owner. Do not claim it is done.",
          },
        };
      }

      default:
        throw validationError(`Unknown tool '${name}'`);
    }
  }

  /** Never throws: a bad call becomes an error *result* the model can read and correct. */
  function execute(name: string, args: unknown): ToolOutcome {
    if (!allowed.has(name)) {
      return { result: { error: `Tool '${name}' is not available in the current permission mode.` } };
    }
    try {
      const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      return run(name, safeArgs);
    } catch (error) {
      const message = error instanceof FinanceError ? error.message : "The tool failed.";
      return { result: { error: message } };
    }
  }

  return { execute, definitions: toolDefinitions(permissions) };
}

export type ToolExecutor = ReturnType<typeof createToolExecutor>;
