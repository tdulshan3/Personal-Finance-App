"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../core/domain/errors.ts";
import { parseMajorUnits } from "../core/domain/money.ts";
import { dateOnlyTime } from "../core/domain/time.ts";
import { initialise, lock, requireService, unlock } from "../server/runtime.ts";
import { accessState, endSession, startSession } from "../server/session.ts";

/**
 * Server actions: the authenticated adapter over the application services.
 *
 * buildspec.md §3 keeps the contracts in-process; here the process is reached over HTTP, so every
 * action re-checks the session rather than trusting the caller. Nothing in this file implements
 * business rules — it parses input, calls `finance-service`, and maps errors to messages.
 */

export type ActionState = { readonly error?: string; readonly ok?: boolean };

/** Every mutating action starts here. A locked vault or missing session stops the request. */
async function requireReady(): Promise<void> {
  const access = await accessState();
  if (access.kind !== "ready") {
    redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  }
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/* -------------------------------------------------------------------------------------------- */
/* Vault lifecycle                                                                                */
/* -------------------------------------------------------------------------------------------- */

export async function setupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const passphrase = String(formData.get("passphrase") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (passphrase !== confirm) return { error: "The two passphrases do not match." };

  try {
    await initialise({
      passphrase,
      zone: String(formData.get("zone") ?? "Asia/Colombo"),
      currency: String(formData.get("currency") ?? "LKR"),
    });
    await startSession();
  } catch (error) {
    return { error: describe(error) };
  }
  redirect("/");
}

export async function unlockAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    await unlock(String(formData.get("passphrase") ?? ""));
    await startSession();
  } catch (error) {
    return { error: describe(error) };
  }
  redirect("/");
}

/** buildspec.md §18: "a manual 'Lock now'". */
export async function lockAction(): Promise<void> {
  lock("Locked by the owner");
  await endSession();
  redirect("/unlock");
}

/* -------------------------------------------------------------------------------------------- */
/* Transactions                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export async function createTransactionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireReady();
  const service = requireService();

  const kind = String(formData.get("kind") ?? "expense");
  const amountText = String(formData.get("amount") ?? "").trim();
  const occurredOn = String(formData.get("occurredOn") ?? "").trim();
  const notes = emptyToUndefined(formData.get("notes"));
  const merchantName = emptyToUndefined(formData.get("merchantName"));
  // buildspec.md §16: a retried submit must not post twice.
  const idempotencyKey = emptyToUndefined(formData.get("idempotencyKey"));

  try {
    if (occurredOn.length === 0) return { error: "Pick the date this happened." };

    const accountId = String(formData.get("accountId") ?? "");
    const account = service.findAccount(accountId);
    if (!account) return { error: "Choose an account." };

    const amount = parseMajorUnits(account.currency, amountText);
    const occurredAt = dateOnlyTime(occurredOn, service.zone);
    const categoryId = String(formData.get("categoryId") ?? "uncategorized");
    const write = idempotencyKey ? { idempotencyKey } : {};

    switch (kind) {
      case "expense":
        service.createExpense(
          {
            accountId,
            amount,
            occurredAt,
            merchantName,
            notes,
            splits: [{ categoryId, amount }],
          },
          write,
        );
        break;
      case "income":
        service.createIncome(
          {
            accountId,
            amount,
            occurredAt,
            merchantName,
            notes,
            splits: [{ categoryId: categoryId === "uncategorized" ? "income" : categoryId, amount }],
          },
          write,
        );
        break;
      case "transfer": {
        const toAccountId = String(formData.get("toAccountId") ?? "");
        if (!toAccountId) return { error: "Choose the account the money went to." };
        const feeText = String(formData.get("fee") ?? "").trim();
        service.createTransfer(
          {
            fromAccountId: accountId,
            toAccountId,
            amount,
            occurredAt,
            notes,
            fee:
              feeText.length > 0
                ? { amount: parseMajorUnits(account.currency, feeText), categoryId: "fees" }
                : undefined,
          },
          write,
        );
        break;
      }
      case "refund":
        service.createRefund(
          { accountId, amount, occurredAt, categoryId, merchantName, notes },
          write,
        );
        break;
      default:
        return { error: `Unknown transaction type '${kind}'.` };
    }
  } catch (error) {
    return { error: describe(error) };
  }

  for (const path of ["/transactions", "/", "/accounts", "/bills", "/plan"]) revalidatePath(path);
  return { ok: true };
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}
