import { accountNamesFor } from "../app/transactions/ledger-rows.ts";
import type { Db } from "../core/data/driver.ts";
import { asNumber } from "../core/data/driver.ts";
import { FinanceError, validationError } from "../core/domain/errors.ts";
import type { Money } from "../core/domain/money.ts";
import { formatMoney, money, requireCurrency } from "../core/domain/money.ts";
import { localDateOf } from "../core/domain/time.ts";
import { createDashboardService } from "../core/services/dashboard-service.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import { guessCategoryFor } from "./intents.ts";
import { createPlanningReader } from "./planning.ts";
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
  { name: "list_accounts", description: "All of the owner's visible accounts with id, type, currency and current balance, plus available_to_spend and total_owed_on_cards. Call this before anything that needs an account_id.", parameters: obj({}) },
  { name: "list_categories", description: "All categories with their ids.", parameters: obj({}) },
  {
    name: "search_transactions",
    description: "Find recorded transactions and exact totals matching filters. All filters are optional. Use sort='largest' for biggest expenses/transactions, or text to check if a bill or merchant was paid.",
    parameters: obj({
      from: DATE,
      to: DATE,
      account_id: { type: "string", description: "Account id or exact account name" },
      category_id: { type: "string", description: "Category id or exact category name" },
      kind: { type: "string", enum: ["expense", "income", "refund", "transfer"], description: "Filter by transaction type." },
      text: { type: "string", description: "Matches merchant name or notes" },
      sort: { type: "string", enum: ["newest", "largest"], description: "Use 'largest' for biggest expenses/transactions, 'newest' (default) for recent." },
      limit: { type: "integer", minimum: 1, maximum: 25 },
    }),
  },
  {
    name: "get_spending_summary",
    description: "Net spending per category and top merchants between two local dates (inclusive), computed by the ledger. Defaults to this month if dates are omitted. Transfers and card payments are not spending and are excluded.",
    parameters: obj({
      from: { type: "string", description: "Start date YYYY-MM-DD (defaults to first day of this month)" },
      to: { type: "string", description: "End date YYYY-MM-DD (defaults to today)" },
    }),
  },
  {
    name: "get_cashflow_summary",
    description: "Total income, total spending, net cashflow (income minus spending), income by category, spending by category, and top merchants between two local dates (inclusive). Use this for income, net savings, or comparing income vs spending. Defaults to this month if dates are omitted. Transfers and card payments are excluded.",
    parameters: obj({
      from: { type: "string", description: "Start date YYYY-MM-DD (defaults to first day of this month)" },
      to: { type: "string", description: "End date YYYY-MM-DD (defaults to today)" },
    }),
  },
  { name: "get_review_items", description: "How many bank messages are waiting for the owner's review, with a short summary of each.", parameters: obj({}) },
  { name: "get_upcoming_bills", description: "Saved recurring bills, expected income and credit card due dates for this month. Only covers saved recurring items; to check whether a specific bill (like electricity or water) was paid, also call search_transactions.", parameters: obj({}) },
  { name: "get_budgets", description: "This month's budget per category: limit, spent, remaining, percent used, projected month end, status.", parameters: obj({}) },
  { name: "get_cash_forecast", description: "The Plan screen's projection of spendable cash to the end of next month: spendable now, month-end (base and cautious), lowest point, buffer, how much could be set aside. Use it for 'how much can I save', 'will I run out'.", parameters: obj({}) },
  { name: "get_savings_goals", description: "Savings goals with saved, target, percent, target date and the monthly amount still needed.", parameters: obj({}) },
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
  const planning = createPlanningReader({ db, service });

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
  const optInt = (args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number => {
    const value = args[key];
    let parsed: number | undefined;
    if (typeof value === "number" && Number.isFinite(value)) parsed = Math.trunc(value);
    else if (typeof value === "string" && /^\d+$/.test(value.trim())) parsed = Number(value.trim());
    if (parsed === undefined) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };
  const monthStart = (date: string): string => `${date.slice(0, 8)}01`;
  const resolveAccountId = (raw: string, includeArchived = false): string => {
    const trimmed = raw.trim();
    if (service.findAccount(trimmed)) return trimmed;
    const matches = service
      .listAccounts({ includeArchived })
      .filter((a) => a.isUserVisible && (includeArchived || a.archivedAt === undefined) && a.name.toLowerCase() === trimmed.toLowerCase());
    return matches.length === 1 ? matches[0]!.id : trimmed;
  };
  const resolveCategoryId = (raw: string, includeArchived = false): string => {
    const trimmed = raw.trim();
    const cats = service.listCategories(includeArchived);
    if (cats.some((c) => c.id === trimmed)) return trimmed;
    const matches = cats.filter((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    return matches.length === 1 ? matches[0]!.id : trimmed;
  };
  const coerceAmount = (raw: unknown): unknown =>
    typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  const formatTotalsMap = (map: Map<string, Money>, empty = "0"): string =>
    map.size === 0 ? empty : [...map.values()].map((m) => formatMoney(m)).join(" + ");

  function run(name: string, args: Record<string, unknown>): ToolOutcome {
    switch (name) {
      case "list_accounts": {
        const accounts = service
          .accountBalances()
          .filter(({ account }) => account.isUserVisible)
          .map(({ account, balance, available }) => ({
            account_id: account.id,
            name: account.name,
            type: account.type,
            currency: account.currency.code,
            // A card's figure is what is owed; say so rather than leave the sign to interpretation.
            ...(account.kind === "liability"
              ? {
                  ...(balance.minor < 0n
                    ? { in_credit: formatMoney(money(balance.currency, -balance.minor)) }
                    : { balance_owed: formatMoney(balance) }),
                  ...(available ? { available_credit: formatMoney(available) } : {}),
                }
              : { balance: formatMoney(balance) }),
          }));
        const totals = service.homeTotals();
        const owed = new Map<string, Money>();
        for (const [code, amount] of totals.owed) {
          owed.set(code, amount.minor < 0n ? money(amount.currency, 0n) : amount);
        }
        return {
          result: {
            accounts,
            available_to_spend: formatTotalsMap(totals.liquid),
            total_owed_on_cards: formatTotalsMap(owed),
          },
        };
      }

      case "list_categories":
        return { result: service.listCategories().map((c) => ({ category_id: c.id, name: c.name })) };

      case "search_transactions": {
        const limit = optInt(args, "limit", 15, 1, 25);
        const rawAccount = optText(args, "account_id");
        const accountId = rawAccount ? resolveAccountId(rawAccount, true) : undefined;
        if (accountId && !service.findAccount(accountId)) {
          throw validationError(`Unknown account '${rawAccount}'. Call list_accounts.`);
        }
        const rawCategory = optText(args, "category_id");
        const categoryId = rawCategory ? resolveCategoryId(rawCategory, true) : undefined;
        const cats = service.listCategories(true);
        if (categoryId && !cats.some((c) => c.id === categoryId)) {
          throw validationError(`Unknown category '${rawCategory}'. Call list_categories.`);
        }
        const kind = optText(args, "kind");
        if (kind !== undefined && !["expense", "income", "refund", "transfer"].includes(kind)) {
          throw validationError("'kind' must be expense, income, refund or transfer");
        }
        const rawSort = optText(args, "sort");
        if (rawSort !== undefined && rawSort !== "newest" && rawSort !== "largest") {
          throw validationError("'sort' must be 'newest' or 'largest'");
        }
        const sort: "newest" | "largest" = rawSort === "largest" ? "largest" : "newest";

        const filters = {
          from: optDate(args, "from"),
          to: optDate(args, "to"),
          accountId,
          categoryId,
          kind,
          sort,
          text: optText(args, "text"),
        };
        const allRows: ReturnType<FinanceService["searchTransactions"]> = [];
        for (let offset = 0; ; offset += 200) {
          const page = service.searchTransactions({ ...filters, limit: 200, offset });
          allRows.push(...page);
          if (page.length < 200) break;
        }
        const shown = allRows.slice(0, limit);
        const names = new Map(cats.map((c) => [c.id, c.name]));
        const accountNames = accountNamesFor(db, shown);

        const byKindAndCurrency = new Map<string, Map<string, Money>>();
        for (const row of allRows) {
          const curMap = byKindAndCurrency.get(row.kind) ?? new Map<string, Money>();
          const prev = curMap.get(row.amount.currency.code);
          curMap.set(row.amount.currency.code, money(row.amount.currency, (prev?.minor ?? 0n) + row.amount.minor));
          byKindAndCurrency.set(row.kind, curMap);
        }
        const totalsByKind: Record<string, string> = {};
        for (const [rowKind, curMap] of byKindAndCurrency) {
          totalsByKind[rowKind] = formatTotalsMap(curMap);
        }

        return {
          result: {
            total_matches: allRows.length,
            returned: shown.length,
            truncated: allRows.length > shown.length,
            totals_by_kind: totalsByKind,
            transactions: shown.map((t) => ({
              transaction_id: t.id,
              kind: t.kind,
              date: t.occurredLocalDate,
              amount: formatMoney(t.amount),
              account: accountNames.get(t.id) ?? null,
              merchant: clip(t.merchantName),
              category: t.categoryId ? (names.get(t.categoryId) ?? t.categoryId) : null,
              ...(t.notes ? { notes: clip(t.notes) } : {}),
            })),
          },
        };
      }

      case "get_spending_summary": {
        const from = optDate(args, "from") ?? monthStart(today());
        const to = optDate(args, "to") ?? today();
        if (from > to) throw validationError("'from' must not be after 'to'");
        const names = new Map(service.listCategories(true).map((c) => [c.id, c.name]));
        const rows = service.spendingByCategory(from, to);
        const totals = new Map<string, Money>();
        const currencies = new Map<string, Money["currency"]>();
        for (const row of rows) {
          const code = row.amount.currency.code;
          currencies.set(code, row.amount.currency);
          const prev = totals.get(code);
          totals.set(code, money(row.amount.currency, (prev?.minor ?? 0n) + row.amount.minor));
        }
        const dashboard = createDashboardService({ db });
        const topMerchants = [...currencies.values()].flatMap((currency) =>
          dashboard.topMerchants(currency, from, to, 8).map((m) => ({
            merchant: m.merchant,
            amount: formatMoney(m.amount),
            count: m.times,
          })),
        );
        return {
          result: {
            from,
            to,
            by_category: rows.map((r) => ({ category: names.get(r.categoryId) ?? r.categoryId, amount: formatMoney(r.amount) })),
            top_merchants: topMerchants,
            // Summed here, by the engine, so the model never has to add money itself (§1.1).
            total: formatTotalsMap(totals),
          },
        };
      }

      case "get_cashflow_summary": {
        const from = optDate(args, "from") ?? monthStart(today());
        const to = optDate(args, "to") ?? today();
        if (from > to) throw validationError("'from' must not be after 'to'");
        const dashboard = createDashboardService({ db });
        const names = new Map(service.listCategories(true).map((c) => [c.id, c.name]));
        const currencyCodes = new Set([
          ...service.listAccounts().filter((a) => a.isUserVisible).map((a) => a.currency.code),
          ...dashboard.activeCurrencies(),
        ]);
        const byCurrency = [...currencyCodes].map((code) => {
          const currency = requireCurrency(code);
          const flow = dashboard.totals(currency, from, to);
          return {
            currency: code,
            income: formatMoney(flow.income),
            spending: formatMoney(flow.spending),
            net: formatMoney(flow.net),
            income_by_category: dashboard
              .byCategory(currency, from, to, "income")
              .map((r) => ({ category: names.get(r.categoryId) ?? r.categoryId, amount: formatMoney(r.amount) })),
            spending_by_category: dashboard
              .byCategory(currency, from, to, "expense")
              .map((r) => ({ category: names.get(r.categoryId) ?? r.categoryId, amount: formatMoney(r.amount) })),
            top_merchants: dashboard
              .topMerchants(currency, from, to, 8)
              .map((m) => ({ merchant: m.merchant, amount: formatMoney(m.amount), count: m.times })),
          };
        });
        return {
          result: {
            from,
            to,
            by_currency: byCurrency,
            note: "Transfers and card payments are excluded from income and spending.",
          },
        };
      }

      case "get_upcoming_bills":
        return {
          result: {
            bills: planning.bills(),
            note: "Lists saved recurring schedules and cards only. To verify if a specific bill or merchant was paid, also call search_transactions.",
          },
        };
      case "get_budgets":
        return { result: { budgets: planning.budgets() } };
      case "get_cash_forecast":
        return { result: { forecasts: planning.forecast(), note: "Planning estimate, not a promise. Quote these figures; do not recompute them." } };
      case "get_savings_goals":
        return { result: { goals: planning.goals() } };

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
        const normalized: Record<string, unknown> = { ...args };
        if (name === "propose_transaction") {
          normalized.amount = coerceAmount(normalized.amount);
          if (typeof normalized.account_id === "string") normalized.account_id = resolveAccountId(normalized.account_id);
          if (typeof normalized.category_id === "string") normalized.category_id = resolveCategoryId(normalized.category_id);
          if (!normalized.category_id || normalized.category_id === "uncategorized") {
            const kind = normalized.kind === "income" || normalized.kind === "refund" ? normalized.kind : "expense";
            const hint = [normalized.merchant, normalized.notes].filter((v): v is string => typeof v === "string").join(" ");
            if (hint) normalized.category_id = guessCategoryFor(db, hint, kind);
          }
        } else if (name === "propose_transfer") {
          normalized.amount = coerceAmount(normalized.amount);
          if (typeof normalized.from_account_id === "string") normalized.from_account_id = resolveAccountId(normalized.from_account_id);
          if (typeof normalized.to_account_id === "string") normalized.to_account_id = resolveAccountId(normalized.to_account_id);
        }
        const proposal = proposals.createProposal({ actionType, args: normalized, sessionId: deps.sessionId, model: deps.model });
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
