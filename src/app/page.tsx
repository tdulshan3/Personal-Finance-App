import Link from "next/link";
import { redirect } from "next/navigation";

import type { Money } from "../core/domain/money.ts";
import { formatMoney, requireCurrency } from "../core/domain/money.ts";
import { createCardDueService } from "../core/services/card-dues.ts";
import { createDashboardService, resolvePeriod } from "../core/services/dashboard-service.ts";
import { localDateOf } from "../core/domain/time.ts";
import { backgroundStatus, currentProcessor } from "../server/background.ts";
import { currentVault, requireDb, requireService, unlockedSince } from "../server/runtime.ts";
import { accessState } from "../server/session.ts";
import { Donut, FlowBars, TrendLine, chartColor } from "../ui/charts.tsx";
import { QuickLinks } from "../ui/navigation.tsx";
import { labelForAccountType, labelForKind } from "../ui/labels.ts";
import { Amount, Badge, Card, Columns, EmptyState, List, ListRow, PageHeader, Shell, Stack, Stat } from "../ui/primitives.tsx";
import styles from "./dashboard.module.css";
import { LockButton } from "./lock-button.tsx";

export const dynamic = "force-dynamic";

/**
 * Home: the dashboard.
 *
 * buildspec.md §13 requires: "Liquid balance, amount owed, current-period spending, upcoming bills,
 * suggested savings, source health, unresolved review count, recent transactions." Bills and
 * savings belong to later milestones, so they appear as an honest "still to come" note rather than
 * as zeroes that look like real answers.
 *
 * Every figure and every chart is computed by `dashboard-service` from journal entries, so a
 * transfer or a card payment is never counted as spending and a refund never as income. The period
 * lives in the URL (`?period=`), which keeps this a server component: a live refresh redraws the
 * charts with no client code, and the chosen period survives a reload.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const today = localDateOf(Date.now(), service.zone);

  const params = await searchParams;
  const period = resolvePeriod(typeof params.period === "string" ? params.period : undefined, today);
  const dash = createDashboardService({ db: requireDb() });
  const currency = requireCurrency(currentVault()?.currency ?? "LKR");
  const otherCurrencies = dash.activeCurrencies().filter((code) => code !== currency.code);

  const now = dash.totals(currency, period.from, period.to);
  const before = dash.totals(currency, period.previous.from, period.previous.to);
  const spendingByCategory = dash.byCategory(currency, period.from, period.to, "expense");
  const incomeBySource = dash.byCategory(currency, period.from, period.to, "income");
  const flow = dash.monthlyFlow(currency, today, 6);
  const merchants = dash.topMerchants(currency, period.from, period.to, 5);
  const cumulative = (days: { amount: Money }[]) => {
    let running = 0;
    return days.map((day) => (running += Number(day.amount.minor)));
  };
  const trendNow = cumulative(dash.dailySpending(currency, period.from, period.to));
  const trendBefore = cumulative(dash.dailySpending(currency, period.previous.from, period.previous.to));

  // Six named slices at most; the tail is grouped so the ring stays readable.
  const topCategories = spendingByCategory.slice(0, 6);
  const restMinor = spendingByCategory.slice(6).reduce((sum, row) => sum + row.amount.minor, 0n);
  const savingsRate = now.income.minor > 0n ? Math.round((Number(now.net.minor) / Number(now.income.minor)) * 100) : null;
  const hasFlow = flow.some((m) => m.income.minor !== 0n || m.spending.minor !== 0n);
  const dayCount = Math.max(trendNow.length, 1);

  const recent = service.searchTransactions({ limit: 6 });
  const categories = new Map(service.listCategories(true).map((c) => [c.id, c.name]));
  const nameOf = (id: string) => categories.get(id) ?? id;
  const unlockedAt = unlockedSince();
  const accounts = service.accountBalances().filter((row) => row.account.isUserVisible);
  const inbox = currentProcessor()?.counts() ?? { staged: 0, waitingForModel: 0, openReviews: 0 };
  const capture = backgroundStatus();

  /*
   * Total balance, per currency: every account the owner holds, less what is on their cards. The
   * unused part of a credit limit is shown beside it but never added in — it is the bank's money,
   * and counting it would make the total rise every time a limit is raised (buildspec.md §10).
   */
  const byCurrency = new Map<string, { assets: bigint; owed: bigint; available: bigint; hasCards: boolean; hasLimit: boolean }>();
  for (const { account, balance, available } of accounts) {
    const slot = byCurrency.get(account.currency.code) ?? { assets: 0n, owed: 0n, available: 0n, hasCards: false, hasLimit: false };
    if (account.kind === "liability") {
      slot.owed += balance.minor;
      slot.hasCards = true;
      if (available) {
        slot.available += available.minor;
        slot.hasLimit = true;
      }
    } else if (account.kind === "asset") slot.assets += balance.minor;
    byCurrency.set(account.currency.code, slot);
  }
  const worth = [...byCurrency.entries()].map(([code, slot]) => {
    const unit = requireCurrency(code);
    return {
      code,
      total: { currency: unit, minor: slot.assets - slot.owed },
      assets: { currency: unit, minor: slot.assets },
      owed: { currency: unit, minor: slot.owed },
      available: slot.hasLimit ? { currency: unit, minor: slot.available } : null,
      hasCards: slot.hasCards,
    };
  });
  const cardDues = createCardDueService({ db: requireDb(), service }).list(today).filter((due) => due.owed.minor > 0n);

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

      <Card tone="glass">
        {worth.length === 0 ? (
          <Stat label="Total balance" value={<span style={{ color: "var(--text-secondary)" }}>No accounts yet</span>} />
        ) : (
          <div style={{ display: "grid", gap: "var(--space-5)" }}>
            {/* buildspec.md §9.1: currencies are reported separately, never summed. */}
            {worth.map((row) => (
              <div key={row.code} style={{ display: "grid", gap: "var(--space-4)" }}>
                <Stat
                  label="Total balance"
                  value={<Amount value={row.total} emphasis="large" srLabel="total balance across all accounts" />}
                  hint={row.owed.minor > 0n ? "Everything in your accounts, less what is on your cards." : "Everything in your accounts."}
                />
                <div className={styles.split}>
                  <div>
                    <span className={styles.kpiLabel}>In accounts</span>
                    <Amount value={row.assets} srLabel="in accounts" />
                  </div>
                  {row.hasCards ? (
                    <div>
                      <span className={styles.kpiLabel}>On credit cards</span>
                      <Amount value={row.owed} srLabel="current balance on credit cards" />
                    </div>
                  ) : null}
                  {row.available ? (
                    <div>
                      <span className={styles.kpiLabel}>Credit available</span>
                      <Amount value={row.available} emphasis="muted" srLabel="credit still available" />
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <nav aria-label="Period" className={styles.segments}>
        {([["month", "This month"], ["last", "Last month"], ["3m", "3 months"], ["year", "This year"]] as const).map(([key, label]) => (
          <Link key={key} href={key === "month" ? "/" : `/?period=${key}`} scroll={false} className={styles.segment} aria-current={period.key === key ? "true" : undefined}>
            {label}
          </Link>
        ))}
      </nav>

      <section className={styles.kpis} aria-label={`Summary, ${period.label.toLowerCase()}`}>
        <Kpi label="Income" color="var(--chart-income)" value={now.income} delta={describeChange(now.income.minor, before.income.minor, "up-is-good", period.previous.label)} />
        <Kpi label="Spending" color="var(--chart-spending)" value={now.spending} delta={describeChange(now.spending.minor, before.spending.minor, "down-is-good", period.previous.label)} />
        <Kpi
          label={now.net.minor < 0n ? "Overspent" : "Left over"}
          value={now.net}
          delta={{ text: now.net.minor < 0n ? "Spending is ahead of income" : "Income minus spending", tone: now.net.minor < 0n ? "bad" : "neutral" }}
        />
        <div className={styles.kpi}>
          <span className={styles.kpiLabel}>Savings rate</span>
          <span className={styles.kpiValue}>{savingsRate === null ? "—" : `${savingsRate}%`}</span>
          <span className={styles.kpiDelta}>{savingsRate === null ? "Needs recorded income" : "Of income not spent"}</span>
        </div>
      </section>

      {otherCurrencies.length > 0 ? (
        <p className={styles.insight} style={{ margin: 0 }}>
          Charts show {currency.code}. You also have activity in {otherCurrencies.join(", ")}, which is never added to it.
        </p>
      ) : null}

      {/*
        Desktop: the ledger on the left, what needs attention on the right. On a phone the two
        stacks dissolve into one list, and `order` keeps the sequence it always had: balance, then
        anything to review, then shortcuts, then the detail.
      */}
      <Columns layout="main-aside">
        <Stack>
          <QuickLinks order={-1} />

          <Card order={1} title="Cash flow" action={<span className={styles.kpiDelta}>Last 6 months</span>}>
            {hasFlow ? (
              <>
                <FlowBars
                  summary={`Income and spending for the last six months. ${period.label}: income ${formatMoney(now.income)}, spending ${formatMoney(now.spending)}.`}
                  months={flow.map((m) => ({
                    label: new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
                    income: Number(m.income.minor),
                    spending: Number(m.spending.minor),
                    incomeText: formatMoney(m.income),
                    spendingText: formatMoney(m.spending),
                  }))}
                />
                <div className={styles.chartKey}>
                  <span><i className={styles.dot} style={{ background: "var(--chart-income)" }} />Income</span>
                  <span><i className={styles.dot} style={{ background: "var(--chart-spending)" }} />Spending</span>
                </div>
              </>
            ) : (
              <p className={styles.insight} style={{ marginTop: 0 }}>
                Nothing recorded yet. Income and spending will be charted here month by month.
              </p>
            )}
          </Card>

          <Card
            order={2}
            title="Where it went"
            action={<span className={styles.kpiDelta}>{period.from} to {period.to}</span>}
          >
            {spendingByCategory.length === 0 ? (
              <p className={styles.insight} style={{ marginTop: 0 }}>No spending recorded {period.label.toLowerCase()}.</p>
            ) : (
              <div className={styles.breakdown}>
                <Donut
                  summary={`Spending by category, ${period.label.toLowerCase()}. Largest: ${nameOf(topCategories[0]!.categoryId)} at ${formatMoney(topCategories[0]!.amount)}.`}
                  slices={[
                    ...topCategories.map((row, index) => ({ label: nameOf(row.categoryId), value: Number(row.amount.minor), color: chartColor(index), text: formatMoney(row.amount) })),
                    ...(restMinor > 0n ? [{ label: "Everything else", value: Number(restMinor), color: "var(--chart-8)", text: formatMoney({ currency, minor: restMinor }) }] : []),
                  ]}
                >
                  <span className={styles.centreLabel}>Spent</span>
                  <span className={styles.centreValue}>{formatMoney(now.spending, { withCode: false })}</span>
                </Donut>
                <ul className={styles.legend}>
                  {[...topCategories, ...(restMinor > 0n ? [{ categoryId: "__rest", amount: { currency, minor: restMinor } }] : [])].map((row, index) => {
                    const share = now.spending.minor > 0n ? Math.round((Number(row.amount.minor) / Number(now.spending.minor)) * 100) : 0;
                    const color = row.categoryId === "__rest" ? "var(--chart-8)" : chartColor(index);
                    const label = row.categoryId === "__rest" ? "Everything else" : nameOf(row.categoryId);
                    return (
                      <li key={row.categoryId} className={styles.legendRow}>
                        <i className={styles.dot} style={{ background: color }} />
                        {row.categoryId === "__rest" ? (
                          <span className={styles.legendName}>{label}</span>
                        ) : (
                          <Link className={styles.legendName} href={`/transactions?category=${encodeURIComponent(row.categoryId)}&from=${period.from}&to=${period.to}`}>
                            {label}
                          </Link>
                        )}
                        <span className={styles.legendAmount}>
                          {formatMoney(row.amount, { withCode: false })}
                          <span className={styles.legendShare}>{share}%</span>
                        </span>
                        <span className={styles.track}><span className={styles.fill} style={{ width: `${Math.max(share, 1)}%`, background: color }} /></span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Card>

          <Card order={3} title="Spending pace" action={<span className={styles.kpiDelta}>Running total</span>}>
            <TrendLine
              current={trendNow}
              previous={trendBefore}
              summary={`Running total of spending ${period.label.toLowerCase()}: ${formatMoney(now.spending)}, against ${formatMoney(before.spending)} for ${period.previous.label}.`}
            />
            <div className={styles.chartKey}>
              <span><i className={styles.dot} style={{ background: "var(--chart-spending)" }} />{period.label}</span>
              <span><i className={styles.dash} />{period.previous.label}</span>
            </div>
            <p className={styles.insight}>
              About <strong>{formatMoney({ currency, minor: now.spending.minor / BigInt(dayCount) })}</strong> a day on average over {dayCount} day{dayCount === 1 ? "" : "s"}.
            </p>
          </Card>

          <Card
            order={6}
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

          {cardDues.length > 0 ? (
            <Card order={0} title="Upcoming" action={<Link href="/bills">Bills</Link>}>
              <List>
                {cardDues.map((due) => (
                  <ListRow
                    key={due.account.id}
                    href="/bills"
                    subtitle={due.dueOn ? `Card payment · due ${due.dueOn}${due.daysLeft !== null ? ` · ${due.daysLeft} days` : ""}` : "Card payment · next month · set the due day"}
                    trailing={<Amount value={due.owed} srLabel="owed" />}
                  >
                    {due.account.name}
                  </ListRow>
                ))}
              </List>
            </Card>
          ) : null}

          <Card order={4} title="Top merchants" action={<span className={styles.kpiDelta}>{period.label}</span>}>
            {merchants.length === 0 ? (
              <p className={styles.insight} style={{ marginTop: 0 }}>No named merchants {period.label.toLowerCase()}.</p>
            ) : (
              <List>
                {merchants.map((row) => (
                  <ListRow
                    key={row.merchant}
                    href={`/transactions?q=${encodeURIComponent(row.merchant)}&from=${period.from}&to=${period.to}`}
                    subtitle={`${row.times} transaction${row.times === 1 ? "" : "s"}`}
                    trailing={<Amount value={row.amount} srLabel="spent at" />}
                  >
                    {row.merchant}
                  </ListRow>
                ))}
              </List>
            )}
          </Card>

          <Card order={5} title="Income sources" action={<span className={styles.kpiDelta}>{period.label}</span>}>
            {incomeBySource.length === 0 ? (
              <p className={styles.insight} style={{ marginTop: 0 }}>No income recorded {period.label.toLowerCase()}.</p>
            ) : (
              <ul className={styles.legend}>
                {incomeBySource.slice(0, 5).map((row) => {
                  const share = now.income.minor > 0n ? Math.round((Number(row.amount.minor) / Number(now.income.minor)) * 100) : 0;
                  return (
                    <li key={row.categoryId} className={styles.legendRow}>
                      <i className={styles.dot} style={{ background: "var(--chart-income)" }} />
                      <span className={styles.legendName}>{nameOf(row.categoryId)}</span>
                      <span className={styles.legendAmount}>
                        {formatMoney(row.amount, { withCode: false })}
                        <span className={styles.legendShare}>{share}%</span>
                      </span>
                      <span className={styles.track}><span className={styles.fill} style={{ width: `${Math.max(share, 1)}%`, background: "var(--chart-income)" }} /></span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card order={7} title="Accounts" action={<Link href="/accounts">Manage</Link>}>
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

          <Card order={8} title="Message capture">
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

type Delta = { text: string; tone: "good" | "bad" | "neutral" };

/** "12% less than the same days last month" — a direction in words, never colour alone (§13). */
function describeChange(current: bigint, previous: bigint, sense: "up-is-good" | "down-is-good", against: string): Delta {
  if (previous === 0n) return { text: current === 0n ? "Nothing recorded yet" : `Nothing in ${against} to compare`, tone: "neutral" };
  const percent = Math.round((Number(current - previous) / Number(previous)) * 100);
  if (percent === 0) return { text: `Level with ${against}`, tone: "neutral" };
  const up = percent > 0;
  return {
    text: `${Math.abs(percent)}% ${up ? "more" : "less"} than ${against}`,
    tone: up === (sense === "up-is-good") ? "good" : "bad",
  };
}

function Kpi({ label, value, delta, color }: { label: string; value: Money; delta: Delta; color?: string }) {
  return (
    <div className={styles.kpi}>
      <span className={styles.kpiLabel}>
        {color ? <i className={styles.dot} style={{ background: color }} /> : null}
        {label}
      </span>
      <span className={styles.kpiValue}>
        <span className={styles.kpiCode}>{value.currency.code}</span>
        {formatMoney(value.minor < 0n ? { currency: value.currency, minor: -value.minor } : value, { withCode: false })}
      </span>
      <span className={delta.tone === "neutral" ? styles.kpiDelta : `${styles.kpiDelta} ${delta.tone === "good" ? styles.good : styles.bad}`}>{delta.text}</span>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

