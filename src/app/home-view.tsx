"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";

import type { Money } from "../core/domain/money.ts";
import { BarList, ColumnChart, LineChart } from "../ui/charts.tsx";
import { bare, compact, money, monthShort, plural, shortDate, signedAmount, weekdayDate } from "../ui/format.ts";
import { useFrame } from "../ui/frame.tsx";
import { BarButton, Grid as IosGrid, List as IosList, ListHeaderAction, ListRow, ListSection, SegmentedControl as IosSegmented } from "../ui/ios/ios.tsx";
import { IosCard, IosFacts, IosNote, IosReading, READABLE_MARGIN } from "../ui/ios-parts.tsx";
import type { IconName } from "../ui/labels.ts";
import { iconForAccountType, labelForAccountType } from "../ui/labels.ts";
import { usePhone } from "../ui/look.tsx";
import { Button, Form, FormRow, FormSection, Grid, Section, SegmentedControl, Table, Tile, ToolbarButton } from "../ui/macos/macos.tsx";
import type { TableColumn } from "../ui/macos/macos.tsx";
import type { Tone } from "../ui/page.tsx";
import { IosPage, MacPage, Secondary, Status } from "../ui/page.tsx";

export type Attention = { key: string; icon: IconName; tone: Tone; title: string; detail: string; href: string };

export type HomeData = {
  today: string;
  unlockedAt: string | null;
  period: { key: string; label: string; from: string; to: string; previousLabel: string };
  currency: string;
  digits: number;
  otherCurrencies: string[];
  worth: { code: string; total: Money; assets: Money; owed: Money; available: Money | null; hasCards: boolean }[];
  totals: { income: Money; spending: Money; net: Money };
  previous: { income: Money; spending: Money; net: Money };
  savingsRate: number | null;
  flow: { month: string; income: Money; spending: Money }[];
  categories: { id: string; name: string; amount: Money; share: number }[];
  merchants: { merchant: string; amount: Money; times: number }[];
  trend: { current: bigint[]; previous: bigint[] };
  dailyAverage: Money;
  dayCount: number;
  recent: { id: string; kind: string; title: string; category: string | null; icon: IconName | null; date: string; amount: Money }[];
  accounts: { id: string; name: string; type: string; kind: string; balance: Money; available: Money | null }[];
  inbox: { staged: number; waitingForModel: number; openReviews: number };
  captureActive: boolean;
  attention: Attention[];
  upcoming: { key: string; name: string; date: string; amount: Money; days: number; when: string; direction: "in" | "out" }[];
  plan: { canSetAside: Money; monthEnd: Money; lowest: { date: string; amount: Money }; confidence: string; daysToMonthEnd: number };
};

const PERIODS = [
  { value: "month", label: "This Month" },
  { value: "last", label: "Last Month" },
  { value: "3m", label: "3 Months" },
  { value: "year", label: "This Year" },
];

/** "12% less than the same days last month", with its direction judged good or bad. */
function change(current: Money, previous: Money, upIsGood: boolean, against: string): { text: string; tone: Tone; icon: IconName } {
  if (previous.minor === 0n) return { text: current.minor === 0n ? "Nothing recorded yet" : `Nothing in ${against} to compare`, tone: "neutral", icon: "info-circle" };
  const percent = Math.round((Number(current.minor - previous.minor) / Number(previous.minor)) * 100);
  if (percent === 0) return { text: `Level with ${against}`, tone: "neutral", icon: "minus" };
  const up = percent > 0;
  return { text: `${Math.abs(percent)}% ${up ? "more" : "less"} than ${against}`, tone: up === upIsGood ? "good" : "bad", icon: up ? "arrow-up" : "arrow-down" };
}

function useHome(data: HomeData) {
  const router = useRouter();
  const { addTransaction } = useFrame();
  const setPeriod = (key: string) => router.push((key === "month" ? "/" : `/?period=${key}`) as Route, { scroll: false });
  const tick = (value: number) => compact(value, data.digits);
  const flowLabels = data.flow.map((m) => monthShort(m.month));
  const flowSeries = [
    { key: "income", name: "Income", color: "var(--chart-income)", values: data.flow.map((m) => Number(m.income.minor)), texts: data.flow.map((m) => money(m.income)) },
    { key: "spending", name: "Spending", color: "var(--chart-spending)", values: data.flow.map((m) => Number(m.spending.minor)), texts: data.flow.map((m) => money(m.spending)) },
  ];
  const hasFlow = data.flow.some((m) => m.income.minor !== 0n || m.spending.minor !== 0n);
  const days = Math.max(data.trend.current.length, data.trend.previous.length, 2);
  const unit = { currency: { code: data.currency, minorUnitDigits: data.digits }, minor: 0n };
  const at = (values: bigint[], index: number) => (values[index] !== undefined ? money({ ...unit, minor: values[index]! }) : undefined);
  const trendLabels = Array.from({ length: days }, (_, index) => `Day ${index + 1}`);
  const trendSeries = [
    { key: "now", name: data.period.label, color: "var(--chart-spending)", values: data.trend.current.map(Number), texts: trendLabels.map((_, i) => at(data.trend.current, i) ?? "") },
    { key: "before", name: capitalise(data.period.previousLabel), color: "var(--chart-muted)", values: data.trend.previous.map(Number), texts: trendLabels.map((_, i) => at(data.trend.previous, i) ?? ""), style: "muted" as const },
  ];
  const incomeChange = change(data.totals.income, data.previous.income, true, data.period.previousLabel);
  const spendingChange = change(data.totals.spending, data.previous.spending, false, data.period.previousLabel);
  return { router, addTransaction, setPeriod, tick, flowLabels, flowSeries, hasFlow, trendLabels, trendSeries, incomeChange, spendingChange, days };
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function HomeView({ data }: { data: HomeData }) {
  return usePhone() ? <IosHome data={data} /> : <MacHome data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

type RecentRow = HomeData["recent"][number];
type AccountRow = HomeData["accounts"][number];
type UpcomingRow = HomeData["upcoming"][number];

function MacHome({ data }: { data: HomeData }) {
  const home = useHome(data);
  const { router } = home;
  const open = (href: string) => router.push(href as Route);

  const recentColumns: TableColumn<RecentRow>[] = [
    { key: "date", title: "Date", width: 90, render: (r) => shortDate(r.date, data.today) },
    { key: "title", title: "Merchant or payer" },
    { key: "category", title: "Category", width: "26%", render: (r) => r.category ?? "--" },
    { key: "amount", title: "Amount", width: 150, numeric: true, sortValue: (r) => Number(r.amount.minor), render: (r) => signedAmount(r.kind, r.amount) },
  ];
  const accountColumns: TableColumn<AccountRow>[] = [
    { key: "name", title: "Account" },
    { key: "type", title: "Type", width: 120, render: (r) => labelForAccountType(r.type) },
    { key: "balance", title: "Balance", width: 160, numeric: true, sortValue: (r) => Number(r.balance.minor), render: (r) => money(r.balance) },
    { key: "available", title: "Available credit", width: 160, numeric: true, sortValue: (r) => Number(r.available?.minor ?? 0n), render: (r) => (r.available ? money(r.available) : "--") },
  ];
  const upcomingColumns: TableColumn<UpcomingRow>[] = [
    { key: "name", title: "Payment" },
    { key: "date", title: "Due", width: 150, render: (r) => `${shortDate(r.date, data.today)} · ${r.when}` },
    { key: "amount", title: "Amount", width: 150, numeric: true, sortValue: (r) => Number(r.amount.minor), render: (r) => signedAmount(r.direction === "in" ? "income" : "expense", r.amount) },
  ];

  return (
    <MacPage
      title="Home"
      subtitle={`${weekdayDate(data.today)}${data.unlockedAt ? ` · Unlocked at ${data.unlockedAt}` : ""}`}
      toolbar={
        <>
          <SegmentedControl label="Period" options={PERIODS} value={data.period.key} onChange={home.setPeriod} />
          <ToolbarButton icon="plus" label="New Transaction" onClick={() => home.addTransaction()} />
        </>
      }
    >
      {data.worth.length === 0 ? (
        <Section title="Balance">
          <Grid>
            <Tile label="Total balance" icon="creditcard" value={null} detail={<>No accounts yet. <a href="/accounts">Add your first one</a>.</>} />
          </Grid>
        </Section>
      ) : (
        data.worth.map((row) => (
          // buildspec.md §9.1: currencies are reported separately, never summed.
          <Section key={row.code} title={data.worth.length > 1 ? `Balance in ${row.code}` : "Balance"}>
            <Grid>
              <Tile label="Total balance" icon="creditcard" value={money(row.total)} detail={row.hasCards ? "In your accounts, less what is on your cards" : "Everything in your accounts"} />
              <Tile label="In accounts" icon="house" value={money(row.assets)} detail="Recorded balances" />
              {row.hasCards ? <Tile label="On credit cards" icon="creditcard" value={money(row.owed)} detail="Current balance, paid next month" /> : null}
              {row.available ? <Tile label="Credit available" icon="checkmark-circle-fill" value={money(row.available)} detail="Never counted as your money" /> : null}
              {row.code === data.currency ? (
                <Tile label="Could set aside" icon="archivebox" value={money(data.plan.canSetAside)} detail={<a href="/plan">Even if spending runs high · Plan</a>} />
              ) : null}
            </Grid>
          </Section>
        ))
      )}

      <Section title={data.period.label} footer={data.otherCurrencies.length > 0 ? `Figures are in ${data.currency}. Activity in ${data.otherCurrencies.join(", ")} is never added to it.` : `${shortDate(data.period.from, data.today)} to ${shortDate(data.period.to, data.today)}.`}>
        <Grid>
          <Tile label="Income" icon="arrow-down-circle" value={money(data.totals.income)} detail={<Status tone={home.incomeChange.tone} icon={home.incomeChange.icon}>{home.incomeChange.text}</Status>} />
          <Tile label="Spending" icon="cart" value={money(data.totals.spending)} detail={<Status tone={home.spendingChange.tone} icon={home.spendingChange.icon}>{home.spendingChange.text}</Status>} />
          <Tile label={data.totals.net.minor < 0n ? "Overspent" : "Left over"} icon="arrow-up-arrow-down" value={money(data.totals.net.minor < 0n ? { ...data.totals.net, minor: -data.totals.net.minor } : data.totals.net)} detail={data.totals.net.minor < 0n ? <Status tone="bad">Spending is ahead of income</Status> : "Income minus spending"} />
          <Tile
            label="Savings rate"
            icon="chart-bar"
            value={data.savingsRate === null ? null : `${data.savingsRate}%`}
            {...(data.savingsRate !== null && data.savingsRate > 0 ? { progress: Math.min(100, data.savingsRate) } : {})}
            detail={data.savingsRate === null ? "Needs recorded income" : "Of income not spent"}
          />
        </Grid>
      </Section>

      {data.attention.length > 0 ? (
        <Section title="Needs attention">
          <Form>
            <FormSection>
              {data.attention.map((item) => (
                <FormRow key={item.key} label={<Status tone={item.tone} icon={item.icon}>{item.title}</Status>} subtitle={item.detail}>
                  <Button size="small" onClick={() => open(item.href)}>Show</Button>
                </FormRow>
              ))}
            </FormSection>
          </Form>
        </Section>
      ) : null}

      <Section title="Trends">
        <Grid min={360}>
          <Tile label="Cash flow, last 6 months" icon="chart-bar">
            {home.hasFlow ? (
              <ColumnChart
                summary={`Income and spending for the last six months. ${data.period.label}: income ${money(data.totals.income)}, spending ${money(data.totals.spending)}.`}
                labels={home.flowLabels}
                series={home.flowSeries}
                tick={home.tick}
              />
            ) : (
              <Secondary>Nothing recorded yet. Income and spending will be charted here month by month.</Secondary>
            )}
          </Tile>
          <Tile label="Spending pace" icon="clock" detail={`About ${money(data.dailyAverage)} a day over ${plural(data.dayCount, "day")}.`}>
            <LineChart
              summary={`Running total of spending, ${data.period.label.toLowerCase()}: ${money(data.totals.spending)}, against ${money(data.previous.spending)} for ${data.period.previousLabel}.`}
              labels={home.trendLabels}
              series={home.trendSeries}
              tick={home.tick}
              axisLabels={[{ index: 0, text: "Day 1" }, { index: home.days - 1, text: `Day ${home.days}` }]}
              height={170}
            />
          </Tile>
          <Tile label="Where it went" icon="tag">
            {data.categories.length === 0 ? (
              <Secondary>No spending recorded {data.period.label.toLowerCase()}.</Secondary>
            ) : (
              <BarList
                label={`Spending by category, ${data.period.label.toLowerCase()}`}
                rows={data.categories.map((c) => ({
                  key: c.id || "rest",
                  name: c.name,
                  value: bare(c.amount),
                  share: c.share,
                  href: c.id ? `/transactions?category=${encodeURIComponent(c.id)}&from=${data.period.from}&to=${data.period.to}` : undefined,
                }))}
              />
            )}
          </Tile>
          <Tile label="Top merchants" icon="cart">
            {data.merchants.length === 0 ? (
              <Secondary>No named merchants {data.period.label.toLowerCase()}.</Secondary>
            ) : (
              <BarList
                label={`Top merchants, ${data.period.label.toLowerCase()}`}
                rows={data.merchants.map((m) => ({
                  key: m.merchant,
                  name: `${m.merchant} (${m.times})`,
                  value: bare(m.amount),
                  share: data.totals.spending.minor > 0n ? Number(m.amount.minor) / Number(data.totals.spending.minor) : 0,
                  href: `/transactions?q=${encodeURIComponent(m.merchant)}&from=${data.period.from}&to=${data.period.to}`,
                }))}
              />
            )}
          </Tile>
        </Grid>
      </Section>

      {data.upcoming.length > 0 ? (
        <Section title="Coming up" actions={<Button size="small" onClick={() => open("/bills")}>Bills</Button>}>
          <Tile flush>
            <Table label="Payments due in the next two weeks" columns={upcomingColumns} rows={data.upcoming} rowId={(r) => r.key} selectionMode="single" onRowAction={() => open("/bills")} />
          </Tile>
        </Section>
      ) : null}

      <Section title="Recent transactions" actions={<Button size="small" onClick={() => open("/transactions")}>See All</Button>}>
        <Tile flush>
          <Table
            label="Recent transactions"
            columns={recentColumns}
            rows={data.recent}
            rowIcon={(r) => r.icon ?? "doc-text"}
            onRowAction={(r) => open(`/transactions/${r.id}`)}
            emptyText="Nothing recorded yet. Add an account, then a first transaction."
          />
        </Tile>
      </Section>

      <Section title="Accounts" actions={<Button size="small" onClick={() => open("/accounts")}>Manage</Button>}>
        <Tile flush>
          <Table label="Accounts" columns={accountColumns} rows={data.accounts} rowIcon={(r) => iconForAccountType(r.type)} onRowAction={() => open("/accounts")} emptyText="No accounts yet." />
        </Tile>
      </Section>

      <Section title="Message capture">
        <Grid>
          <Tile label="Background checks" icon="arrow-clockwise" value={data.captureActive ? "On" : "Paused"} detail={data.captureActive ? <Status tone="good">Checking every minute</Status> : <Status tone="warning">Lock and unlock to restart</Status>} />
          <Tile label="To review" icon="tray" value={String(data.inbox.openReviews)} detail={data.inbox.openReviews > 0 ? <a href="/review">Open Review</a> : "All caught up"} />
          <Tile label="Not read yet" icon="envelope" value={String(data.inbox.staged)} detail={data.inbox.waitingForModel > 0 ? <Status tone="warning">{data.inbox.waitingForModel} waiting for the model</Status> : "Read within a minute"} />
        </Grid>
      </Section>
    </MacPage>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

const TONE_COLOR: Record<Tone, string> = { good: "green", warning: "orange", bad: "red", neutral: "blue" };

function IosHome({ data }: { data: HomeData }) {
  const home = useHome(data);
  const { router } = home;
  return (
    <IosPage
      title="Home"
      subtitle={weekdayDate(data.today)}
      trailing={<BarButton icon="plus" label="New Transaction" onClick={() => home.addTransaction()} />}
    >
      <div style={{ padding: `4px ${READABLE_MARGIN} 16px` }}>
        <IosSegmented label="Period" options={PERIODS.map((p) => ({ value: p.value, label: p.label.replace("This ", "").replace("Last Month", "Last") }))} value={data.period.key} onChange={home.setPeriod} />
      </div>

      <IosGrid>
        {data.worth.length === 0 ? (
          <IosCard icon="creditcard" title="Total Balance" color="var(--ios-blue)" href="/accounts">
            <IosNote>No accounts yet. Add the accounts you want to track.</IosNote>
          </IosCard>
        ) : (
          data.worth.map((row) => (
            <IosCard key={row.code} icon="creditcard" title={data.worth.length > 1 ? `Total Balance · ${row.code}` : "Total Balance"} color="var(--ios-blue)" href="/accounts">
              <IosReading code={row.code} value={bare(row.total)} />
              <IosFacts
                items={[
                  { label: "In accounts", value: money(row.assets) },
                  ...(row.hasCards ? [{ label: "On cards", value: money(row.owed) }] : []),
                  ...(row.available ? [{ label: "Credit available", value: money(row.available) }] : []),
                ]}
              />
            </IosCard>
          ))
        )}
        <IosCard icon="chart-bar" title={data.period.label} color="var(--ios-green)" trailing={data.savingsRate === null ? undefined : `${data.savingsRate}% saved`}>
          <IosFacts
            items={[
              { label: "Income", value: money(data.totals.income) },
              { label: "Spending", value: money(data.totals.spending) },
              { label: data.totals.net.minor < 0n ? "Overspent" : "Left over", value: money(data.totals.net.minor < 0n ? { ...data.totals.net, minor: -data.totals.net.minor } : data.totals.net) },
            ]}
          />
          <span className="ios-footnote">
            <Status tone={home.spendingChange.tone} icon={home.spendingChange.icon}>Spending {home.spendingChange.text.charAt(0).toLowerCase() + home.spendingChange.text.slice(1)}</Status>
          </span>
        </IosCard>
        <IosCard icon="archivebox" title="Could Set Aside" color="var(--ios-teal)" href="/plan">
          <IosReading code={data.currency} value={bare(data.plan.canSetAside)} size="title2" />
          <IosNote>Without going under your buffer before next month ends, even if spending runs a quarter above its usual pace.</IosNote>
        </IosCard>
      </IosGrid>

      {data.attention.length > 0 ? (
        <IosList>
          <ListSection header="Needs Attention">
            {data.attention.map((item) => (
              <ListRow key={item.key} title={item.title} subtitle={item.detail} icon={item.icon} iconColor={TONE_COLOR[item.tone]} href={item.href} />
            ))}
          </ListSection>
        </IosList>
      ) : null}

      <IosGrid title="Trends">
        <IosCard icon="chart-bar" title="Cash Flow" color="var(--ios-indigo)" trailing="6 months">
          {home.hasFlow ? (
            <ColumnChart
              summary={`Income and spending for the last six months. ${data.period.label}: income ${money(data.totals.income)}, spending ${money(data.totals.spending)}.`}
              labels={home.flowLabels}
              series={home.flowSeries}
              tick={home.tick}
              height={160}
            />
          ) : (
            <IosNote>Nothing recorded yet. Income and spending will be charted here month by month.</IosNote>
          )}
        </IosCard>
        <IosCard icon="clock" title="Spending Pace" color="var(--ios-blue)" trailing={`${money(data.dailyAverage)}/day`}>
          <LineChart
            summary={`Running total of spending, ${data.period.label.toLowerCase()}: ${money(data.totals.spending)}, against ${money(data.previous.spending)} for ${data.period.previousLabel}.`}
            labels={home.trendLabels}
            series={home.trendSeries}
            tick={home.tick}
            axisLabels={[{ index: 0, text: "Day 1" }, { index: home.days - 1, text: `Day ${home.days}` }]}
            height={150}
          />
        </IosCard>
        <IosCard icon="tag" title="Where It Went" color="var(--ios-orange)" trailing={money(data.totals.spending)}>
          {data.categories.length === 0 ? (
            <IosNote>No spending recorded {data.period.label.toLowerCase()}.</IosNote>
          ) : (
            <BarList
              label={`Spending by category, ${data.period.label.toLowerCase()}`}
              rows={data.categories.map((c) => ({
                key: c.id || "rest",
                name: c.name,
                value: bare(c.amount),
                share: c.share,
                href: c.id ? `/transactions?category=${encodeURIComponent(c.id)}&from=${data.period.from}&to=${data.period.to}` : undefined,
              }))}
            />
          )}
        </IosCard>
      </IosGrid>

      <IosList>
        {data.upcoming.length > 0 ? (
          <ListSection header="Coming Up" headerTrailing={<ListHeaderAction onClick={() => router.push("/bills")}>Bills</ListHeaderAction>}>
            {data.upcoming.map((u) => (
              <ListRow key={u.key} title={u.name} subtitle={`${shortDate(u.date, data.today)} · ${u.when}`} detail={signedAmount(u.direction === "in" ? "income" : "expense", u.amount)} href="/bills" chevron={false} />
            ))}
          </ListSection>
        ) : null}

        <ListSection header="Recent" headerTrailing={<ListHeaderAction onClick={() => router.push("/transactions")}>See All</ListHeaderAction>}>
          {data.recent.length === 0 ? (
            <ListRow title="Nothing recorded yet" subtitle="Add an account, then a first transaction." />
          ) : (
            data.recent.map((r) => (
              <ListRow key={r.id} title={r.title} subtitle={[r.category, shortDate(r.date, data.today)].filter(Boolean).join(" · ")} detail={signedAmount(r.kind, r.amount, false)} href={`/transactions/${r.id}`} />
            ))
          )}
        </ListSection>

        {data.accounts.length > 0 ? (
        <ListSection header="Accounts">
          {data.accounts.map((a) => (
            <ListRow key={a.id} title={a.name} subtitle={a.available ? `${labelForAccountType(a.type)} · ${money(a.available)} available` : labelForAccountType(a.type)} detail={bare(a.balance)} icon={iconForAccountType(a.type)} iconColor={a.kind === "liability" ? "orange" : "blue"} href="/accounts" chevron={false} />
          ))}
        </ListSection>
        ) : null}

        <ListSection header="Manage">
          <ListRow title="Accounts" icon="creditcard" iconColor="blue" href="/accounts" />
          <ListRow title="Categories" icon="tag" iconColor="orange" href="/categories" />
          <ListRow title="Review" icon="tray" iconColor="indigo" href="/review" detail={data.inbox.openReviews > 0 ? String(data.inbox.openReviews) : undefined} />
          <ListRow title="Activity" icon="clock" iconColor="gray" href="/activity" />
          <ListRow title="Settings" icon="gear" iconColor="gray" href="/settings" />
        </ListSection>

        <ListSection
          header="Message Capture"
          footer={data.inbox.waitingForModel > 0 ? `${data.inbox.waitingForModel} waiting for the model.` : "Bank messages are read within a minute of arriving."}
        >
          <ListRow title="Background checks" detail={data.captureActive ? <Status tone="good">On</Status> : <Status tone="warning">Paused</Status>} />
          <ListRow title="Not read yet" detail={String(data.inbox.staged)} />
        </ListSection>
      </IosList>
    </IosPage>
  );
}
