"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import type { Currency } from "../../core/domain/money.ts";
import { parseMajorUnits, requireCurrency } from "../../core/domain/money.ts";
import { createBudgetService } from "../../core/services/budget-service.ts";
import { createForecastService } from "../../core/services/forecast-service.ts";
import { createGoalService } from "../../core/services/goal-service.ts";
import { currentVault, requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * Plan: the buffer, budgets and savings goals.
 *
 * Every one of these is a planning figure. None of them moves money or touches a balance — a
 * budget is compared with ledger spending, a goal with an account's recorded balance or a figure
 * kept by hand, and the buffer only decides where the projection draws its line.
 */

export type PlanState = { readonly error?: string | undefined; readonly ok?: string | undefined };

/* `redirect` works by throwing, so the access check stays outside every try/catch. */
async function requireReady(): Promise<void> {
  const access = await accessState();
  if (access.kind !== "ready") redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  return error instanceof Error ? error.message : "Could not save that.";
}

function refresh(): void {
  for (const path of ["/plan", "/", "/bills"]) revalidatePath(path);
}

const ledgerCurrency = (): Currency => requireCurrency(currentVault()?.currency ?? "LKR");

function amountIn(currency: Currency, text: string, what: string) {
  if (text.trim().length === 0) throw new Error(`Enter ${what}.`);
  return parseMajorUnits(currency, text);
}

export async function setBufferAction(amount: string): Promise<PlanState> {
  await requireReady();
  try {
    const currency = ledgerCurrency();
    createForecastService({ db: requireDb(), service: requireService() }).setBuffer(
      amount.trim().length === 0 ? parseMajorUnits(currency, "0") : amountIn(currency, amount, "a buffer"),
    );
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: "Saved." };
}

/** A null amount removes the category's budget. */
export async function setBudgetAction(input: { categoryId: string; amount: string | null }): Promise<PlanState> {
  await requireReady();
  try {
    const budgets = createBudgetService({ db: requireDb(), service: requireService() });
    budgets.set(input.categoryId, input.amount === null ? null : amountIn(ledgerCurrency(), input.amount, "a monthly limit"));
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: input.amount === null ? "Budget removed." : "Saved." };
}

export type GoalInput = {
  readonly id?: string | undefined;
  readonly name: string;
  readonly target: string;
  /** YYYY-MM-DD, or empty for no date. */
  readonly targetDate: string;
  /** An asset account whose balance is the progress, or empty to keep the figure by hand. */
  readonly accountId: string;
  /** The hand-kept figure; only read for a goal with no account. */
  readonly saved: string;
};

export async function saveGoalAction(input: GoalInput): Promise<PlanState> {
  await requireReady();
  const service = requireService();
  try {
    // A goal linked to an account is in that account's currency; otherwise the ledger's.
    const account = input.accountId ? service.findAccount(input.accountId) : undefined;
    const currency = account?.currency ?? ledgerCurrency();
    const fields = {
      name: input.name,
      target: amountIn(currency, input.target, "a target"),
      targetDate: input.targetDate || null,
      accountId: input.accountId || null,
      ...(!input.accountId && input.saved.trim().length > 0 ? { saved: parseMajorUnits(currency, input.saved) } : {}),
    };
    const goals = createGoalService({ db: requireDb(), service });
    if (input.id) goals.update({ id: input.id, ...fields });
    else goals.create(fields);
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: "Saved." };
}

/** Adds to a hand-kept goal; a negative amount takes money back out of it. */
export async function contributeGoalAction(input: { id: string; amount: string; currency: string }): Promise<PlanState> {
  await requireReady();
  try {
    createGoalService({ db: requireDb(), service: requireService() }).contribute(input.id, amountIn(requireCurrency(input.currency), input.amount, "an amount"));
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: "Saved." };
}

export async function archiveGoalAction(id: string): Promise<PlanState> {
  await requireReady();
  try {
    createGoalService({ db: requireDb(), service: requireService() }).archive(id);
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: "Removed." };
}
