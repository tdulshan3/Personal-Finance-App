import { redirect } from "next/navigation";

import { formatMoney } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { createCardDueService } from "../../core/services/card-dues.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { labelForAccountType } from "../../ui/labels.ts";
import { Amount, Badge, ButtonLink, Card, Columns, EmptyState, PageHeader, Shell, Stack } from "../../ui/primitives.tsx";
import { DueDayForm } from "./due-day-form.tsx";

export const dynamic = "force-dynamic";

const longDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Bills: for now, what is owed on each credit card and when.
 *
 * This month's card spending is billed and paid next month, so each card shows one payment falling
 * due next month for its current balance. The figure comes from the ledger and grows as spending
 * is recorded. Paying it is an ordinary transfer into the card — "Record payment" opens that form
 * filled in — which the ledger never counts as spending (buildspec.md §9.2).
 */
export default async function BillsPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const today = localDateOf(Date.now(), service.zone);
  const dues = createCardDueService({ db: requireDb(), service }).list(today);

  return (
    <Shell>
      <PageHeader title="Bills" subtitle="What you owe on your cards, and when it falls due." />

      <Columns layout="main-aside">
        <Stack>
          {dues.length === 0 ? (
            <Card>
              <EmptyState
                title="No credit cards yet"
                body="Add a credit card on the Accounts screen and its payment will appear here, growing as you record spending on it."
                action={<ButtonLink href="/accounts">Go to Accounts</ButtonLink>}
              />
            </Card>
          ) : (
            dues.map((due) => {
              const owes = due.owed.minor > 0n;
              return (
                <Card
                  key={due.account.id}
                  title={due.account.name}
                  action={
                    !owes ? <Badge tone="success">Nothing owed</Badge>
                    : due.daysLeft === null ? <Badge tone="warning">No due day</Badge>
                    : <Badge tone={due.daysLeft <= 7 ? "warning" : "primary"}>Due in {due.daysLeft} day{due.daysLeft === 1 ? "" : "s"}</Badge>
                  }
                >
                  <div style={{ display: "grid", gap: "var(--space-4)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--space-4)", flexWrap: "wrap" }}>
                      <div style={{ display: "grid", gap: "2px" }}>
                        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                          {owes ? (due.dueOn ? `Payment due ${longDate(due.dueOn)}` : "Payment due next month") : labelForAccountType(due.account.type)}
                        </span>
                        <Amount value={due.owed} emphasis="large" srLabel="owed on this card" />
                      </div>
                      {owes ? (
                        <ButtonLink href={`/transactions/new?kind=transfer&to=${encodeURIComponent(due.account.id)}&amount=${formatMoney(due.owed, { withCode: false, grouping: false })}`}>
                          Record payment
                        </ButtonLink>
                      ) : null}
                    </div>
                    <DueDayForm accountId={due.account.id} accountName={due.account.name} dueDay={due.dueDay} />
                  </div>
                </Card>
              );
            })
          )}
        </Stack>

        <Stack>
          <Card title="How this works">
            <ul style={{ margin: 0, paddingLeft: "1.1em", display: "grid", gap: "var(--space-2)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              <li>What you spend on a card this month is due next month, so each card shows one payment for its current balance.</li>
              <li>The amount is your recorded balance, not a statement figure. If your statement says something different, the difference is spending or a payment that is not recorded yet.</li>
              <li>Recording a payment moves money from a bank account into the card. It is a transfer, never counted as spending twice.</li>
              <li>Still to come: utility bills, reminders and recurring payments.</li>
            </ul>
          </Card>
        </Stack>
      </Columns>
    </Shell>
  );
}
