import type { Db } from "../core/data/driver.ts";
import type { Currency } from "../core/domain/money.ts";
import { formatMoney, requireCurrency } from "../core/domain/money.ts";
import { localDateOf } from "../core/domain/time.ts";
import { createBudgetService } from "../core/services/budget-service.ts";
import { createCardDueService } from "../core/services/card-dues.ts";
import type { FinanceService } from "../core/services/finance-service.ts";
import { createForecastService } from "../core/services/forecast-service.ts";
import { createGoalService } from "../core/services/goal-service.ts";
import { createRecurringService } from "../core/services/recurring-service.ts";

/**
 * The Plan and Bills screens' figures, for the assistant.
 *
 * One module feeds both the rules-first answers and the model's read tools, so "how much can I
 * save?" gets the same number from either path — and the same number the Plan screen shows. Every
 * figure is computed by the services and formatted here; the model never does the arithmetic
 * (buildspec.md §1.1). Nothing here writes.
 */

export function createPlanningReader(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;
  const today = () => localDateOf(service.clock.now(), service.zone);

  /** The currencies the owner actually holds, so a plan is never made in one they don't use. */
  function currencies(): Currency[] {
    const codes = new Set(service.listAccounts().filter((a) => a.isUserVisible).map((a) => a.currency.code));
    return [...codes].map(requireCurrency);
  }

  /** Bills and income still to come this month and next, and every card payment with a due day. */
  function bills() {
    const day = today();
    const recurring = createRecurringService({ db, service })
      .list(day)
      .map((row) => ({
        name: row.name,
        direction: row.direction === "in" ? "income" : "bill",
        amount: formatMoney(row.amount),
        state: row.state,
        due: row.nextDue,
        days_until: row.daysUntil,
      }));
    const cards = createCardDueService({ db, service })
      .list(day)
      .filter((due) => due.owed.minor > 0n && due.account.type !== "loan")
      .map((due) => ({
        name: `${due.account.name} payment`,
        direction: "card",
        amount: formatMoney(due.owed),
        state: due.dueOn ? "upcoming" : "no due day set",
        due: due.dueOn,
        days_until: due.daysLeft,
      }));
    return [...recurring, ...cards].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  }

  function budgets() {
    const service_ = createBudgetService({ db, service });
    return currencies().flatMap((currency) =>
      service_.list(currency, today()).map((row) => ({
        category: row.categoryName,
        limit: formatMoney(row.limit),
        spent: formatMoney(row.spent),
        remaining: formatMoney(row.remaining),
        percent_used: Math.round(row.ratio * 100),
        projected_month_end: formatMoney(row.projected),
        status: row.status,
      })),
    );
  }

  function forecast() {
    const forecasts = createForecastService({ db, service });
    return currencies().map((currency) => {
      const plan = forecasts.project(currency, today());
      return {
        currency: currency.code,
        spendable_now: formatMoney(plan.start),
        average_day_of_spending: formatMoney(plan.dailySpend),
        history_days: plan.historyDays,
        confidence: plan.confidence,
        month_end: { date: plan.monthEnd.date, base: formatMoney(plan.monthEnd.base), cautious: formatMoney(plan.monthEnd.conservative) },
        lowest_point: { date: plan.lowest.base.date, amount: formatMoney(plan.lowest.base.amount) },
        buffer: formatMoney(plan.buffer),
        could_set_aside: formatMoney(plan.canSetAside),
        cautious_below_buffer_on: plan.belowBufferOn,
        projected_until: plan.until,
        notes: plan.notes,
      };
    });
  }

  function goals() {
    return createGoalService({ db, service })
      .list(today())
      .map((goal) => ({
        name: goal.name,
        saved: formatMoney(goal.saved),
        target: formatMoney(goal.target),
        percent: Math.round(goal.progress * 100),
        target_date: goal.targetDate,
        per_month_needed: goal.perMonth ? formatMoney(goal.perMonth) : null,
        follows_account: goal.accountName,
        reached: goal.reached,
      }));
  }

  return { bills, budgets, forecast, goals };
}

export type PlanningReader = ReturnType<typeof createPlanningReader>;
