"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import { requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * Trash and restore, called straight from the Transactions screens' buttons, alerts and swipe
 * actions — so they answer with a result the screen can show instead of throwing.
 *
 * buildspec.md §13: "Normal deletion goes to Trash, explains the balance/bill impact, and offers
 * undo." The confirmation names the record before anything happens; the expected revision makes
 * the write fail rather than clobber an edit made in another window (§16).
 */

export type TrashResult = { readonly error?: string | undefined; readonly ok?: string | undefined };

type Target = { readonly transactionId: string; readonly expectedRevision: number };

/* Outside every try: `redirect` works by throwing, and a catch would show it as an error. */
async function requireReady(): Promise<void> {
  const access = await accessState();
  if (access.kind !== "ready") redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function refresh(transactionId: string): void {
  for (const path of ["/transactions", "/", "/activity", "/accounts", "/bills", "/plan"]) revalidatePath(path);
  revalidatePath(`/transactions/${transactionId}`);
}

export async function moveToTrash(target: Target): Promise<TrashResult> {
  await requireReady();
  try {
    requireService().deleteTransaction({ transactionId: String(target.transactionId), expectedRevision: Number(target.expectedRevision) });
  } catch (error) {
    return { error: describe(error) };
  }
  refresh(target.transactionId);
  return { ok: "Moved to Trash. Its effect on your balances is reversed." };
}

export async function restoreFromTrash(target: Target): Promise<TrashResult> {
  await requireReady();
  try {
    requireService().restoreTransaction({ transactionId: String(target.transactionId), expectedRevision: Number(target.expectedRevision) });
  } catch (error) {
    return { error: describe(error) };
  }
  refresh(target.transactionId);
  return { ok: "Restored." };
}
