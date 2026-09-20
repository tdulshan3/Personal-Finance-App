import Link from "next/link";
import { redirect } from "next/navigation";

import { localDateOf, parseLocalDate, toLocalDate } from "../core/domain/time.ts";
import { requireService, unlockedSince } from "../server/runtime.ts";
import { accessState } from "../server/session.ts";
import { QuickLinks } from "../ui/navigation.tsx";
import { labelForKind } from "../ui/labels.ts";
import { Amount, Badge, Card, EmptyState, PageHeader, Shell, Stat } from "../ui/primitives.tsx";
import { LockButton } from "./lock-button.tsx";

export const dynamic = "force-dynamic";

/**
 * Home.
 *
 * buildspec.md §13 requires: "Liquid balance, amount owed, current-period spending, upcoming bills,
 * suggested savings, source health, unresolved review count, recent transactions." Bills, savings
 * and source health belong to later milestones, so they appear as honest "not built yet" tiles
 * rather than as zeroes that look like real answers.
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
        action={<LockButton />}
      />

      <Card tone="glass">
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

      <QuickLinks />

      <Card
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
                  <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                    {categories.get(item.categoryId ?? "") ?? labelForKind(item.kind)} ·{" "}
                    {item.occurredLocalDate}
                  </span>
                </div>
                <Amount value={item.amount} srLabel={labelForKind(item.kind)} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Milestones M4-M6. Stated as not built rather than shown as an empty real value. */}
      <Card title="Not built yet">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          <Badge>Bills and reminders</Badge>
          <Badge>Forecast and savings</Badge>
          <Badge>Message capture</Badge>
          <Badge>Assistant</Badge>
        </div>
        <p
          style={{
            marginTop: "var(--space-3)",
            fontSize: "var(--font-sm)",
            color: "var(--text-secondary)",
          }}
        >
          These are the next milestones. Nothing above depends on them.
        </p>
      </Card>
    </Shell>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

