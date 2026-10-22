"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import { AccountType } from "../../core/domain/ledger.ts";
import { parseMajorUnits, requireCurrency } from "../../core/domain/money.ts";
import { dateOnlyTime } from "../../core/domain/time.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * Accounts: create, edit, archive and restore.
 *
 * buildspec.md §13: "Categories with transactions can be archived or replaced through a migration
 * preview; do not orphan entries. Accounts with history are archived, not physically removed by
 * ordinary CRUD." There is deliberately no delete action here — archiving is the destructive-looking
 * operation the owner gets, and it is reversible.
 *
 * Every action returns a state rather than redirecting, so the sheet or inspector that called it
 * can show the service's own message next to the field it concerns.
 */

export type AccountFormState = { readonly error?: string | undefined; readonly ok?: string | undefined };

/*
 * The access check sits outside every try/catch on purpose. `redirect` works by throwing, so a
 * guard inside the try would be caught and shown to the owner as an error message instead of
 * sending them to the unlock screen.
 */
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

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}

function refresh(): void {
  for (const path of ["/accounts", "/", "/bills", "/plan"]) revalidatePath(path);
}

export async function createAccountAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const svc = await service();

  try {
    const currency = requireCurrency(String(formData.get("currency") ?? "LKR"));
    const limitText = String(formData.get("creditLimit") ?? "").trim();

    /*
     * buildspec.md §9.4 requires a verified balance *and* the time it was observed. An opening
     * balance is optional here: leaving it blank is the honest choice when the owner does not know
     * it yet, and §9.4 explicitly warns against inventing one.
     *
     * Everything is parsed before anything is written, and the two writes share one transaction.
     * Otherwise a bad opening balance would leave the account behind, and the owner's retry would
     * create a second one with the same name.
     */
    const openingText = String(formData.get("opening") ?? "").trim();
    const observedOn = String(formData.get("openingDate") ?? "").trim();
    if (openingText.length > 0 && observedOn.length === 0) {
      return { error: "An opening balance needs the date it was observed." };
    }
    const opening = openingText.length > 0 ? parseMajorUnits(currency, openingText) : undefined;
    const creditLimit = limitText.length > 0 ? parseMajorUnits(currency, limitText) : undefined;

    requireDb().transaction(() => {
      const account = svc.createAccount({
        name: String(formData.get("name") ?? ""),
        type: String(formData.get("type") ?? AccountType.BANK) as AccountType,
        currency,
        institution: emptyToUndefined(formData.get("institution")),
        // buildspec.md §10: a limit is recorded beside the account, never as a balance.
        ...(creditLimit ? { creditLimit } : {}),
      });
      if (opening) {
        svc.setOpeningBalance({
          accountId: account.id,
          amount: opening,
          occurredAt: dateOnlyTime(observedOn, svc.zone),
        });
      }
    });
  } catch (error) {
    return { error: describe(error) };
  }

  refresh();
  return { ok: "Account created." };
}

export async function updateAccountAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const svc = await service();
  try {
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
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  return { ok: "Saved." };
}

/** Archive, or with `archived=true` restore: the form says what the account is now. */
export async function setAccountArchivedAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const svc = await service();
  const accountId = String(formData.get("accountId") ?? "");
  const restoring = String(formData.get("archived") ?? "") === "true";
  try {
    if (restoring) svc.unarchiveAccount(accountId);
    else svc.archiveAccount(accountId);
  } catch (error) {
    return { error: describe(error) };
  }
  refresh();
  revalidatePath("/transactions");
  return { ok: restoring ? "Restored." : "Archived." };
}
