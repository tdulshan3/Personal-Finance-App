"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFinanceError } from "../../core/domain/errors.ts";
import { createReviewService } from "../../ingestion/review-service.ts";
import { currentProcessor } from "../../server/background.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

export type ReviewState = { readonly error?: string | undefined; readonly ok?: string | undefined };

async function review() {
  const access = await accessState();
  if (access.kind !== "ready") redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  return createReviewService({ db: requireDb(), service: requireService() });
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}

/*
 * The access check runs before each `try`: `redirect` works by throwing, and a catch would show the
 * owner "NEXT_REDIRECT" instead of sending them to the unlock screen.
 */
export async function acceptReviewAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  const svc = await review();
  try {
    const text = (key: string) => String(formData.get(key) ?? "").trim();
    svc.accept({
      eventId: text("eventId"),
      kind: (text("kind") || "expense") as "expense" | "income" | "refund",
      accountId: text("accountId"),
      categoryId: text("categoryId") || "uncategorized",
      amountText: text("amount"),
      occurredOn: text("occurredOn"),
      merchantName: text("merchantName") || undefined,
      notes: text("notes") || undefined,
      pairedEventId: text("pairedEventId") || undefined,
    });
    for (const path of ["/review", "/transactions", "/", "/accounts", "/bills", "/plan"]) revalidatePath(path);
    return { ok: "Recorded." };
  } catch (error) {
    return { error: describe(error) };
  }
}

/** Ignore or Dismiss: the message stays staged as evidence but never becomes a transaction. */
export async function ignoreReviewAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  const svc = await review();
  try {
    svc.ignore(String(formData.get("eventId") ?? ""));
    revalidatePath("/review");
    revalidatePath("/");
    return { ok: "Ignored." };
  } catch (error) {
    return { error: describe(error) };
  }
}

/** "Process now": runs the rules (and the model, if reachable) over anything waiting. */
export async function processNowAction(_prev: ReviewState, _formData: FormData): Promise<ReviewState> {
  await review();
  try {
    const processor = currentProcessor();
    if (!processor) return { error: "Background processing is not running. Lock and unlock once." };
    const report = await processor.processPending({ limit: 100 });
    revalidatePath("/review");
    revalidatePath("/");
    if (report.considered === 0) return { ok: "Nothing was waiting." };
    return {
      ok:
        `${report.considered} checked: ${report.toReview} to review, ${report.ignored} ignored` +
        (report.waitingForModel > 0 ? `, ${report.waitingForModel} waiting for the model` : "") +
        (report.failed > 0 ? `, ${report.failed} failed` : "") + ".",
    };
  } catch (error) {
    return { error: describe(error) };
  }
}
