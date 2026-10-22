import { redirect } from "next/navigation";

import { money, requireCurrency } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { createBudgetService, monthBounds } from "../../core/services/budget-service.ts";
import { createCategoryService } from "../../core/services/category-service.ts";
import { createDashboardService } from "../../core/services/dashboard-service.ts";
import { currentVault, requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { monthLong } from "../../ui/format.ts";
import { colorForCategory, iconForCategory } from "../../ui/labels.ts";
import type { CategoriesData } from "./categories-view.tsx";
import { CategoriesView } from "./categories-view.tsx";

export const dynamic = "force-dynamic";

/**
 * Categories: where money goes and where it comes from, each with this month's figure and, for
 * spending, a monthly budget.
 *
 * Every amount here is summed from journal entries by the same services as Home and Plan, so the
 * figures agree across screens: a transfer is never spending, a refund comes back out of its
 * category, and a record in Trash counts for nothing.
 */
export default async function CategoriesPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const db = requireDb();
  const service = requireService();
  const today = localDateOf(Date.now(), service.zone);
  const currency = requireCurrency(currentVault()?.currency ?? "LKR");
  const month = monthBounds(today);
  const dashboard = createDashboardService({ db });
  const categories = createCategoryService({ db, service });
  const budgets = createBudgetService({ db, service });

  const spent = new Map(dashboard.byCategory(currency, month.from, month.to, "expense").map((row) => [row.categoryId, row.amount]));
  const earned = new Map(dashboard.byCategory(currency, month.from, month.to, "income").map((row) => [row.categoryId, row.amount]));
  const budgetOf = new Map(budgets.list(currency, today).map((row) => [row.categoryId, row]));
  const suggestionOf = new Map(budgets.suggestions(currency, today).map((row) => [row.categoryId, row]));

  const data: CategoriesData = {
    currency: currency.code,
    monthLabel: monthLong(today.slice(0, 7)),
    categories: categories.list(true).map((category) => {
      const budget = budgetOf.get(category.id);
      const suggestion = suggestionOf.get(category.id);
      return {
        id: category.id,
        name: category.name,
        kind: category.kind,
        icon: iconForCategory(category.iconKey, category.kind),
        color: colorForCategory(category.id),
        uses: category.uses,
        archived: category.archivedAt !== undefined,
        protected: categories.isProtected(category.id),
        thisMonth: (category.kind === "income" ? earned : spent).get(category.id) ?? money(currency, 0n),
        budget: budget
          ? { limit: budget.limit, spent: budget.spent, remaining: budget.remaining, ratio: budget.ratio, projected: budget.projected, status: budget.status }
          : null,
        suggestion: suggestion ? { average: suggestion.average, suggested: suggestion.suggested } : null,
      };
    }),
  };

  return <CategoriesView data={data} />;
}
