"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import { parseMajorUnits, requireCurrency } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { createCardDueService } from "../../core/services/card-dues.ts";
import type { RecurringDirection } from "../../core/services/recurring-service.ts";
import { createRecurringService } from "../../core/services/recurring-service.ts";
import { currentVault, requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * Bills: card due days and the owner's recurring bills and income.
 *
 * Nothing here posts a transaction. A due day and a recurring item are planning facts the owner
 * supplies; paying one is an ordinary transaction recorded through the New Transaction sheet, and
 * the recurring service recognises it from the ledger afterwards.
 */

export type BillsState = { readonly error?: string | undefined; readonly ok?: string | undefined };

/*
 * The access check sits outside every try/catch: `redirect` works by throwing, and a catch would
 * turn "go and unlock" into an error message.
 */
async function requireReady(): Promise<void> {
  const access = await accessState();
  if (access.kind !== "ready") redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  return error instanceof Error ? error.message : "Could not save that.";
}

function refresh(): void {
  for (const path of ["/bills", "/plan", "/"]) revalidatePath(path);
}

export async function setDueDayAction(input: { accountId: string; dueDay: number | null }): Promise<BillsState> {
  await requireReady();
  try {
    createCardDueService({ db: requireDb(), service: requireService() }).setDueDay(input.accountId, input.dueDay);
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: input.dueDay === null ? "Due day cleared." : "Saved." };
}

export type RecurringInput = {
  readonly id?: string | undefined;
  readonly name: string;
  readonly direction: RecurringDirection;
  /** Major units as typed, e.g. "6200.00". */
  readonly amount: string;
  readonly dueDay: number;
  readonly accountId: string | null;
  readonly categoryId: string | null;
  /** Empty means "use the name". */
  readonly matchText: string;
};

export async function saveRecurringAction(input: RecurringInput): Promise<BillsState> {
  await requireReady();
  const service = requireService();
  try {
    if (input.amount.trim().length === 0) return { error: "Enter the amount it usually is." };
    // The amount is in the account's own currency; with no account, in the ledger's currency.
    const account = input.accountId ? service.findAccount(input.accountId) : undefined;
    const currency = account?.currency ?? requireCurrency(currentVault()?.currency ?? "LKR");
    const fields = {
      name: input.name,
      direction: input.direction,
      amount: parseMajorUnits(currency, input.amount),
      dueDay: input.dueDay,
      accountId: input.accountId || null,
      categoryId: input.categoryId || null,
      matchText: input.matchText.trim().length > 0 ? input.matchText : input.name,
    };
    const recurring = createRecurringService({ db: requireDb(), service });
    if (input.id) recurring.update({ id: input.id, ...fields });
    else recurring.create(fields);
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: "Saved." };
}

export async function removeRecurringAction(id: string): Promise<BillsState> {
  await requireReady();
  try {
    createRecurringService({ db: requireDb(), service: requireService() }).archive(id);
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: "Removed." };
}

/**
 * Adds a suggestion from the ledger. The suggestion is found again here by its key rather than
 * taken from the request, so what is saved is what the ledger shows, not what a page once said.
 */
export async function addSuggestionAction(key: string): Promise<BillsState> {
  await requireReady();
  const db = requireDb();
  const service = requireService();
  try {
    const currency = requireCurrency(currentVault()?.currency ?? "LKR");
    const recurring = createRecurringService({ db, service });
    const found = recurring.detect(currency, localDateOf(Date.now(), service.zone)).find((s) => s.key === key);
    if (!found) return { error: "That suggestion is no longer there. It may already be tracked." };
    const account = found.accountId ? service.findAccount(found.accountId) : undefined;
    // Income can only arrive in a bank, cash or wallet account; leave a card off an income item.
    const accountId = account && (found.direction === "out" || account.kind === "asset") ? account.id : null;
    recurring.create({
      name: found.name,
      direction: found.direction,
      amount: found.amount,
      dueDay: found.dueDay,
      accountId,
      categoryId: found.categoryId,
      matchText: found.name,
    });
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: "Added." };
}
