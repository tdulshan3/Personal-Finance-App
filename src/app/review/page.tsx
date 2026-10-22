import { redirect } from "next/navigation";

import { formatMoney } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { createReviewService } from "../../ingestion/review-service.ts";
import { backgroundStatus, currentProcessor } from "../../server/background.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import type { ReviewData, ReviewMessage } from "./review-view.tsx";
import { ReviewView } from "./review-view.tsx";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  posted_expense: "Purchase",
  posted_income: "Money in",
  refund: "Refund",
  bill: "Bill",
  pending_payment: "Scheduled",
  transfer: "Transfer",
  fee: "Fee",
  unknown: "Needs your input",
};

/**
 * Review inbox (buildspec.md §13): "Uncertain extraction, account mapping, duplicate candidates ...
 * accept/edit/ignore." Messages arrive from the phone, the rules read them in microseconds, the
 * model takes the remainder when it is reachable, and everything that could touch money stops here
 * for a decision.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const review = createReviewService({ db: requireDb(), service });
  // `?apart=evt_a,evt_b`: pairings the owner said were wrong. In the URL, so it needs no storage
  // and disappears by itself once those messages are dealt with.
  const params = await searchParams;
  const apart = new Set((typeof params.apart === "string" ? params.apart : "").split(",").filter(Boolean).slice(0, 40));
  const cards = review.listOpen(40, apart);
  const counts = currentProcessor()?.counts() ?? { staged: 0, waitingForModel: 0, openReviews: cards.length };
  const when = (instant: number) => new Date(instant).toLocaleString("en-GB", { timeZone: service.zone, dateStyle: "medium", timeStyle: "short" });

  const messages: ReviewMessage[] = cards.map((card) => ({
    eventId: card.eventId,
    kind: card.kind,
    kindLabel: KIND_LABELS[card.kind] ?? card.kind,
    postable: card.postable,
    sender: card.sender,
    receivedLabel: when(card.receivedAt),
    sourceText: card.sourceText,
    amountText: card.amount ? formatMoney(card.amount) : null,
    amountBare: card.amount ? formatMoney(card.amount, { withCode: false }) : null,
    amountValue: card.amount ? formatMoney(card.amount, { withCode: false, grouping: false }) : "",
    currency: card.amount?.currency.code ?? null,
    merchantText: card.merchantText,
    accountHint: card.accountHint,
    occurredOn: card.occurredOn ?? localDateOf(card.receivedAt, service.zone),
    flags: card.flags,
    engine: card.engine,
    modelName: card.modelName,
    suggestedAccountId: card.suggestedAccountId,
    suggestedCategoryId: card.suggestedCategoryId,
    possibleDuplicate: card.possibleDuplicate,
    pairedWith: card.pairedWith,
    balanceCheck: card.balanceCheck
      ? {
          accountName: card.balanceCheck.accountName,
          reported: formatMoney(card.balanceCheck.reported),
          projected: formatMoney(card.balanceCheck.projected),
          difference:
            card.balanceCheck.reported.minor === card.balanceCheck.projected.minor
              ? null
              : formatMoney(
                  { currency: card.balanceCheck.reported.currency, minor: card.balanceCheck.reported.minor - card.balanceCheck.projected.minor },
                  { signed: true },
                ),
        }
      : null,
    splitHref: card.pairedWith ? `/review?apart=${[...apart, card.eventId, card.pairedWith.eventId].join(",")}` : null,
  }));

  const data: ReviewData = {
    messages,
    counts,
    checking: backgroundStatus().active,
    today: localDateOf(Date.now(), service.zone),
    accounts: service
      .listAccounts()
      .filter((a) => a.isUserVisible)
      .map((a) => ({ id: a.id, name: a.name, currency: a.currency.code })),
    categories: service.listCategories().map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
  };

  return <ReviewView data={data} />;
}
