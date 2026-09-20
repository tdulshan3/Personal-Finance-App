"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import { createCardDueService } from "../../core/services/card-dues.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

export type DueDayState = { readonly error?: string | undefined; readonly ok?: string | undefined };

export async function setDueDayAction(_prev: DueDayState, formData: FormData): Promise<DueDayState> {
  const access = await accessState();
  if (access.kind !== "ready") redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  try {
    const raw = String(formData.get("dueDay") ?? "").trim();
    const dues = createCardDueService({ db: requireDb(), service: requireService() });
    dues.setDueDay(String(formData.get("accountId") ?? ""), raw === "" ? null : Number(raw));
    revalidatePath("/bills");
    revalidatePath("/");
    return { ok: raw === "" ? "Due day cleared." : "Saved." };
  } catch (error) {
    return { error: isFinanceError(error) ? error.message : "Could not save that." };
  }
}
