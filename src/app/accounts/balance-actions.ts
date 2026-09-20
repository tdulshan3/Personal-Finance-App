"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { exactTime } from "../../core/domain/time.ts";
import { createBalanceCheckService } from "../../core/services/balance-check.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * Records the gap between the bank's figure and the books as an "Unexplained difference"
 * (buildspec.md §10): a real, labelled transaction at the moment the bank reported, which can be
 * moved to Trash like any other. The amount is recomputed here, never taken from the form, so a
 * stale page or a double tap cannot post the wrong figure — a second tap finds no gap left.
 */
export async function recordDifferenceAction(formData: FormData): Promise<void> {
  const access = await accessState();
  if (access.kind !== "ready") redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");

  const service = requireService();
  const accountId = String(formData.get("accountId") ?? "");
  const check = createBalanceCheckService({ db: requireDb(), service }).accounts().find((c) => c.account.id === accountId);
  if (check && check.difference.minor !== 0n && check.compares === "balance") {
    service.recordUnknownAdjustment(
      { accountId, displayDelta: check.difference, occurredAt: exactTime(check.observedAt, service.zone) },
      { origin: "ui.accounts.reconcile", reason: "Owner recorded the gap between the bank's reported balance and the ledger" },
    );
  }
  for (const path of ["/accounts", "/", "/transactions", "/activity"]) revalidatePath(path);
}
