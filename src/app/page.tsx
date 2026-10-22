import { redirect } from "next/navigation";

import type { Money } from "../core/domain/money.ts";
import { money, requireCurrency } from "../core/domain/money.ts";
import { daysBetween, localDateOf } from "../core/domain/time.ts";
import { createBalanceCheckService } from "../core/services/balance-check.ts";
import { createBudgetService } from "../core/services/budget-service.ts";
import { createCardDueService } from "../core/services/card-dues.ts";
import { createDashboardService, resolvePeriod } from "../core/services/dashboard-service.ts";
import { createForecastService } from "../core/services/forecast-service.ts";
import { createRecurringService } from "../core/services/recurring-service.ts";
import { backgroundStatus, currentProcessor } from "../server/background.ts";
import { currentVault, requireDb, requireService, unlockedSince } from "../server/runtime.ts";
import { accessState } from "../server/session.ts";
import { delta as deltaText, money as moneyText, relativeDays, shortDate } from "../ui/format.ts";
import { iconForCategory, labelForKind } from "../ui/labels.ts";
import type { Attention, HomeData } from "./home-view.tsx";
import { HomeView } from "./home-view.tsx";

export const dynamic = "force-dynamic";

/**
 * Home: the dashboard.
 *
 * buildspec.md §13 requires "liquid balance, amount owed, current-period spending, upcoming bills,
 * suggested savings, source health, unresolved review count, recent transactions". Every figure is
 * summed from journal entries by `dashboard-service`, so a transfer or a card payment is never
 * spending and a refund never income. The period lives in the URL (`?period=`), so it survives a
 * reload and a live refresh redraws everything with fresh data.
 *
 * "Needs attention" is the ledger read back to the owner: messages waiting, budgets passed,
 * bills due or late, a projection that dips under the buffer, a balance the bank disagrees with.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const db = requireDb();
  const service = requireService();
  const today = localDateOf(Date.now(), service.zone);
  const params = await searchParams;
  const period = resolvePeriod(typeof params.period === "string" ? params.period : undefined, today);
  const dash = createDashboardService({ db });
  const currency = requireCurrency(currentVault()?.currency ?? "LKR");
  const lkr = (minor: bigint) => money(currency, minor);

  const now = dash.totals(currency, period.from, period.to);
  const before = dash.totals(currency, period.previous.from, period.previous.to);
  const categories = service.listCategories(true);
  const categoryOf = new Map(categories.map((c) => [c.id, c]));
  const spendingByCategory = dash.byCategory(currency, period.from, period.to, "expense");
  const top = spendingByCategory.slice(0, 6);
  const restMinor = spendingByCategory.slice(6).reduce((sum, row) => sum + row.amount.minor, 0n);
  const share = (minor: bigint) => (now.spending.minor > 0n ? Number(minor) / Number(now.spending.minor) : 0);

  const cumulative = (days: { amount: Money }[]) => {
    let running = 0n;
    return days.map((day) => (running += day.amount.minor));
  };
  const trendNow = cumulative(dash.dailySpending(currency, period.from, period.to));
  const trendBefore = cumulative(dash.dailySpending(currency, period.previous.from, period.previous.to));
  const dayCount = Math.max(trendNow.length, 1);

  /*
   * Total balance, per currency: every account the owner holds, less what is on their cards. The
   * unused part of a credit limit is shown beside it but never added in (buildspec.md §10).
   */
  const accounts = service.accountBalances().filter((row) => row.account.isUserVisible);
  const byCurrency = new Map<string, { assets: bigint; owed: bigint; available: bigint; hasCards: boolean; hasLimit: boolean }>();
  for (const { account, balance, available } of accounts) {
    const slot = byCurrency.get(account.currency.code) ?? { assets: 0n, owed: 0n, available: 0n, hasCards: false, hasLimit: false };
    if (account.kind === "liability") {
      slot.owed += balance.minor;
      slot.hasCards = true;
      if (available) {
        slot.available += available.minor;
        slot.hasLimit = true;
      }
    } else if (account.kind === "asset") slot.assets += balance.minor;
    byCurrency.set(account.currency.code, slot);
  }
  const worth = [...byCurrency.entries()].map(([code, slot]) => {
    const unit = requireCurrency(code);
    return {
      code,
      total: money(unit, slot.assets - slot.owed),
      assets: money(unit, slot.assets),
      owed: money(unit, slot.owed),
      available: slot.hasLimit ? money(unit, slot.available) : null,
      hasCards: slot.hasCards,
    };
  });

  const inbox = currentProcessor()?.counts() ?? { staged: 0, waitingForModel: 0, openReviews: 0 };
  const capture = backgroundStatus();
  const recurring = createRecurringService({ db, service }).list(today);
  const dues = createCardDueService({ db, service }).list(today).filter((due) => due.owed.minor > 0n && due.account.type !== "loan");
  const budgets = createBudgetService({ db, service }).list(currency, today);
  const forecast = createForecastService({ db, service }).project(currency, today);
  const checks = createBalanceCheckService({ db, service }).accounts();

  // Bills and payments in the next fortnight, card payments and saved bills together, soonest first.
  const upcoming = [
    ...dues
      .filter((due) => due.dueOn !== null && due.daysLeft !== null && due.daysLeft <= 14)
      .map((due) => ({ key: due.account.id, name: `${due.account.name} payment`, date: due.dueOn!, amount: due.owed, days: due.daysLeft!, direction: "out" as const })),
    ...recurring
      .filter((row) => row.state !== "paid" && row.daysUntil <= 14)
      .map((row) => ({ key: row.id, name: row.name, date: row.nextDue, amount: row.amount, days: row.daysUntil, direction: row.direction })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const attention: Attention[] = [];
  if (inbox.openReviews > 0) {
    attention.push({ key: "review", icon: "tray", tone: "neutral", title: `${inbox.openReviews} message${inbox.openReviews === 1 ? "" : "s"} to review`, detail: "Read from your bank messages. Nothing is recorded until you accept it.", href: "/review" });
  }
  for (const row of budgets.filter((b) => b.status === "over")) {
    attention.push({ key: `over-${row.categoryId}`, icon: "exclamationmark-triangle", tone: "bad", title: `${row.categoryName} is over budget`, detail: `${moneyText(row.spent)} spent of ${moneyText(row.limit)} this month.`, href: "/plan" });
  }
  for (const row of budgets.filter((b) => b.status === "near")) {
    attention.push({ key: `near-${row.categoryId}`, icon: "chart-bar", tone: "warning", title: `${row.categoryName} is close to its budget`, detail: `${Math.round(row.ratio * 100)}% used; at this pace the month ends near ${moneyText(row.projected)}.`, href: "/plan" });
  }
  for (const row of recurring.filter((r) => r.state === "overdue")) {
    attention.push({ key: `late-${row.id}`, icon: "clock", tone: "warning", title: `${row.name} was ${row.direction === "in" ? "expected" : "due"} ${relativeDays(row.daysUntil)}`, detail: `${moneyText(row.amount)} on ${shortDate(row.dueThisMonth, today)}. Nothing matching it is recorded this month.`, href: "/bills" });
  }
  for (const due of dues.filter((d) => d.daysLeft !== null && d.daysLeft <= 7)) {
    attention.push({ key: `card-${due.account.id}`, icon: "creditcard", tone: "warning", title: `${due.account.name} payment due ${relativeDays(due.daysLeft!)}`, detail: `${moneyText(due.owed)} on the card today.`, href: "/bills" });
  }
  if (forecast.belowBufferOn) {
    attention.push({ key: "buffer", icon: "exclamationmark-triangle", tone: "bad", title: `Cash could fall below your buffer ${forecast.belowBufferOn === today ? "today" : `on ${shortDate(forecast.belowBufferOn, today)}`}`, detail: `In the cautious projection. Your buffer is ${moneyText(forecast.buffer)}.`, href: "/plan" });
  }
  for (const check of checks.filter((c) => c.difference.minor !== 0n && c.compares === "balance")) {
    attention.push({ key: `check-${check.account.id}`, icon: "questionmark-circle", tone: "warning", title: `${check.account.name} differs from your bank`, detail: `${deltaText(check.difference)} against the balance the bank last reported.`, href: "/accounts" });
  }
  const uncategorized = spendingByCategory.find((row) => row.categoryId === "uncategorized");
  if (uncategorized && uncategorized.amount.minor > 0n) {
    attention.push({ key: "uncategorized", icon: "tag", tone: "neutral", title: `${moneyText(uncategorized.amount)} is uncategorised`, detail: `${period.label}. Filing it makes budgets and the plan more accurate.`, href: `/transactions?category=uncategorized&from=${period.from}&to=${period.to}` });
  }
  if (before.spending.minor > 0n && now.spending.minor > (before.spending.minor * 115n) / 100n) {
    const percent = Math.round((Number(now.spending.minor - before.spending.minor) / Number(before.spending.minor)) * 100);
    attention.push({ key: "pace", icon: "arrow-up", tone: "neutral", title: `Spending is ${percent}% higher than ${period.previous.label}`, detail: `${moneyText(now.spending)} against ${moneyText(before.spending)}.`, href: `/transactions?from=${period.from}&to=${period.to}` });
  }

  const recent = service.searchTransactions({ limit: 8 }).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.merchantName ?? labelForKind(item.kind),
    category: item.categoryId ? (categoryOf.get(item.categoryId)?.name ?? item.categoryId) : item.merchantName ? labelForKind(item.kind) : null,
    icon: item.categoryId ? iconForCategory(categoryOf.get(item.categoryId)?.iconKey, categoryOf.get(item.categoryId)?.kind) : null,
    date: item.occurredLocalDate,
    amount: item.amount,
  }));

  const flow = dash.monthlyFlow(currency, today, 6);
  const unlockedAt = unlockedSince();

  const data: HomeData = {
    today,
    unlockedAt: unlockedAt ? new Date(unlockedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: service.zone }) : null,
    period: { key: period.key, label: period.label, from: period.from, to: period.to, previousLabel: period.previous.label },
    currency: currency.code,
    digits: currency.minorUnitDigits,
    otherCurrencies: dash.activeCurrencies().filter((code) => code !== currency.code),
    worth,
    totals: now,
    previous: before,
    savingsRate: now.income.minor > 0n ? Math.round((Number(now.net.minor) / Number(now.income.minor)) * 100) : null,
    flow: flow.map((m) => ({ month: m.month, income: m.income, spending: m.spending })),
    categories: [
      ...top.map((row) => ({ id: row.categoryId, name: categoryOf.get(row.categoryId)?.name ?? row.categoryId, amount: row.amount, share: share(row.amount.minor) })),
      ...(restMinor > 0n ? [{ id: "", name: "Everything else", amount: lkr(restMinor), share: share(restMinor) }] : []),
    ],
    merchants: dash.topMerchants(currency, period.from, period.to, 5),
    trend: { current: trendNow, previous: trendBefore },
    dailyAverage: lkr(now.spending.minor / BigInt(dayCount)),
    dayCount,
    recent,
    accounts: accounts.map(({ account, balance, available }) => ({ id: account.id, name: account.name, type: account.type, kind: account.kind, balance, available: available ?? null })),
    inbox,
    captureActive: capture.active,
    attention,
    upcoming: upcoming.slice(0, 6).map((u) => ({ ...u, when: relativeDays(u.days) })),
    plan: {
      canSetAside: forecast.canSetAside,
      monthEnd: forecast.monthEnd.base,
      lowest: forecast.lowest.base,
      confidence: forecast.confidence,
      daysToMonthEnd: daysBetween(today, forecast.monthEnd.date),
    },
  };

  return <HomeView data={data} />;
}
