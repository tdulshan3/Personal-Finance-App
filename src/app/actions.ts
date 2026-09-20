"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../core/domain/errors.ts";
import { AccountType } from "../core/domain/ledger.ts";
import { parseMajorUnits, requireCurrency } from "../core/domain/money.ts";
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
/* Accounts                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export async function createAccountAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireReady();
  const service = requireService();

  try {
    const currency = requireCurrency(String(formData.get("currency") ?? "LKR"));
    const limitText = String(formData.get("creditLimit") ?? "").trim();
    const account = service.createAccount({
      name: String(formData.get("name") ?? ""),
      type: String(formData.get("type") ?? AccountType.BANK) as AccountType,
      currency,
      institution: emptyToUndefined(formData.get("institution")),
      // buildspec.md §10: a limit is recorded beside the account, never as a balance.
      ...(limitText.length > 0 ? { creditLimit: parseMajorUnits(currency, limitText) } : {}),
    });

    /*
     * buildspec.md §9.4 requires a verified balance *and* the time it was observed. An opening
     * balance is optional here: leaving it blank is the honest choice when the owner does not know
     * it yet, and §9.4 explicitly warns against inventing one.
     */
    const openingText = String(formData.get("opening") ?? "").trim();
    if (openingText.length > 0) {
      const observedOn = String(formData.get("openingDate") ?? "").trim();
      if (observedOn.length === 0) {
        return { error: "An opening balance needs the date it was observed." };
      }
      service.setOpeningBalance({
        accountId: account.id,
        amount: parseMajorUnits(currency, openingText),
        occurredAt: dateOnlyTime(observedOn, service.zone),
      });
    }
  } catch (error) {
    return { error: describe(error) };
  }

  revalidatePath("/accounts");
  revalidatePath("/");
  return { ok: true };
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

  revalidatePath("/transactions");
  revalidatePath("/");
  redirect("/transactions");
}

export async function deleteTransactionAction(formData: FormData): Promise<void> {
  await requireReady();
  const service = requireService();
  service.deleteTransaction({
    transactionId: String(formData.get("transactionId") ?? ""),
    expectedRevision: Number(formData.get("expectedRevision") ?? 0),
  });
  revalidatePath("/transactions");
  revalidatePath("/");
}

export async function restoreTransactionAction(formData: FormData): Promise<void> {
  await requireReady();
  const service = requireService();
  service.restoreTransaction({
    transactionId: String(formData.get("transactionId") ?? ""),
    expectedRevision: Number(formData.get("expectedRevision") ?? 0),
  });
  revalidatePath("/transactions");
  revalidatePath("/");
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}
