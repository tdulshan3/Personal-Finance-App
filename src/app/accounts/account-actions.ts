"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import { parseMajorUnits, requireCurrency } from "../../core/domain/money.ts";
import { requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * Account edit, archive and restore.
 *
 * buildspec.md §13: "Categories with transactions can be archived or replaced through a migration
 * preview; do not orphan entries. Accounts with history are archived, not physically removed by
 * ordinary CRUD." There is deliberately no delete action here — archiving is the destructive-looking
 * operation the owner gets, and it is reversible.
 */

export type AccountFormState = { readonly error?: string | undefined; readonly ok?: string | undefined };

async function service() {
  const access = await accessState();
  if (access.kind !== "ready") {
    redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  }
  return requireService();
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export async function updateAccountAction(
  _prev: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  try {
    const svc = await service();
    const accountId = String(formData.get("accountId") ?? "");
    const account = svc.findAccount(accountId);
    if (!account) return { error: "That account no longer exists." };

    const institutionRaw = String(formData.get("institution") ?? "").trim();
    const limitRaw = String(formData.get("creditLimit") ?? "").trim();

    /*
     * An empty limit field means "no limit", not "zero". Zero would say the card can never be
     * used, which is a different and much more alarming claim than saying nothing.
     */
    const creditLimit =
      account.kind === "liability"
        ? limitRaw.length === 0
          ? null
          : parseMajorUnits(requireCurrency(account.currency.code), limitRaw)
        : undefined;

    svc.updateAccount({
      accountId,
      expectedRevision: Number(formData.get("expectedRevision") ?? 0),
      name: String(formData.get("name") ?? ""),
      institution: institutionRaw.length === 0 ? null : institutionRaw,
      creditLimit,
    });

    revalidatePath("/accounts");
    revalidatePath("/");
    return { ok: "Saved." };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function archiveAccountAction(formData: FormData): Promise<void> {
  const svc = await service();
  const accountId = String(formData.get("accountId") ?? "");
  if (String(formData.get("archived") ?? "") === "true") {
    svc.unarchiveAccount(accountId);
  } else {
    svc.archiveAccount(accountId);
  }
  revalidatePath("/accounts");
  revalidatePath("/");
}
