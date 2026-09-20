import Link from "next/link";
import { redirect } from "next/navigation";

import { formatMoney } from "../core/domain/money.ts";
import { localDateOf, parseLocalDate, toLocalDate } from "../core/domain/time.ts";
import { backgroundStatus, currentProcessor } from "../server/background.ts";
import { requireService, unlockedSince } from "../server/runtime.ts";
import { accessState } from "../server/session.ts";
import { QuickLinks } from "../ui/navigation.tsx";
import { labelForAccountType, labelForKind } from "../ui/labels.ts";
import { Amount, Badge, Card, Columns, EmptyState, List, ListRow, PageHeader, Shell, Stack, Stat } from "../ui/primitives.tsx";
import { LockButton } from "./lock-button.tsx";

export const dynamic = "force-dynamic";

/**
 * Home.
 *
 * buildspec.md §13 requires: "Liquid balance, amount owed, current-period spending, upcoming bills,
 * suggested savings, source health, unresolved review count, recent transactions." Bills and
 * savings belong to later milestones, so they appear as an honest "still to come" note rather than
 * as zeroes that look like real answers.
 */
export default async function HomePage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const totals = service.homeTotals();
  const today = localDateOf(Date.now(), service.zone);
  const { year, month } = parseLocalDate(today);
  const monthStart = toLocalDate(year, month, 1);
  const spending = service.spendingByCategory(monthStart, today);
  const recent = service.searchTransactions({ limit: 6 });
  const categories = new Map(service.listCategories().map((c) => [c.id, c.name]));
  const unlockedAt = unlockedSince();
  const accounts = service.accountBalances().filter((row) => row.account.isUserVisible);
  const inbox = currentProcessor()?.counts() ?? { staged: 0, waitingForModel: 0, openReviews: 0 };
  const capture = backgroundStatus();

  const liquidEntries = [...totals.liquid.entries()];
  const owedEntries = [...totals.owed.entries()].filter(([, value]) => value.minor !== 0n);

  return (
    <Shell>
      <PageHeader
        title={greeting()}
        subtitle={
          unlockedAt
            ? `Unlocked at ${new Date(unlockedAt).toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: service.zone,
              })}`
            : undefined
        }
        // The desktop sidebar carries Lock; repeating it here would put two on one screen.
        action={
          <span className="phone-only">
            <LockButton />
          </span>
        }
      />

      {/*
        Desktop: the ledger on the left, what needs attention on the right. On a phone the two
        stacks dissolve into one list, and `order` keeps the sequence it always had: balance, then
        anything to review, then shortcuts, then the detail.
      */}
      <Columns layout="main-aside">
        <Stack>
          <Card tone="glass" order={-3}>
            <div style={{ display: "grid", gap: "var(--space-5)" }}>
              <Stat
                label="Recorded liquid money"
                value={
                  liquidEntries.length === 0 ? (
                    <span style={{ color: "var(--text-secondary)" }}>No accounts yet</span>
                  ) : (
                    /* buildspec.md §9.1: currencies are reported separately, never summed. */
                    <div style={{ display: "grid", gap: "var(--space-1)" }}>
                      {liquidEntries.map(([code, value]) => (
                        <Amount key={code} value={value} emphasis="large" srLabel="liquid balance" />
                      ))}
                    </div>
                  )
                }
                hint="Cash and current accounts. Savings and credit limits are not included."
              />

              {owedEntries.length > 0 ? (
                <Stat
                  label="Amount owed"
                  value={
                    <div style={{ display: "grid", gap: "var(--space-1)" }}>
                      {owedEntries.map(([code, value]) => (
                        <Amount key={code} value={value} srLabel="amount owed" />
                      ))}
                    </div>
                  }
                  hint="Credit cards and loans."
                />
              ) : null}
            </div>
          </Card>

          <QuickLinks order={-1} />

          <Card
            order={2}
            title="This month"
            action={
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                {monthStart} to {today}
              </span>
            }
          >
            {spending.length === 0 ? (
              <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                No spending recorded this month.
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-3)" }}>
                {spending.slice(0, 6).map((row) => (
                  <li
                    key={`${row.categoryId}-${row.amount.currency.code}`}
                    style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-4)" }}
                  >
                    <span>{categories.get(row.categoryId) ?? row.categoryId}</span>
                    <Amount value={row.amount} srLabel="spent" />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            order={3}
            title="Recent activity"
            action={<Link href="/transactions">See all</Link>}
          >
            {recent.length === 0 ? (
              <EmptyState
                title="Nothing recorded yet"
                body="Add your accounts and a first transaction, or connect message capture later."
                action={<Link href="/transactions/new">Add a transaction</Link>}
              />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-4)" }}>
                {recent.map((item) => (
                  <li
                    key={item.id}
                    style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-4)" }}
                  >
                    <div style={{ display: "grid", gap: "2px", minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.merchantName ?? labelForKind(item.kind)}
                      </span>
                      <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {/* Only a label that adds something: "Opening balance · Opening balance" does not. */}
                        {[categories.get(item.categoryId ?? "") ?? (item.merchantName ? labelForKind(item.kind) : null), item.occurredLocalDate]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    <Amount value={item.amount} srLabel={labelForKind(item.kind)} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

        </Stack>

        <Stack>
          {inbox.openReviews > 0 ? (
            <Card tone="glass" order={-2}>
              <Link
                href="/review"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-4)", textDecoration: "none", color: "inherit", minHeight: "var(--touch-target)" }}
              >
                <span style={{ display: "grid", gap: "2px" }}>
                  <strong>
                    {inbox.openReviews} message{inbox.openReviews === 1 ? "" : "s"} to review
                  </strong>
                  <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                    Read from your bank messages. Nothing is recorded until you accept it.
                  </span>
                </span>
                <Badge tone="primary">Review</Badge>
              </Link>
            </Card>
          ) : null}

          <Card order={1} title="Accounts" action={<Link href="/accounts">Manage</Link>}>
            {accounts.length === 0 ? (
              <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                No accounts yet. <Link href="/accounts">Add your first one</Link>.
              </p>
            ) : (
              <List>
                {accounts.map(({ account, balance, available }) => (
                  <ListRow
                    key={account.id}
                    subtitle={
                      available
                        ? `${labelForAccountType(account.type)} · ${formatMoney(available)} available`
                        : labelForAccountType(account.type)
                    }
                    // A card's figure is what is currently on it, never added to spendable money (§10).
                    trailing={<Amount value={balance} srLabel={account.kind === "liability" ? "current balance on" : "balance of"} />}
                  >
                    {account.name}
                  </ListRow>
                ))}
              </List>
            )}
          </Card>

          <Card order={4} title="Message capture">
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {capture.active ? <Badge tone="success">Checking every minute</Badge> : <Badge tone="warning">Paused</Badge>}
              {inbox.staged > 0 ? <Badge>{inbox.staged} not read yet</Badge> : null}
              {inbox.waitingForModel > 0 ? <Badge tone="warning">{inbox.waitingForModel} waiting for the model</Badge> : null}
              {inbox.openReviews === 0 && inbox.staged === 0 ? <Badge>All caught up</Badge> : null}
            </div>
            <p style={{ marginTop: "var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              Still to come: bills and reminders, forecasts and savings, Gmail. Nothing above depends on them.
            </p>
          </Card>
        </Stack>
      </Columns>
    </Shell>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

