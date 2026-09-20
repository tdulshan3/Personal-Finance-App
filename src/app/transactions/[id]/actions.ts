"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../../core/domain/errors.ts";
import { parseMajorUnits } from "../../../core/domain/money.ts";
import { dateOnlyTime, localDateOfFinancialTime } from "../../../core/domain/time.ts";
import { requireService } from "../../../server/runtime.ts";
import { accessState } from "../../../server/session.ts";

/**
 * Editing a posted expense or income.
 *
 * buildspec.md §9.3: "Editing a posted amount, account, currency, or effective date creates a
 * journal reversal and a replacement journal in one database transaction." None of that happens
 * here — this file parses the form, hands it to `finance-service`, and maps errors to a message.
 */

export type EditTransactionState = {
  readonly error?: string | undefined;
  readonly ok?: string | undefined;
};

/*
 * The access check sits outside every try/catch on purpose. `redirect` works by throwing, so a
 * guard inside the try would be caught and shown to the owner as an error message instead of
 * sending them to the unlock screen.
 */
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

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}

export async function editTransactionAction(
  _prev: EditTransactionState,
  formData: FormData,
): Promise<EditTransactionState> {
  await requireReady();
  const service = requireService();
  const transactionId = String(formData.get("transactionId") ?? "");

  try {
    // Throws NOT_FOUND for an unknown id; the kind comes from the record, never from the form.
    const detail = service.getTransactionDetail(transactionId);
    const kind = detail.transaction.kind;
    if (kind !== "expense" && kind !== "income") {
      return { error: "This kind of record can't be edited yet. Delete it and record it again." };
    }

    /*
     * An edit always writes a replacement journal, and buildspec.md §9.4 forbids a history-only
     * record from carrying one. The page hides the form for these; this is the same rule for a
     * request that did not come from the page.
     */
    if (detail.transaction.accountingScope !== "ledger") {
      return { error: "History-only records can't be edited yet." };
    }

    const occurredOn = String(formData.get("occurredOn") ?? "").trim();
    if (occurredOn.length === 0) return { error: "Pick the date this happened." };

    /*
     * Only the owner's own accounts are valid here. The category and equity accounts behind the
     * ledger have ids too, and a hand-built request naming one would still balance.
     */
    const accountId = String(formData.get("accountId") ?? "");
    const account = service.findAccount(accountId);
    if (!account || !account.isUserVisible) return { error: "Choose an account." };

    const amount = parseMajorUnits(account.currency, String(formData.get("amount") ?? ""));
    // A negative amount would balance perfectly while posting the record backwards.
    if (amount.minor <= 0n) return { error: "Enter an amount greater than zero." };

    /*
     * buildspec.md §16: a midnight value "is not proof that the purchase happened at midnight". If
     * the owner left the date alone, keep the time and precision the record already has, so that
     * correcting an amount does not quietly downgrade an exact imported time to date-only.
     */
    const current = detail.currentRevision.occurredAt;
    const occurredAt =
      occurredOn === localDateOfFinancialTime(current)
        ? current
        : dateOnlyTime(occurredOn, service.zone);

    const chosenCategory = String(formData.get("categoryId") ?? "").trim();
    const categoryId =
      kind === "income"
        ? // Same rule as creating income: "Uncategorized" is an expense bucket.
          chosenCategory.length === 0 || chosenCategory === "uncategorized"
          ? "income"
          : chosenCategory
        : chosenCategory.length === 0
          ? "uncategorized"
          : chosenCategory;

    const input = {
      transactionId,
      expectedRevision: Number(formData.get("expectedRevision") ?? 0),
      accountId,
      amount,
      occurredAt,
      splits: [{ categoryId, amount }],
      merchantName: emptyToUndefined(formData.get("merchantName")),
      notes: emptyToUndefined(formData.get("notes")),
    };

    if (kind === "income") service.editIncome(input);
    else service.editExpense(input);
  } catch (error) {
    return { error: describe(error) };
  }

  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath(`/transactions/${transactionId}`);
  return { ok: "Saved." };
}
