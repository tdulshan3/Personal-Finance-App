import { redirect } from "next/navigation";

import { formatMoney } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { createReviewService } from "../../ingestion/review-service.ts";
import { backgroundStatus, currentProcessor } from "../../server/background.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { Badge, Card, EmptyState, PageHeader, Shell } from "../../ui/primitives.tsx";
import { ProcessButton } from "./process-button.tsx";
import type { ReviewCardData } from "./review-card.tsx";
import { ReviewCard } from "./review-card.tsx";
import styles from "./review.module.css";

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
  const status = backgroundStatus();
  const today = localDateOf(Date.now(), service.zone);

  const accounts = service.listAccounts().map((a) => ({ id: a.id, name: a.name, currency: a.currency.code }));
  const categories = service.listCategories().map((c) => ({ id: c.id, name: c.name }));

  const toData = (card: (typeof cards)[number]): ReviewCardData => ({
    eventId: card.eventId,
    kind: card.kind,
    kindLabel: KIND_LABELS[card.kind] ?? card.kind,
    postable: card.postable,
    sender: card.sender,
    receivedLabel: new Date(card.receivedAt).toLocaleString("en-GB", { timeZone: service.zone, dateStyle: "medium", timeStyle: "short" }),
    sourceText: card.sourceText,
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
    splitHref: card.pairedWith ? `/review?apart=${[...apart, card.eventId, card.pairedWith.eventId].join(",")}` : null,
  });

  return (
    <Shell>
      <PageHeader title="Review" subtitle="Messages become transactions only when you say so." />

      <Card>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
          <Badge tone={cards.length > 0 ? "primary" : "neutral"}>{cards.length} to review</Badge>
          {counts.staged > 0 ? <Badge>{counts.staged} not read yet</Badge> : null}
          {counts.waitingForModel > 0 ? (
            <Badge tone="warning">{counts.waitingForModel} waiting for the model</Badge>
          ) : null}
          {status.active ? <Badge tone="success">Checking every minute</Badge> : <Badge tone="warning">Background checks off</Badge>}
        </div>
        <ProcessButton />
      </Card>

      {cards.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing to review"
            body={
              accounts.length === 0
                ? "Add an account first, then messages from the senders you enabled will appear here."
                : "New messages from the senders you enabled in Settings appear here within moments of arriving."
            }
          />
        </Card>
      ) : (
        <ul className={styles.grid} role="list">
          {cards.map((card) => (
            <ReviewCard key={card.eventId} data={toData(card)} accounts={accounts} categories={categories} today={today} />
          ))}
        </ul>
      )}
    </Shell>
  );
}
