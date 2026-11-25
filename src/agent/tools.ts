import { accountNamesFor } from "../app/transactions/ledger-rows.ts";
import type { Db } from "../core/data/driver.ts";
import { FinanceError, validationError } from "../core/domain/errors.ts";
import type { Money } from "../core/domain/money.ts";
import { formatMoney, money, requireCurrency } from "../core/domain/money.ts";
import { TransactionStatus } from "../core/domain/transaction.ts";
import { localDateOf } from "../core/domain/time.ts";
import { createBalanceCheckService } from "../core/services/balance-check.ts";
import { createDashboardService } from "../core/services/dashboard-service.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import { guessCategoryFor } from "./intents.ts";
import { createPlanningReader } from "./planning.ts";
import type { ModelIdentity, ProposalService } from "./proposals.ts";
import { ActionType } from "./proposals.ts";
import { createExpenseReporter, formatCurrencyMap } from "./reporting.ts";

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
  { name: "list_categories", description: "All categories with their id, name and kind (expense or income).", parameters: obj({}) },
  {
    name: "search_transactions",
    description: "Find recorded transactions and exact totals matching filters. All filters are optional. Use sort='largest' for biggest expenses/transactions, text to check if a bill or merchant was paid, include_history_only=true for pre-tracking historical imports, or status='deleted' for Trash.",
    parameters: obj({
      from: DATE,
      to: DATE,
      account_id: { type: "string", description: "Account id or exact account name" },
      category_id: { type: "string", description: "Category id or exact category name" },
      kind: { type: "string", enum: ["expense", "income", "refund", "transfer"], description: "Filter by transaction type." },
      status: { type: "string", enum: ["posted", "deleted"], description: "Use 'deleted' to inspect Trash (default 'posted')." },
      include_history_only: { type: "boolean", description: "Set true to include imported pre-tracking history_only records." },
      text: { type: "string", description: "Matches merchant name or notes" },
      sort: { type: "string", enum: ["newest", "largest"], description: "Use 'largest' for biggest expenses/transactions, 'newest' (default) for recent." },
      limit: { type: "integer", minimum: 1, maximum: 25 },
    }),
  },
  {
    name: "get_transaction_detail",
    description: "Full detail of ONE transaction by transaction_id (accounts, direction, category, notes, status).",
    parameters: obj({ transaction_id: { type: "string" } }, ["transaction_id"]),
  },
  {
    name: "get_spending_summary",
    description: "Complete expense report for a date range (inclusive): total, transaction_count, by_category, by_account, top_merchants, largest_expenses, previous_period comparison, plus any history_only imports or pending_review messages. Defaults to this month if dates are omitted.",
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
  {
    name: "get_monthly_trend",
    description: "Month-by-month income, spending and net cashflow over the last N months (default 6). Use for multi-month trends or comparing several months.",
    parameters: obj({
      months: { type: "integer", minimum: 2, maximum: 12 },
    }),
  },
  {
    name: "get_review_items",
    description: "Bank messages waiting for the owner's review, with formatted amounts, dates and merchant text. Optional from/to date filter.",
    parameters: obj({ from: DATE, to: DATE }),
  },
  { name: "get_upcoming_bills", description: "Saved recurring bills, expected income and credit card due dates for this month. Only covers saved recurring items; to check whether a specific bill (like electricity or water) was paid, also call search_transactions.", parameters: obj({}) },
  { name: "get_budgets", description: "This month's budget per category: limit, spent, remaining, percent used, projected month end, status.", parameters: obj({}) },
  { name: "get_cash_forecast", description: "The Plan screen's projection of spendable cash to the end of next month: spendable now, month-end (base and cautious), lowest point, buffer, how much could be set aside. Use it for 'how much can I save', 'will I run out'.", parameters: obj({}) },
  { name: "get_savings_goals", description: "Savings goals with saved, target, percent, target date and the monthly amount still needed.", parameters: obj({}) },
  { name: "get_balance_checks", description: "Ledger integrity status and latest bank-reported balance vs ledger balance comparison per account.", parameters: obj({}) },
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

const PROPOSE_EDIT_TRANSACTION: ToolDefinition = {
  name: "propose_edit_transaction",
  description: "Draft editing an existing expense or income by transaction_id (from search_transactions). Only pass fields that change. Owner must press Confirm.",
  parameters: obj({
    transaction_id: { type: "string" },
    account_id: { type: "string" },
    amount: AMOUNT,
    date: DATE,
    category_id: { type: "string" },
    merchant: { type: "string" },
    notes: { type: "string" },
  }, ["transaction_id"]),
};

const PROPOSE_RESTORE_TRANSACTION: ToolDefinition = {
  name: "propose_restore_transaction",
  description: "Draft restoring ONE deleted transaction from Trash (find its transaction_id with search_transactions status='deleted') for the owner to confirm.",
  parameters: obj({ transaction_id: { type: "string" } }, ["transaction_id"]),
};

const PROPOSE_SET_BUDGET: ToolDefinition = {
  name: "propose_set_budget",
  description: "Draft setting or removing a monthly budget limit for an expense category, for the owner to confirm.",
  parameters: obj({
    category_id: { type: "string", description: "Expense category id or name" },
    amount: AMOUNT,
    currency: { type: "string" },
    remove: { type: "boolean", description: "Set true to remove this category's budget." },
  }, ["category_id"]),
};

const PROPOSE_CREATE_BILL: ToolDefinition = {
  name: "propose_create_bill",
  description: "Draft adding a recurring monthly bill or expected income to the Bills screen, for the owner to confirm.",
  parameters: obj({
    name: { type: "string" },
    direction: { type: "string", enum: ["bill", "income"] },
    amount: AMOUNT,
    due_day: { type: "integer", minimum: 1, maximum: 31 },
    account_id: { type: "string" },
    category_id: { type: "string" },
    currency: { type: "string" },
  }, ["name", "direction", "amount", "due_day"]),
};

const PROPOSE_CREATE_GOAL: ToolDefinition = {
  name: "propose_create_goal",
  description: "Draft creating a savings goal on the Plan screen, for the owner to confirm.",
  parameters: obj({
    name: { type: "string" },
    target_amount: AMOUNT,
    target_date: DATE,
    account_id: { type: "string" },
    saved_amount: AMOUNT,
    currency: { type: "string" },
  }, ["name", "target_amount"]),
};

const PROPOSE_CREATE_CATEGORY: ToolDefinition = {
  name: "propose_create_category",
  description: "Draft creating a new expense or income category, for the owner to confirm.",
  parameters: obj({
    name: { type: "string" },
    kind: { type: "string", enum: ["expense", "income"] },
  }, ["name", "kind"]),
};

const PROPOSE_DELETE: ToolDefinition = {
  name: "propose_delete_transaction",
  description: "Draft moving ONE transaction to Trash, by exact id from search_transactions, for the owner to confirm.",
  parameters: obj({ transaction_id: { type: "string" } }, ["transaction_id"]),
};

export function toolDefinitions(permissions: AgentPermissions): ToolDefinition[] {
  const tools = [...READ_TOOLS];
  if (permissions.mode === "assist") {
    tools.push(
      PROPOSE_TRANSACTION,
      PROPOSE_TRANSFER,
      PROPOSE_EDIT_TRANSACTION,
      PROPOSE_RESTORE_TRANSACTION,
      PROPOSE_SET_BUDGET,
      PROPOSE_CREATE_BILL,
      PROPOSE_CREATE_GOAL,
      PROPOSE_CREATE_CATEGORY,
    );
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
  const optBool = (args: Record<string, unknown>, key: string): boolean | undefined => {
    const value = args[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lower = value.trim().toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
    return undefined;
  };
  const reporter = createExpenseReporter({ db, service });

  const PROPOSE_ACTION_MAP: Readonly<Record<string, ActionType>> = {
    propose_transaction: ActionType.CREATE_TRANSACTION,
    propose_transfer: ActionType.CREATE_TRANSFER,
    propose_delete_transaction: ActionType.DELETE_TRANSACTION,
    propose_edit_transaction: ActionType.EDIT_TRANSACTION,
    propose_restore_transaction: ActionType.RESTORE_TRANSACTION,
    propose_set_budget: ActionType.SET_BUDGET,
    propose_create_bill: ActionType.CREATE_BILL,
    propose_create_goal: ActionType.CREATE_GOAL,
    propose_create_category: ActionType.CREATE_CATEGORY,
  };

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
            available_to_spend: formatCurrencyMap(totals.liquid),
            total_owed_on_cards: formatCurrencyMap(owed),
          },
        };
      }

      case "list_categories":
        return { result: service.listCategories().map((c) => ({ category_id: c.id, name: c.name, kind: c.kind })) };

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
        const rawStatus = optText(args, "status");
        if (rawStatus !== undefined && rawStatus !== "posted" && rawStatus !== "deleted") {
          throw validationError("'status' must be 'posted' or 'deleted'");
        }
        const status = rawStatus === "deleted" ? TransactionStatus.DELETED : TransactionStatus.POSTED;
        const includeHistoryOnly = optBool(args, "include_history_only") ?? false;
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
          status,
          includeHistoryOnly,
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
          totalsByKind[rowKind] = formatCurrencyMap(curMap);
        }

        let historyExcluded = 0;
        if (!includeHistoryOnly && status === TransactionStatus.POSTED) {
          const withHistory = service.searchTransactions({ ...filters, includeHistoryOnly: true, limit: 200 });
          historyExcluded = Math.max(0, withHistory.length - Math.min(allRows.length, 200));
        }

        return {
          result: {
            total_matches: allRows.length,
            returned: shown.length,
            truncated: allRows.length > shown.length,
            totals_by_kind: totalsByKind,
            ...(historyExcluded > 0
              ? {
                  history_only_excluded: historyExcluded,
                  note: `${historyExcluded} imported historical transaction(s) matched; call with include_history_only: true to inspect them.`,
                }
              : {}),
            transactions: shown.map((t) => ({
              transaction_id: t.id,
              kind: t.kind,
              date: t.occurredLocalDate,
              amount: formatMoney(t.amount),
              account: accountNames.get(t.id) ?? null,
              merchant: clip(t.merchantName),
              category: t.categoryId ? (names.get(t.categoryId) ?? t.categoryId) : null,
              ...(t.accountingScope !== "ledger" ? { accounting_scope: t.accountingScope } : {}),
              ...(t.notes ? { notes: clip(t.notes) } : {}),
            })),
          },
        };
      }

      case "get_transaction_detail": {
        const id = optText(args, "transaction_id");
        if (!id) throw validationError("'transaction_id' is required");
        const detail = service.getTransactionDetail(id);
        const rev = detail.currentRevision;
        const names = new Map(service.listCategories(true).map((c) => [c.id, c.name]));
        return {
          result: {
            transaction_id: detail.transaction.id,
            kind: detail.transaction.kind,
            status: detail.transaction.status,
            accounting_scope: detail.transaction.accountingScope,
            date: localDateOf(rev.occurredAt.instant, rev.occurredAt.zone),
            amount: formatMoney(rev.displayAmount),
            accounts: detail.accounts.map((a) => ({ account_id: a.id, name: a.name, direction: a.direction })),
            category: rev.categoryId ? (names.get(rev.categoryId) ?? rev.categoryId) : null,
            merchant: clip(rev.merchantName),
            notes: clip(rev.notes, 200),
            revision_count: detail.revisionCount,
          },
        };
      }

      case "get_spending_summary": {
        const from = optDate(args, "from") ?? monthStart(today());
        const to = optDate(args, "to") ?? today();
        if (from > to) throw validationError("'from' must not be after 'to'");
        return { result: reporter.expenseReport(from, to) };
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
        const historyOnly = reporter.historyOnlyExpenses(from, to);
        const pendingReview = reporter.pendingReviewItems(from, to);
        return {
          result: {
            from,
            to,
            by_currency: byCurrency,
            ...(historyOnly.count > 0 ? { history_only: historyOnly } : {}),
            ...(pendingReview.count > 0 ? { pending_review: pendingReview } : {}),
            note: "Transfers and card payments are excluded from income and spending.",
          },
        };
      }

      case "get_monthly_trend": {
        const months = optInt(args, "months", 6, 2, 12);
        const dashboard = createDashboardService({ db });
        const currencyCodes = new Set([
          ...service.listAccounts().filter((a) => a.isUserVisible).map((a) => a.currency.code),
          ...dashboard.activeCurrencies(),
        ]);
        const day = today();
        return {
          result: {
            as_of: day,
            by_currency: [...currencyCodes].map((code) => {
              const currency = requireCurrency(code);
              return {
                currency: code,
                months: dashboard.monthlyFlow(currency, day, months).map((row) => ({
                  month: row.month,
                  income: formatMoney(row.income),
                  spending: formatMoney(row.spending),
                  net: formatMoney(money(currency, row.income.minor - row.spending.minor)),
                })),
              };
            }),
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

      case "get_balance_checks": {
        const checker = createBalanceCheckService({ db, service });
        const books = checker.books();
        const checks = checker.accounts();
        return {
          result: {
            books_ok: books.ok,
            journals: books.journals,
            entries: books.entries,
            account_checks: checks.map((c) => ({
              account: c.account.name,
              observed_date: localDateOf(c.observedAt, service.zone),
              compares: c.compares,
              bank_reported: formatMoney(c.reported),
              ledger: formatMoney(c.ledger),
              difference: formatMoney(c.difference),
            })),
            note:
              checks.length === 0
                ? "Books checked; no bank-reported balance observations exist yet to compare against."
                : "Compares the latest bank-reported balance observation against the ledger at that moment.",
          },
        };
      }

      case "get_review_items": {
        const pending = reporter.pendingReviewItems(optDate(args, "from"), optDate(args, "to"));
        return {
          result: {
            waiting: pending.count,
            totals_by_kind: pending.totals_by_kind,
            items: pending.items,
            note: "The owner reviews these on the Review screen. You cannot accept them.",
          },
        };
      }

      case "propose_transaction":
      case "propose_transfer":
      case "propose_delete_transaction":
      case "propose_edit_transaction":
      case "propose_restore_transaction":
      case "propose_set_budget":
      case "propose_create_bill":
      case "propose_create_goal":
      case "propose_create_category": {
        const actionType = PROPOSE_ACTION_MAP[name]!;
        const normalized: Record<string, unknown> = { ...args };
        const removeFlag = optBool(normalized, "remove");
        if (removeFlag !== undefined) normalized.remove = removeFlag;

        const requiresExactAmount =
          name === "propose_transaction" ||
          name === "propose_transfer" ||
          (name === "propose_edit_transaction" && normalized.amount !== undefined) ||
          (name === "propose_set_budget" && normalized.remove !== true) ||
          name === "propose_create_bill" ||
          name === "propose_create_goal";

        if (deps.vagueAmount && requiresExactAmount) {
          // Enforced here, not just requested in the prompt: small models draft from "around 400".
          return { result: { error: "The owner gave an estimate, not an exact amount. Do not propose. Ask them for the exact amount." } };
        }

        if (normalized.amount !== undefined) normalized.amount = coerceAmount(normalized.amount);
        if (normalized.target_amount !== undefined) normalized.target_amount = coerceAmount(normalized.target_amount);
        if (normalized.saved_amount !== undefined) normalized.saved_amount = coerceAmount(normalized.saved_amount);
        if (typeof normalized.account_id === "string") normalized.account_id = resolveAccountId(normalized.account_id);
        if (typeof normalized.from_account_id === "string") normalized.from_account_id = resolveAccountId(normalized.from_account_id);
        if (typeof normalized.to_account_id === "string") normalized.to_account_id = resolveAccountId(normalized.to_account_id);
        if (typeof normalized.category_id === "string") normalized.category_id = resolveCategoryId(normalized.category_id);

        if (name === "propose_transaction" && (!normalized.category_id || normalized.category_id === "uncategorized")) {
          const kind = normalized.kind === "income" || normalized.kind === "refund" ? normalized.kind : "expense";
          const hint = [normalized.merchant, normalized.notes].filter((v): v is string => typeof v === "string").join(" ");
          if (hint) normalized.category_id = guessCategoryFor(db, hint, kind);
        } else if (name === "propose_create_bill" && !normalized.category_id && typeof normalized.name === "string") {
          const kind = normalized.direction === "income" || normalized.direction === "in" ? "income" : "expense";
          const guessed = guessCategoryFor(db, normalized.name, kind);
          if (guessed !== "uncategorized") normalized.category_id = guessed;
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
