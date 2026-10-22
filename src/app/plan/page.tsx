import { redirect } from "next/navigation";

import { requireCurrency } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { createBudgetService, monthBounds } from "../../core/services/budget-service.ts";
import { createForecastService } from "../../core/services/forecast-service.ts";
import { createGoalService } from "../../core/services/goal-service.ts";
import { currentVault, requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { iconForCategory } from "../../ui/labels.ts";
import type { PlanData } from "./plan-view.tsx";
import { PlanView } from "./plan-view.tsx";

export const dynamic = "force-dynamic";

/**
 * Plan (buildspec.md M5): where the money is heading, what this month's limits are, and what it
 * is being saved for.
 *
 * The projection is `forecast-service`: recorded spendable balances, the owner's saved bills and
 * income on their days, card payments on their due days, and an average day of everything else.
 * It is a planning range with a cautious line beside it, and the screen says how it was worked
 * out and how much history it rests on — thin history is labelled, never dressed up as an answer.
 *
 * Budgets and goals are planning figures only. Nothing on this screen moves money.
 */
export default async function PlanPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const db = requireDb();
  const service = requireService();
  const today = localDateOf(Date.now(), service.zone);
  const currency = requireCurrency(currentVault()?.currency ?? "LKR");
  const forecast = createForecastService({ db, service }).project(currency, today);
  const budgets = createBudgetService({ db, service });
  const rows = budgets.list(currency, today);
  const month = monthBounds(today);
  const categories = service.listCategories();
  const budgeted = new Set(rows.map((row) => row.categoryId));
  const icons = new Map(service.listCategories(true).map((c) => [c.id, iconForCategory(c.iconKey, c.kind)]));

  const data: PlanData = {
    today,
    currency: currency.code,
    digits: currency.minorUnitDigits,
    month: { from: month.from, to: month.to, day: month.day, days: month.days },
    forecast: {
      start: forecast.start,
      buffer: forecast.buffer,
      dailySpend: forecast.dailySpend,
      historyDays: forecast.historyDays,
      confidence: forecast.confidence,
      until: forecast.until,
      points: forecast.points.map((p) => ({ date: p.date, base: p.base, conservative: p.conservative })),
      events: forecast.events.map((e) => ({ date: e.date, label: e.label, amount: e.amount, kind: e.kind })),
      lowest: forecast.lowest,
      monthEnd: forecast.monthEnd,
      canSetAside: forecast.canSetAside,
      belowBufferOn: forecast.belowBufferOn,
      notes: [...forecast.notes],
    },
    budgets: rows.map((row) => ({ ...row, icon: icons.get(row.categoryId) ?? "tag" })),
    summary: budgets.summary(currency, today),
    suggestions: budgets.suggestions(currency, today),
    // Spending categories that do not have a budget yet: what "Add Budget" offers.
    unbudgeted: categories.filter((c) => c.kind === "expense" && !budgeted.has(c.id)).map((c) => ({ id: c.id, name: c.name })),
    goals: createGoalService({ db, service }).list(today),
    savingsAccounts: service
      .listAccounts()
      .filter((a) => a.isUserVisible && a.kind === "asset")
      .map((a) => ({ id: a.id, name: a.name, currency: a.currency.code, type: a.type })),
  };

  return <PlanView data={data} />;
}
