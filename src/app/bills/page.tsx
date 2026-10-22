import { redirect } from "next/navigation";

import { AccountType } from "../../core/domain/ledger.ts";
import { money, requireCurrency } from "../../core/domain/money.ts";
import { localDateOf, parseLocalDate } from "../../core/domain/time.ts";
import { createCardDueService } from "../../core/services/card-dues.ts";
import { createRecurringService } from "../../core/services/recurring-service.ts";
import { currentVault, requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { iconForCategory } from "../../ui/labels.ts";
import type { BillsData } from "./bills-view.tsx";
import { BillsView } from "./bills-view.tsx";

export const dynamic = "force-dynamic";

/**
 * Bills: what is owed on each card and when, and the bills and income the owner expects every
 * month.
 *
 * A card's spending this month is billed and paid next month, so each card shows one payment
 * falling due next month for its current balance — a figure from the ledger that grows as spending
 * is recorded. Paying it is an ordinary transfer into the card, which the ledger never counts as
 * spending (buildspec.md §9.2).
 *
 * Recurring items are owner-approved (buildspec.md §11): detection only suggests, from merchants
 * and payers that appear about once a month for about the same amount. Whether this month's is
 * paid is read back from the ledger, never ticked by hand.
 */
export default async function BillsPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const db = requireDb();
  const service = requireService();
  const today = localDateOf(Date.now(), service.zone);
  const currency = requireCurrency(currentVault()?.currency ?? "LKR");
  const recurring = createRecurringService({ db, service });
  const dues = createCardDueService({ db, service }).list(today);
  const balances = new Map(service.accountBalances().map((row) => [row.account.id, row]));
  const accounts = service.listAccounts().filter((a) => a.isUserVisible);
  const accountName = new Map(service.listAccounts({ includeArchived: true }).map((a) => [a.id, a.name]));
  const categories = service.listCategories(true);
  const categoryOf = new Map(categories.map((c) => [c.id, c]));

  const cards = dues.map((due) => {
    const row = balances.get(due.account.id);
    return {
      id: due.account.id,
      name: due.account.name,
      isLoan: due.account.type === AccountType.LOAN,
      owed: due.owed,
      dueDay: due.dueDay,
      dueOn: due.dueOn,
      daysLeft: due.daysLeft,
      available: row?.available ?? null,
      limit: due.account.creditLimit ?? null,
    };
  });

  const items = recurring.list(today).map((row) => ({
    id: row.id,
    name: row.name,
    direction: row.direction,
    amount: row.amount,
    dueDay: row.dueDay,
    accountId: row.accountId,
    accountName: row.accountId ? (accountName.get(row.accountId) ?? null) : null,
    categoryId: row.categoryId,
    categoryName: row.categoryId ? (categoryOf.get(row.categoryId)?.name ?? null) : null,
    categoryIcon: row.categoryId ? iconForCategory(categoryOf.get(row.categoryId)?.iconKey, categoryOf.get(row.categoryId)?.kind) : null,
    matchText: row.matchText,
    state: row.state,
    dueThisMonth: row.dueThisMonth,
    nextDue: row.nextDue,
    daysUntil: row.daysUntil,
    lastPaid: row.lastPaid,
  }));

  // This month at a glance, in the ledger's own currency (currencies are never added together).
  const mine = items.filter((item) => item.amount.currency.code === currency.code);
  const sum = (list: typeof mine, pick: (item: (typeof mine)[number]) => bigint) => money(currency, list.reduce((total, item) => total + pick(item), 0n));
  const { year, month } = parseLocalDate(today);
  const thisMonth = `${year}-${String(month).padStart(2, "0")}`;
  const paidThisMonth = (item: (typeof mine)[number]) => item.state === "paid" && item.lastPaid !== null && item.lastPaid.date.startsWith(thisMonth);

  const data: BillsData = {
    today,
    currency: currency.code,
    cards: cards.filter((card) => !card.isLoan),
    loans: cards.filter((card) => card.isLoan),
    items,
    suggestions: recurring.detect(currency, today).map((s) => ({
      key: s.key,
      name: s.name,
      direction: s.direction,
      amount: s.amount,
      dueDay: s.dueDay,
      accountName: s.accountId ? (accountName.get(s.accountId) ?? null) : null,
      categoryName: s.categoryId ? (categoryOf.get(s.categoryId)?.name ?? null) : null,
      months: s.months,
      lastDate: s.lastDate,
    })),
    totals: {
      toPay: sum(mine.filter((i) => i.direction === "out" && i.state !== "paid"), (i) => i.amount.minor),
      toPayCount: mine.filter((i) => i.direction === "out" && i.state !== "paid").length,
      overdue: mine.filter((i) => i.state === "overdue").length,
      paid: sum(mine.filter((i) => i.direction === "out" && paidThisMonth(i)), (i) => i.lastPaid!.amount.minor),
      paidCount: mine.filter((i) => i.direction === "out" && paidThisMonth(i)).length,
      expected: sum(mine.filter((i) => i.direction === "in" && i.state !== "paid"), (i) => i.amount.minor),
      received: sum(mine.filter((i) => i.direction === "in" && paidThisMonth(i)), (i) => i.lastPaid!.amount.minor),
      cards: money(currency, cards.filter((c) => !c.isLoan && c.owed.currency.code === currency.code && c.owed.minor > 0n).reduce((total, c) => total + c.owed.minor, 0n)),
    },
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency.code, kind: a.kind })),
    categories: service.listCategories().map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
  };

  return <BillsView data={data} />;
}
