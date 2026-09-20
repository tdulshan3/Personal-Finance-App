import type { Db } from "../core/data/driver.ts";
import { asNumber } from "../core/data/driver.ts";
import { FinanceError } from "../core/domain/errors.ts";
import type { LedgerAccount } from "../core/domain/ledger.ts";
import { formatMoney, money } from "../core/domain/money.ts";
import type { Money } from "../core/domain/money.ts";
import { addDays, localDateOf } from "../core/domain/time.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import type { ModelIdentity, ProposalService } from "./proposals.ts";
import { ActionType } from "./proposals.ts";
import type { AgentPermissions } from "./tools.ts";

/**
 * Rules before the model — the same division of labour as message extraction (§7.1).
 *
 * The handful of things people actually ask a finance app ("what's my balance", "how much did I
 * spend this month", "I spent 1250 on lunch") do not need a language model: the answer is a ledger
 * query, and the phrasing is regular. Answering them here is instant, exact, and works when the
 * model host is asleep. Anything that does not match a whole-message pattern falls through to the
 * model untouched — these patterns are anchored at both ends precisely so they never hijack a
 * question they only half understand.
 *
 * A rule-drafted change is still only a proposal. The Confirm button is the same one.
 */

export const RULES_IDENTITY: ModelIdentity = Object.freeze({ endpoint: "local", model: "assistant-rules-v1", digest: null });

export type IntentReply = { readonly text: string; readonly proposalIds: readonly string[] };

const CATEGORY_KEYWORDS: readonly [RegExp, string][] = [
  [/\b(lunch|dinner|breakfast|brunch|coffee|tea|cafe|café|restaurant|pizza|burger|kottu|rice|snack|meal|food|bakery|takeaway|uber ?eats|pickme ?food)\b/i, "dining"],
  [/\b(grocer(y|ies)|supermarket|keells|cargills|arpico|glomark|vegetables|fruits?|market)\b/i, "groceries"],
  [/\b(fuel|petrol|diesel|bus|train|taxi|uber|pickme|tuk|three.?wheeler|parking|toll|fare)\b/i, "transport"],
  [/\b(rent|mortgage|lease)\b/i, "housing"],
  [/\b(electric(ity)?|water|internet|wifi|broadband|mobile|phone bill|reload|dialog|mobitel|slt|ceb|leco|gas)\b/i, "utilities"],
  [/\b(doctor|pharmacy|medicine|hospital|clinic|dentist|channeling|lab test)\b/i, "healthcare"],
  [/\b(tuition|course|class|school|university|books?|exam)\b/i, "education"],
  [/\b(movie|cinema|netflix|spotify|game|concert|youtube)\b/i, "entertainment"],
  [/\b(clothes|shoes|shirt|dress|daraz|amazon|gift|electronics)\b/i, "shopping"],
  [/\b(fee|charge|commission|penalty|interest)\b/i, "fees"],
];

const AMOUNT = String.raw`(?:lkr|rs\.?|රු\.?|ரூ\.?)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:lkr|rupees|/-|/=)?`;
const WHEN = String.raw`(?:\s+(today|yesterday|on \d{4}-\d{2}-\d{2}))?`;

const SPENT = new RegExp(String.raw`^i(?:'ve| have)? (?:just )?(?:spent|paid|payed)\s+${AMOUNT}\s+(?:on|for|at|to)\s+(.+?)${WHEN}(?:\s+(?:(?:from|with|using|via)\s+(?:my\s+)?|on\s+my\s+)(.+?))?${WHEN}$`, "i");
const RECEIVED = new RegExp(String.raw`^i(?:'ve| have)? (?:just )?(?:got|received|earned|was paid)\s+${AMOUNT}\s+(?:from|as|for)\s+(.+?)${WHEN}(?:\s+(?:in|into|to)\s+(?:my\s+)?(.+?))?${WHEN}$`, "i");

/** "about 400", "~400", "400 I think": an estimate, which §14.2 says to ask about rather than record. */
export const hasVagueAmount = (text: string): boolean =>
  /\b(about|around|roughly|approx(?:imately)?|maybe|nearly|almost|or so|ish|i think|i guess|not sure|something like|give or take)\b|~\s*\d|\d\s*ish\b/i.test(text);

/** The owner's own history first, then keywords. Shared by the rules path and the model's drafts. */
export function guessCategoryFor(db: Db, what: string, kind: "expense" | "income" | "refund"): string {
  if (kind === "income") return "income";
  const prior = db.prepare(
    `SELECT category_id FROM transaction_revisions WHERE lower(merchant_name) = lower(?) AND category_id IS NOT NULL
      ORDER BY recorded_at DESC LIMIT 1`,
  ).get(what) as Record<string, unknown> | undefined;
  if (prior && typeof prior.category_id === "string" && prior.category_id !== "uncategorized") return prior.category_id;
  return CATEGORY_KEYWORDS.find(([pattern]) => pattern.test(what))?.[1] ?? "uncategorized";
}

const clean = (text: string) => text.trim().replace(/[?.!\s]+$/g, "").replace(/\s+/g, " ");

export function createIntentRouter(deps: {
  db: Db;
  service: FinanceService;
  proposals: ProposalService;
  sessionId: string;
  permissions: AgentPermissions;
}) {
  const { db, service, proposals, permissions } = deps;
  const today = () => localDateOf(service.clock.now(), service.zone);

  function whenToDate(...candidates: (string | undefined)[]): string {
    const word = candidates.find((c) => c !== undefined)?.toLowerCase();
    if (!word || word === "today") return today();
    if (word === "yesterday") return addDays(today(), -1);
    return word.replace(/^on /, "");
  }

  /** Exact name, else a unique partial match. Two candidates is a question, not a guess. */
  function resolveAccount(named: string | undefined): { account?: LedgerAccount; question?: string } {
    const accounts = service.listAccounts().filter((a) => a.isUserVisible && a.archivedAt === undefined);
    if (accounts.length === 0) return { question: "You have no accounts yet. Add one on the Accounts screen first." };
    const list = accounts.map((a) => a.name).join(", ");
    if (!named) {
      return accounts.length === 1 ? { account: accounts[0]! } : { question: `Which account was that from? You have: ${list}.` };
    }
    // Only a fragment *of the account's own name* may match. The reverse ("Nowhere Bank" contains
    // "Bank") would quietly pick an account the owner never named.
    const strip = (value: string) => value.toLowerCase().replace(/\b(my|the|account|acct|card)\b/g, " ").replace(/\s+/g, " ").trim();
    const wanted = strip(named);
    if (wanted.length < 3) return { question: `Which account do you mean? You have: ${list}.` };
    const exact = accounts.filter((a) => a.name.toLowerCase() === named.toLowerCase() || strip(a.name) === wanted);
    const partial = exact.length > 0 ? exact : accounts.filter((a) => a.name.toLowerCase().includes(wanted));
    if (partial.length === 1) return { account: partial[0]! };
    return { question: partial.length === 0 ? `I don't see an account called "${named}". You have: ${list}.` : `"${named}" matches more than one account: ${partial.map((a) => a.name).join(", ")}. Which one?` };
  }

  const guessCategory = (what: string, kind: "expense" | "income") => guessCategoryFor(db, what, kind);

  function draft(kind: "expense" | "income", match: RegExpMatchArray): IntentReply {
    if (permissions.mode !== "assist") {
      return { text: "I'm in read-only mode, so I can't draft that. Switch Permissions to Assist, or use Add.", proposalIds: [] };
    }
    const [, amount, what, whenA, accountName, whenB] = match;
    const resolved = resolveAccount(accountName?.trim());
    if (!resolved.account) return { text: resolved.question!, proposalIds: [] };
    const label = what!.trim().replace(/^(a|an|the|my)\s+/i, "");
    try {
      const proposal = proposals.createProposal({
        actionType: ActionType.CREATE_TRANSACTION,
        sessionId: deps.sessionId,
        model: RULES_IDENTITY,
        args: {
          kind, account_id: resolved.account.id, amount: amount!,
          date: whenToDate(whenA, whenB), category_id: guessCategory(label, kind),
          merchant: label.charAt(0).toUpperCase() + label.slice(1),
        },
      });
      return { text: "Here it is, ready for you to check. Nothing is recorded until you confirm.", proposalIds: [proposal.id] };
    } catch (error) {
      return { text: error instanceof FinanceError ? `I couldn't draft that: ${error.message}` : "I couldn't draft that.", proposalIds: [] };
    }
  }

  function balances(): IntentReply {
    const rows = service.accountBalances().filter((r) => r.account.isUserVisible);
    if (rows.length === 0) return { text: "You have no accounts yet. Add one on the Accounts screen.", proposalIds: [] };
    const lines = rows.map(({ account, balance, available }) =>
      account.kind === "liability"
        ? `${account.name}: ${balance.minor < 0n ? `in credit ${formatMoney(money(balance.currency, -balance.minor))}` : `owes ${formatMoney(balance)}`}${available ? ` (${formatMoney(available)} available)` : ""}`
        : `${account.name}: ${formatMoney(balance)}`);
    const totals = service.homeTotals();
    const sum = (map: Map<string, Money>) => [...map.values()].map((m) => formatMoney(m)).join(" + ");
    const footer = [totals.liquid.size > 0 ? `Available to spend: ${sum(totals.liquid)}` : "", totals.owed.size > 0 ? `Owed on cards: ${sum(totals.owed)}` : ""].filter(Boolean);
    return { text: [...lines, "", ...footer].join("\n").trim(), proposalIds: [] };
  }

  function spending(from: string, to: string, label: string): IntentReply {
    const rows = service.spendingByCategory(from, to);
    if (rows.length === 0) return { text: `No spending recorded ${label} (${from} to ${to}).`, proposalIds: [] };
    const names = new Map(service.listCategories(true).map((c) => [c.id, c.name]));
    const totals = new Map<string, Money>();
    for (const row of rows) {
      const running = totals.get(row.amount.currency.code);
      totals.set(row.amount.currency.code, money(row.amount.currency, (running?.minor ?? 0n) + row.amount.minor));
    }
    const total = [...totals.values()].map((m) => formatMoney(m)).join(" + ");
    return {
      text: [`You spent **${total}** ${label} (${from} to ${to}).`, "",
             ...rows.slice(0, 10).map((r) => `${names.get(r.categoryId) ?? r.categoryId}: ${formatMoney(r.amount)}`),
             "", "Transfers and card payments aren't counted as spending."].join("\n"),
      proposalIds: [],
    };
  }

  function period(which: string, unit: string): { from: string; to: string; label: string } {
    const now = today();
    if (unit === "today") return { from: now, to: now, label: "today" };
    if (unit === "yesterday") return { from: addDays(now, -1), to: addDays(now, -1), label: "yesterday" };
    if (unit === "week") {
      const weekday = (new Date(`${now}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      const start = addDays(now, -weekday);
      return which === "last" ? { from: addDays(start, -7), to: addDays(start, -1), label: "last week" } : { from: start, to: now, label: "this week" };
    }
    if (unit === "year") {
      const year = Number(now.slice(0, 4));
      return which === "last" ? { from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, label: "last year" } : { from: `${year}-01-01`, to: now, label: "this year" };
    }
    const start = `${now.slice(0, 8)}01`;
    if (which !== "last") return { from: start, to: now, label: "this month" };
    const end = addDays(start, -1);
    return { from: `${end.slice(0, 8)}01`, to: end, label: "last month" };
  }

  function recent(count: number): IntentReply {
    const rows = service.searchTransactions({ limit: Math.min(Math.max(count, 1), 20) });
    if (rows.length === 0) return { text: "No transactions recorded yet.", proposalIds: [] };
    return {
      text: rows.map((t) => `${t.occurredLocalDate} · ${t.merchantName ?? t.kind} · ${formatMoney(t.amount)}`).join("\n"),
      proposalIds: [],
    };
  }

  function tryAnswer(raw: string): IntentReply | null {
    const text = clean(raw);
    if (text.length === 0 || text.length > 160) return null;

    if (/^(what(?:'s| is| are)? )?(my )?(current )?(account )?balances?( now| today)?$/i.test(text)
      || /^(show|list)( me)?( my)? (accounts|balances)$/i.test(text)
      || /^how much (money )?do i have( left| now)?$/i.test(text)) return balances();

    const spent = text.match(/^(?:how much|what) (?:did|have) i spen[dt](?: so far)?(?: (this|last))? ?(month|week|year|today|yesterday)(?: and on what| by category)?$/i)
      ?? text.match(/^(?:show (?:me )?)?(?:my )?spending(?: for| in)?(?: (this|last))? ?(month|week|year|today|yesterday)$/i);
    if (spent) {
      const p = period((spent[1] ?? "this").toLowerCase(), spent[2]!.toLowerCase());
      return spending(p.from, p.to, p.label);
    }

    const list = text.match(/^(?:show|list)(?: me)?(?: my)? (?:last|recent|latest)(?: (\d{1,2}))? transactions$/i);
    if (list) return recent(list[1] ? Number(list[1]) : 5);

    if (/^(is there )?(anything|something|what(?:'s| is)) (waiting )?(for|to) (my )?review$/i.test(text) || /^how many (messages|items) (are )?(waiting|to review)$/i.test(text)) {
      const n = asNumber((db.prepare("SELECT COUNT(*) AS n FROM source_events WHERE status = 'needs_review'").get() as Record<string, unknown>).n, "n");
      return { text: n === 0 ? "Nothing is waiting for review." : `${n} message${n === 1 ? " is" : "s are"} waiting on the Review screen.`, proposalIds: [] };
    }

    const expense = text.match(SPENT);
    if (expense) return draft("expense", expense);
    const income = text.match(RECEIVED);
    if (income) return draft("income", income);

    return null;
  }

  return { tryAnswer };
}
