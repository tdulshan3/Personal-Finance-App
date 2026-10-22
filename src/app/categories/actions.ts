"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import { parseMajorUnits, requireCurrency } from "../../core/domain/money.ts";
import { createBudgetService } from "../../core/services/budget-service.ts";
import { createCategoryService } from "../../core/services/category-service.ts";
import { currentVault, requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * Categories and their monthly budgets.
 *
 * buildspec.md §7.5 calls the category set "editable", and §13 says a category with transactions is
 * archived, never deleted, so nothing it labels is orphaned. The rules — unique names, a fixed
 * direction, the three categories the app itself names — live in `category-service` and
 * `budget-service`; these actions parse the form and report what the services said.
 */

export type CategoryState = { readonly error?: string | undefined; readonly ok?: string | undefined };

/*
 * Outside every try/catch on purpose: `redirect` works by throwing, and a catch would turn the
 * trip to the unlock screen into an error message.
 */
async function services() {
  const access = await accessState();
  if (access.kind !== "ready") redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  const db = requireDb();
  const service = requireService();
  return { categories: createCategoryService({ db, service }), budgets: createBudgetService({ db, service }) };
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

function refresh(): void {
  for (const path of ["/categories", "/plan", "/", "/transactions"]) revalidatePath(path);
}

export async function createCategoryAction(_prev: CategoryState, formData: FormData): Promise<CategoryState> {
  const { categories } = await services();
  try {
    const kind = text(formData, "kind");
    const created = categories.create({
      name: text(formData, "name"),
      kind: kind === "income" ? "income" : "expense",
      icon: text(formData, "icon") || undefined,
    });
    refresh();
    return { ok: `Added “${created.name}”.` };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function updateCategoryAction(_prev: CategoryState, formData: FormData): Promise<CategoryState> {
  const { categories } = await services();
  try {
    categories.update({ id: text(formData, "id"), name: text(formData, "name"), icon: text(formData, "icon") || null });
    refresh();
    return { ok: "Saved." };
  } catch (error) {
    return { error: describe(error) };
  }
}

/** Archive, or with `archived=true` restore: the form says what the category is now. */
export async function setCategoryArchivedAction(_prev: CategoryState, formData: FormData): Promise<CategoryState> {
  const { categories } = await services();
  const restoring = text(formData, "archived") === "true";
  try {
    if (restoring) categories.unarchive(text(formData, "id"));
    else categories.archive(text(formData, "id"));
    refresh();
    return { ok: restoring ? "Restored." : "Archived." };
  } catch (error) {
    return { error: describe(error) };
  }
}

/** Sets a monthly budget in the vault's currency; an empty amount removes it. */
export async function setBudgetAction(_prev: CategoryState, formData: FormData): Promise<CategoryState> {
  const { budgets } = await services();
  try {
    const categoryId = text(formData, "categoryId");
    const amount = text(formData, "amount");
    const currency = requireCurrency(currentVault()?.currency ?? "LKR");
    budgets.set(categoryId, amount.length === 0 ? null : parseMajorUnits(currency, amount));
    refresh();
    return { ok: amount.length === 0 ? "Budget removed." : "Budget saved." };
  } catch (error) {
    return { error: describe(error) };
  }
}
