"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { KeyboardEvent } from "react";

import type { Money } from "../../core/domain/money.ts";
import type { BudgetRow, BudgetSuggestion } from "../../core/services/budget-service.ts";
import type { GoalRow } from "../../core/services/goal-service.ts";
import { LineChart } from "../../ui/charts.tsx";
import { bare, compact, longDate, money, monthLong, plainAmount, plural, shortDate, signedAmount } from "../../ui/format.ts";
import {
  ActionSheet,
  Alert as IosAlert,
  BarButton,
  Button as IosButton,
  Grid as IosGrid,
  List,
  ListRow,
  ListRowAction,
  ListSection,
  Menu,
  MenuItem as IosMenuItem,
  PopUpButton as IosPopUp,
  ProgressBar as IosProgress,
  Sheet as IosSheet,
  TextField as IosTextField,
} from "../../ui/ios/ios.tsx";
import { IosCard, IosFacts, IosFieldRow, IosNote, IosReading } from "../../ui/ios-parts.tsx";
import type { IconName } from "../../ui/labels.ts";
import { usePhone } from "../../ui/look.tsx";
import {
  Alert,
  Button,
  ContextMenu,
  EmptyState,
  FieldGrid,
  Form,
  FormRow,
  FormSection,
  Grid,
  GroupBox,
  MenuItem,
  MenuSeparator,
  PopUpButton,
  ProgressBar,
  Row,
  Section,
  Sheet,
  Table,
  TextField,
  Tile,
  ToolbarButton,
} from "../../ui/macos/macos.tsx";
import type { RowId, TableColumn } from "../../ui/macos/macos.tsx";
import type { Tone } from "../../ui/page.tsx";
import { IosPage, MacPage, Secondary, Status } from "../../ui/page.tsx";
import { archiveGoalAction, contributeGoalAction, saveGoalAction, setBudgetAction, setBufferAction } from "./actions.ts";
import type { PlanState } from "./actions.ts";

export type PlanData = {
  today: string;
  currency: string;
  digits: number;
  month: { from: string; to: string; day: number; days: number };
  forecast: {
    start: Money;
    buffer: Money;
    dailySpend: Money;
    historyDays: number;
    confidence: "low" | "medium" | "good";
    until: string;
    points: { date: string; base: bigint; conservative: bigint }[];
    events: { date: string; label: string; amount: Money; kind: "bill" | "income" | "card" }[];
    lowest: { base: { date: string; amount: Money }; conservative: { date: string; amount: Money } };
    monthEnd: { date: string; base: Money; conservative: Money };
    canSetAside: Money;
    belowBufferOn: string | null;
    notes: string[];
  };
  budgets: (BudgetRow & { icon: IconName })[];
  summary: { count: number; limit: Money; spent: Money; over: number };
  suggestions: BudgetSuggestion[];
  unbudgeted: { id: string; name: string }[];
  goals: GoalRow[];
  savingsAccounts: { id: string; name: string; currency: string; type: string }[];
};

type Budget = PlanData["budgets"][number];
type ForecastEvent = PlanData["forecast"]["events"][number];
type BudgetDraft = { categoryId: string; name: string; amount: string; existing: boolean };
type GoalDraft = { id?: string | undefined; name: string; target: string; targetDate: string; accountId: string; saved: string };
type Contribution = { goal: GoalRow; amount: string };

const EVENT_KIND: Record<ForecastEvent["kind"], string> = { bill: "Bill", income: "Income", card: "Card payment" };

function confidenceStatus(f: PlanData["forecast"]): { text: string; tone: Tone; icon: IconName; detail: string } {
  if (f.confidence === "good") return { text: "Good history", tone: "good", icon: "checkmark-circle-fill", detail: `The daily figure is the average of the last ${f.historyDays} days.` };
  if (f.confidence === "medium") return { text: "Some history", tone: "neutral", icon: "info-circle", detail: `The daily figure rests on ${plural(f.historyDays, "day")} of records; it steadies as more months are recorded.` };
  return {
    text: "Little history",
    tone: "warning",
    icon: "exclamationmark-triangle",
    detail:
      f.historyDays === 0
        ? "Nothing has been spent or earned on record yet, so no everyday spending is assumed. Treat the lines as a starting point only."
        : `Only ${plural(f.historyDays, "day")} recorded, so the daily figure is a rough guess, and missing days are not zero spending.`,
  };
}

function budgetStatus(row: Budget): { text: string; tone: Tone; icon: IconName } {
  if (row.status === "over") return { text: `${bare({ ...row.remaining, minor: -row.remaining.minor })} over`, tone: "bad", icon: "exclamationmark-triangle" };
  if (row.status === "near") return { text: `${Math.round(row.ratio * 100)}% used`, tone: "warning", icon: "chart-bar" };
  return { text: `${bare(row.remaining)} left`, tone: "good", icon: "checkmark-circle-fill" };
}

function goalStatus(goal: GoalRow, today: string): { text: string; tone: Tone; icon: IconName } {
  if (goal.reached) return { text: "Reached", tone: "good", icon: "checkmark-circle-fill" };
  if (goal.overdue) return { text: `Target date ${shortDate(goal.targetDate!, today)} has passed`, tone: "warning", icon: "clock" };
  if (goal.perMonth && goal.targetDate) return { text: `${money(goal.perMonth)} a month to reach it by ${shortDate(goal.targetDate, today)}`, tone: "neutral", icon: "calendar" };
  return { text: "No target date", tone: "neutral", icon: "info-circle" };
}

function usePlan(data: PlanData) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const [buffer, setBuffer] = useState(plainAmount(data.forecast.buffer));
  const [budget, setBudget] = useState<BudgetDraft | null>(null);
  const [goal, setGoal] = useState<GoalDraft | null>(null);
  const [contribution, setContribution] = useState<Contribution | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [removingGoal, setRemovingGoal] = useState<GoalRow | null>(null);

  const run = (action: () => Promise<PlanState>, after?: () => void) =>
    start(async () => {
      const result = await action();
      if (result.error) setFailure(result.error);
      else after?.();
    });
  /** For a sheet: the error stays in the sheet, beside what was typed, and the sheet stays open. */
  const runInSheet = (action: () => Promise<PlanState>, close: () => void) => {
    setSheetError(null);
    start(async () => {
      const result = await action();
      if (result.error) setSheetError(result.error);
      else close();
    });
  };

  const commitBuffer = () => {
    if (buffer.trim() === plainAmount(data.forecast.buffer)) return;
    run(() => setBufferAction(buffer));
  };
  const onBufferKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitBuffer();
    }
  };

  const suggestionFor = (categoryId: string) => data.suggestions.find((s) => s.categoryId === categoryId);
  const newBudget = (categoryId?: string) => {
    setSheetError(null);
    const first = categoryId ?? data.unbudgeted[0]?.id ?? "";
    const suggested = suggestionFor(first);
    setBudget({ categoryId: first, name: data.unbudgeted.find((c) => c.id === first)?.name ?? "", amount: suggested ? plainAmount(suggested.suggested) : "", existing: false });
  };
  const editBudget = (row: Budget) => {
    setSheetError(null);
    setBudget({ categoryId: row.categoryId, name: row.categoryName, amount: plainAmount(row.limit), existing: true });
  };
  const saveBudget = () => budget && runInSheet(() => setBudgetAction({ categoryId: budget.categoryId, amount: budget.amount }), () => setBudget(null));
  const removeBudget = (categoryId: string) => run(() => setBudgetAction({ categoryId, amount: null }), () => setBudget(null));
  const applySuggestion = (s: BudgetSuggestion) => run(() => setBudgetAction({ categoryId: s.categoryId, amount: plainAmount(s.suggested) }));

  const newGoal = () => {
    setSheetError(null);
    setGoal({ name: "", target: "", targetDate: "", accountId: "", saved: "" });
  };
  const editGoal = (row: GoalRow) => {
    setSheetError(null);
    setGoal({ id: row.id, name: row.name, target: plainAmount(row.target), targetDate: row.targetDate ?? "", accountId: row.accountId ?? "", saved: plainAmount(row.saved) });
  };
  const saveGoal = () => goal && runInSheet(() => saveGoalAction(goal), () => setGoal(null));
  const addMoney = (row: GoalRow) => {
    setSheetError(null);
    setContribution({ goal: row, amount: "" });
  };
  const saveContribution = () =>
    contribution && runInSheet(() => contributeGoalAction({ id: contribution.goal.id, amount: contribution.amount, currency: contribution.goal.target.currency.code }), () => setContribution(null));
  const removeGoal = (id: string) => run(() => archiveGoalAction(id), () => setGoal(null));

  // The chart: the expected line, the cautious one, and the buffer as a threshold when there is one.
  const f = data.forecast;
  const labels = f.points.map((p) => shortDate(p.date, data.today));
  const series = [
    { key: "base", name: "Expected", color: "var(--chart-spending)", values: f.points.map((p) => Number(p.base)), texts: f.points.map((p) => money({ ...f.start, minor: p.base })) },
    { key: "cautious", name: "Cautious", color: "var(--chart-muted)", values: f.points.map((p) => Number(p.conservative)), texts: f.points.map((p) => money({ ...f.start, minor: p.conservative })), style: "dashed" as const },
  ];
  const last = Math.max(f.points.length - 1, 0);
  const monthEndIndex = f.points.findIndex((p) => p.date === f.monthEnd.date);
  const axisLabels = [
    { index: 0, text: "Today" },
    ...(monthEndIndex > 2 && monthEndIndex < last - 4 ? [{ index: monthEndIndex, text: shortDate(f.monthEnd.date, data.today) }] : []),
    ...(last > 0 ? [{ index: last, text: shortDate(f.until, data.today) }] : []),
  ];
  const threshold = f.buffer.minor > 0n ? { value: Number(f.buffer.minor), label: `Buffer, ${bare(f.buffer)}` } : undefined;
  const chartSummary =
    `Spendable money from today to ${longDate(f.until)}: ${money(f.start)} now, ${money(f.monthEnd.base)} expected at the end of this month, ` +
    `lowest ${money(f.lowest.base.amount)} on ${shortDate(f.lowest.base.date, data.today)}${f.belowBufferOn ? `; the cautious line goes under the buffer on ${shortDate(f.belowBufferOn, data.today)}` : ""}.`;

  const howItWorks = [
    `It starts from ${money(f.start)}: the recorded balances of your bank, cash and wallet accounts. Savings accounts and credit limits are left out.`,
    `Everyday spending is taken as ${money(f.dailySpend)} a day: the average of ${plural(f.historyDays, "day")} of records, without the payments it recognises as your saved bills.`,
    "Saved bills and income from Bills land on their days, and each card's payment on its due day, for what is on the card today.",
    "The cautious line spends a quarter more a day, and what could be set aside is read from it, so the suggestion holds even if spending runs high. Both are planning ranges, not promises, and they move as you record more.",
  ];

  return {
    router, pending, failure, setFailure, buffer, setBuffer, commitBuffer, onBufferKey,
    budget, setBudget, newBudget, editBudget, saveBudget, removeBudget, applySuggestion, suggestionFor,
    goal, setGoal, newGoal, editGoal, saveGoal, contribution, setContribution, addMoney, saveContribution, removeGoal,
    removingGoal, setRemovingGoal, sheetError,
    labels, series, axisLabels, threshold, chartSummary, howItWorks,
    tick: (value: number) => compact(value, data.digits),
    confidence: confidenceStatus(f),
    accountChoices: [{ value: "", label: "Keep the figure by hand" }, ...data.savingsAccounts.map((a) => ({ value: a.id, label: `Follow ${a.name} (${a.currency})` }))],
  };
}

export function PlanView({ data }: { data: PlanData }) {
  return usePhone() ? <IosPlan data={data} /> : <MacPlan data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function MacPlan({ data }: { data: PlanData }) {
  const plan = usePlan(data);
  const f = data.forecast;
  const [budgetSelection, setBudgetSelection] = useState<RowId[]>([]);
  const selectedBudget = data.budgets.find((b) => budgetSelection.includes(b.categoryId)) ?? null;

  const eventColumns: TableColumn<ForecastEvent>[] = [
    { key: "date", title: "Date", width: 110, render: (e) => shortDate(e.date, data.today) },
    { key: "label", title: "What" },
    { key: "kind", title: "Kind", width: 140, render: (e) => EVENT_KIND[e.kind] },
    { key: "amount", title: "Amount", width: 170, numeric: true, sortValue: (e) => Number(e.amount.minor), render: (e) => signedAmount(e.amount.minor < 0n ? "expense" : "income", e.amount) },
  ];
  const budgetColumns: TableColumn<Budget>[] = [
    { key: "categoryName", title: "Category" },
    { key: "spent", title: "Spent", width: 140, numeric: true, sortValue: (b) => Number(b.spent.minor), render: (b) => bare(b.spent) },
    { key: "limit", title: "Limit", width: 140, numeric: true, sortValue: (b) => Number(b.limit.minor), render: (b) => bare(b.limit) },
    { key: "used", title: "Used", width: "18%", sortValue: (b) => b.ratio, render: (b) => <ProgressBar value={Math.min(100, Math.round(b.ratio * 100))} label={`${b.categoryName}: ${Math.round(b.ratio * 100)}% of the limit used`} size="small" /> },
    {
      key: "status",
      title: "This month",
      width: 170,
      sortValue: (b) => b.ratio,
      render: (b) => {
        const status = budgetStatus(b);
        return <Status tone={status.tone} icon={status.icon}>{status.text}</Status>;
      },
    },
    { key: "projected", title: "At this pace", width: 150, numeric: true, sortValue: (b) => Number(b.projected.minor), render: (b) => bare(b.projected) },
  ];

  return (
    <MacPage
      title="Plan"
      subtitle={`${monthLong(data.today.slice(0, 7))} · ${plural(data.month.days - data.month.day, "day")} left`}
      toolbar={
        <>
          <ToolbarButton icon="chart-bar" label="Add Budget" disabled={data.unbudgeted.length === 0} onClick={() => plan.newBudget()} />
          <ToolbarButton icon="plus" label="Add Goal" onClick={plan.newGoal} />
        </>
      }
    >
      <Section title={`Cash forecast to ${shortDate(f.until, data.today)}`} actions={<Status tone={plan.confidence.tone} icon={plan.confidence.icon}>{plan.confidence.text}</Status>} footer={plan.confidence.detail}>
        <Grid>
          <Tile label="Spendable now" icon="house" value={money(f.start)} detail="Bank, cash and wallets" />
          <Tile label="At month end" icon="calendar" value={money(f.monthEnd.base)} detail={`Cautious: ${money(f.monthEnd.conservative)}`} />
          <Tile label="Lowest point" icon="arrow-down" value={money(f.lowest.base.amount)} detail={`${shortDate(f.lowest.base.date, data.today)} · cautious ${money(f.lowest.conservative.amount)}`} />
          <Tile label="Could set aside" icon="archivebox" value={money(f.canSetAside)} detail={f.buffer.minor > 0n ? `Keeping ${money(f.buffer)} as a buffer` : "With no buffer set"} />
        </Grid>
      </Section>

      <Section title="Spendable money, day by day">
        <Tile
          detail={f.belowBufferOn ? <Status tone="bad">The cautious line goes under your buffer on {longDate(f.belowBufferOn)}.</Status> : `About ${money(f.dailySpend)} of everyday spending a day.`}
        >
          <LineChart summary={plan.chartSummary} labels={plan.labels} series={plan.series} tick={plan.tick} axisLabels={plan.axisLabels} threshold={plan.threshold} height={220} />
        </Tile>
      </Section>

      <Section title="In the forecast" footer={f.notes.length > 0 ? f.notes.join(" ") : "Saved bills, expected income and card payments between now and the end of next month."} actions={<Button size="small" onClick={() => plan.router.push("/bills")}>Bills</Button>}>
        <Tile flush>
          <Table label="Payments in the forecast" columns={eventColumns} rows={f.events} rowId={(e) => `${e.date}-${e.label}-${String(e.amount.minor)}`} selectionMode="none" emptyText="No bills, income or card payments saved yet. Add them on Bills." />
        </Tile>
      </Section>

      <Section title="Safety buffer">
        <Form style={{ maxWidth: 640 }}>
          <FormSection footer="The least you want left in your spendable accounts. Could set aside, and the warning on Home, keep this much back. Saved when you press Return or leave the field.">
            <FormRow label="Keep at least" subtitle={data.currency}>
              <TextField value={plan.buffer} onChange={plan.setBuffer} onBlur={plan.commitBuffer} onKeyDown={plan.onBufferKey} inputMode="decimal" placeholder="0.00" style={{ width: 160 }} />
            </FormRow>
          </FormSection>
        </Form>
      </Section>

      <Section title="How this is worked out">
        <GroupBox>
          {plan.howItWorks.map((line) => (
            <p key={line} style={{ margin: "0 0 6px" }}>
              <Secondary>{line}</Secondary>
            </p>
          ))}
        </GroupBox>
      </Section>

      <Section
        title={`Budgets for ${monthLong(data.today.slice(0, 7))}`}
        actions={
          <Row>
            <Button size="small" disabled={!selectedBudget} onClick={() => selectedBudget && plan.editBudget(selectedBudget)}>Edit…</Button>
            <Button size="small" disabled={!selectedBudget} onClick={() => selectedBudget && plan.removeBudget(selectedBudget.categoryId)}>Remove</Button>
            <Button size="small" disabled={data.unbudgeted.length === 0} onClick={() => plan.newBudget()}>Add Budget…</Button>
          </Row>
        }
        footer={<>Spending is summed from the ledger the way Home sums it. <a href="/categories">Manage categories</a></>}
      >
        {data.budgets.length === 0 ? (
          <Tile>
            <EmptyState icon="chart-bar" title="No Budgets Yet" message="Give a spending category a monthly limit and see how the month is going against it." actions={<Button onClick={() => plan.newBudget()} disabled={data.unbudgeted.length === 0}>Add Budget…</Button>} />
          </Tile>
        ) : (
          <>
            <Grid>
              <Tile label="Budgeted" icon="chart-bar" value={money(data.summary.limit)} detail={plural(data.summary.count, "category", "categories")} />
              <Tile
                label="Spent in them"
                icon="cart"
                value={money(data.summary.spent)}
                progress={data.summary.limit.minor > 0n ? Math.min(100, Math.round((Number(data.summary.spent.minor) / Number(data.summary.limit.minor)) * 100)) : 0}
                detail={data.summary.over > 0 ? <Status tone="bad">{plural(data.summary.over, "budget")} over</Status> : <Status tone="good">All within their limits</Status>}
              />
              <Tile label="Month gone" icon="clock" value={`${Math.round((data.month.day / data.month.days) * 100)}%`} progress={Math.round((data.month.day / data.month.days) * 100)} detail={`Day ${data.month.day} of ${data.month.days}`} />
            </Grid>
            <Tile flush>
              <ContextMenu
                menu={
                  <>
                    <MenuItem icon="pencil" disabled={!selectedBudget} onSelect={() => selectedBudget && plan.editBudget(selectedBudget)}>Edit…</MenuItem>
                    <MenuItem icon="list-bullet" disabled={!selectedBudget} onSelect={() => selectedBudget && plan.router.push(`/transactions?category=${encodeURIComponent(selectedBudget.categoryId)}&from=${data.month.from}&to=${data.month.to}`)}>Show Transactions</MenuItem>
                    <MenuSeparator />
                    <MenuItem icon="trash" disabled={!selectedBudget} onSelect={() => selectedBudget && plan.removeBudget(selectedBudget.categoryId)}>Remove Budget</MenuItem>
                  </>
                }
              >
                <Table
                  label="Budgets"
                  columns={budgetColumns}
                  rows={data.budgets}
                  rowId={(b) => b.categoryId}
                  rowIcon={(b) => b.icon}
                  selection={budgetSelection}
                  onSelectionChange={setBudgetSelection}
                  onRowAction={plan.editBudget}
                />
              </ContextMenu>
            </Tile>
          </>
        )}
      </Section>

      {data.suggestions.length > 0 ? (
        <Section title="Suggested budgets" footer="From the average of your last three complete months, rounded up. Nothing is set until you choose one.">
          <Form>
            <FormSection>
              {data.suggestions.map((s) => (
                <FormRow key={s.categoryId} label={s.categoryName} subtitle={`About ${money(s.average)} a month`}>
                  <Button size="small" disabled={plan.pending} onClick={() => plan.applySuggestion(s)}>Use {money(s.suggested)}</Button>
                </FormRow>
              ))}
            </FormSection>
          </Form>
        </Section>
      ) : null}

      <Section title="Goals" actions={<Button size="small" onClick={plan.newGoal}>Add Goal…</Button>} footer="A goal moves no money. It follows an account's recorded balance, or a figure you keep by hand.">
        {data.goals.length === 0 ? (
          <Tile>
            <EmptyState icon="star" title="No Goals Yet" message="An emergency fund, a holiday, a deposit: set a target and a date, and see what each month needs." actions={<Button onClick={plan.newGoal}>Add Goal…</Button>} />
          </Tile>
        ) : (
          <Grid min={280} columns={3}>
            {data.goals.map((g) => {
              const status = goalStatus(g, data.today);
              return (
                <Tile key={g.id} label={g.name} icon={g.reached ? "star-fill" : "star"} value={money(g.saved)} progress={Math.round(g.progress * 100)} detail={`${Math.round(g.progress * 100)}% of ${money(g.target)} · ${g.accountName ? `follows ${g.accountName}` : "kept by hand"}`}>
                  <Status tone={status.tone} icon={status.icon}>{status.text}</Status>
                  <Row>
                    {g.accountId ? null : <Button size="small" onClick={() => plan.addMoney(g)}>Add Money…</Button>}
                    <Button size="small" onClick={() => plan.editGoal(g)}>Edit…</Button>
                    <Button size="small" onClick={() => plan.setRemovingGoal(g)}>Remove…</Button>
                  </Row>
                </Tile>
              );
            })}
          </Grid>
        )}
      </Section>

      <MacSheets plan={plan} data={data} />

      <Alert
        open={plan.removingGoal !== null}
        onClose={() => plan.setRemovingGoal(null)}
        title={`Remove the goal “${plan.removingGoal?.name ?? ""}”?`}
        message="No money moves. An account it followed keeps its balance."
        buttons={[
          { label: "Remove", role: "destructive", onClick: () => plan.removingGoal && plan.removeGoal(plan.removingGoal.id) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
      <Alert open={plan.failure !== null} onClose={() => plan.setFailure(null)} title="That could not be saved" message={plan.failure ?? ""} />
    </MacPage>
  );
}

function MacSheets({ plan, data }: { plan: ReturnType<typeof usePlan>; data: PlanData }) {
  const { budget, goal, contribution } = plan;
  // The kit closes a sheet after its default button; these close only once the save succeeds.
  const closeOn = (close: () => void) => (button?: string) => (button === "Cancel" || button === undefined ? close() : undefined);
  const suggestion = budget ? plan.suggestionFor(budget.categoryId) : undefined;
  return (
    <>
      <Sheet
        open={budget !== null}
        onClose={closeOn(() => plan.setBudget(null))}
        title={budget?.existing ? `Budget for ${budget.name}` : "New Budget"}
        top={60}
        buttons={[
          ...(budget?.existing ? [{ label: "Remove Budget", role: "leading" as const, onClick: () => budget && plan.removeBudget(budget.categoryId) }] : []),
          { label: "Cancel", role: "cancel" },
          { label: plan.pending ? "Saving…" : "Save", role: "default", disabled: plan.pending || !budget?.amount.trim() || !budget?.categoryId, onClick: plan.saveBudget },
        ]}
      >
        {budget ? (
          <FieldGrid
            rows={[
              ...(budget.existing
                ? []
                : [{
                    label: "Category:",
                    control: (
                      <PopUpButton
                        options={data.unbudgeted.map((c) => ({ value: c.id, label: c.name }))}
                        value={budget.categoryId}
                        onChange={(categoryId) => {
                          const s = plan.suggestionFor(categoryId);
                          plan.setBudget({ ...budget, categoryId, name: data.unbudgeted.find((c) => c.id === categoryId)?.name ?? "", amount: s ? plainAmount(s.suggested) : budget.amount });
                        }}
                      />
                    ),
                  }]),
              {
                label: "Monthly limit:",
                control: <TextField value={budget.amount} onChange={(amount) => plan.setBudget({ ...budget, amount })} placeholder="0.00" inputMode="decimal" autoFocus />,
                note: plan.sheetError ?? (suggestion ? `In ${data.currency}. You spent about ${money(suggestion.average)} a month over the last three.` : `In ${data.currency}.`),
                ...(plan.sheetError ? { error: true } : {}),
              },
            ]}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={goal !== null}
        onClose={closeOn(() => plan.setGoal(null))}
        title={goal?.id ? `Edit “${goal.name}”` : "New Goal"}
        top={60}
        buttons={[
          { label: "Cancel", role: "cancel" },
          { label: plan.pending ? "Saving…" : "Save", role: "default", disabled: plan.pending || !goal?.name.trim() || !goal?.target.trim(), onClick: plan.saveGoal },
        ]}
      >
        {goal ? (
          <FieldGrid
            rows={[
              { label: "Name:", control: <TextField value={goal.name} onChange={(name) => plan.setGoal({ ...goal, name })} placeholder="Emergency fund" maxLength={60} autoFocus /> },
              { label: "Target:", control: <TextField value={goal.target} onChange={(target) => plan.setGoal({ ...goal, target })} placeholder="0.00" inputMode="decimal" /> },
              { label: "Target date:", control: <TextField type="date" value={goal.targetDate} min={data.today} onChange={(targetDate) => plan.setGoal({ ...goal, targetDate })} />, note: "Optional. With a date, the plan says what each month needs." },
              { label: "Progress:", control: <PopUpButton options={plan.accountChoices} value={goal.accountId} onChange={(accountId) => plan.setGoal({ ...goal, accountId })} />, note: "Follow an account to count its recorded balance, or keep the figure yourself." },
              ...(goal.accountId
                ? []
                : [{ label: "Set aside so far:", control: <TextField value={goal.saved} onChange={(saved) => plan.setGoal({ ...goal, saved })} placeholder="0.00" inputMode="decimal" /> }]),
              ...(plan.sheetError ? [{ label: "", control: <Status tone="bad">{plan.sheetError}</Status> }] : []),
            ]}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={contribution !== null}
        onClose={closeOn(() => plan.setContribution(null))}
        title={`Add money to “${contribution?.goal.name ?? ""}”`}
        top={60}
        buttons={[
          { label: "Cancel", role: "cancel" },
          { label: plan.pending ? "Saving…" : "Add", role: "default", disabled: plan.pending || !contribution?.amount.trim(), onClick: plan.saveContribution },
        ]}
      >
        {contribution ? (
          <FieldGrid
            rows={[
              {
                label: "Amount:",
                control: <TextField value={contribution.amount} onChange={(amount) => plan.setContribution({ ...contribution, amount })} placeholder="0.00" inputMode="decimal" autoFocus />,
                note: plan.sheetError ?? `In ${contribution.goal.target.currency.code}. Nothing moves between accounts; a negative amount takes some back.`,
                ...(plan.sheetError ? { error: true } : {}),
              },
            ]}
          />
        ) : null}
      </Sheet>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

function IosPlan({ data }: { data: PlanData }) {
  const plan = usePlan(data);
  const f = data.forecast;
  const [goalActions, setGoalActions] = useState<GoalRow | null>(null);

  return (
    <IosPage
      title="Plan"
      subtitle={`${monthLong(data.today.slice(0, 7))} · ${plural(data.month.days - data.month.day, "day")} left`}
      trailing={
        <Menu label="Add" trigger={<BarButton icon="plus" label="Add" />}>
          <IosMenuItem icon="chart-bar" label="Add Budget" disabled={data.unbudgeted.length === 0} onSelect={() => plan.newBudget()} />
          <IosMenuItem icon="star" label="Add Goal" onSelect={plan.newGoal} />
        </Menu>
      }
    >
      <IosGrid>
        <IosCard icon="archivebox" title="Could Set Aside" color="var(--ios-teal)" trailing={<Status tone={plan.confidence.tone} icon={plan.confidence.icon}>{plan.confidence.text}</Status>}>
          <IosReading code={data.currency} value={bare(f.canSetAside)} />
          <IosNote>
            {f.buffer.minor > 0n ? `Keeping ${money(f.buffer)} as a buffer` : "With no buffer set"} until {shortDate(f.until, data.today)}, even if everyday spending runs a quarter above {money(f.dailySpend)} a day.
          </IosNote>
        </IosCard>
        <IosCard icon="chart-bar" title="Cash Forecast" color="var(--ios-blue)" trailing={`to ${shortDate(f.until, data.today)}`}>
          <LineChart summary={plan.chartSummary} labels={plan.labels} series={plan.series} tick={plan.tick} axisLabels={plan.axisLabels} threshold={plan.threshold} height={180} />
          <IosFacts
            items={[
              { label: "Spendable now", value: money(f.start) },
              { label: "At month end", value: money(f.monthEnd.base) },
              { label: `Lowest, ${shortDate(f.lowest.base.date, data.today)}`, value: money(f.lowest.base.amount) },
              { label: "Cautious month end", value: money(f.monthEnd.conservative) },
            ]}
          />
          {f.belowBufferOn ? (
            <span className="ios-footnote">
              <Status tone="bad">The cautious line goes under your buffer on {longDate(f.belowBufferOn)}.</Status>
            </span>
          ) : null}
          <IosNote>{plan.confidence.detail}</IosNote>
        </IosCard>
      </IosGrid>

      <List>
        <ListSection header="In the Forecast" footer={f.notes.length > 0 ? f.notes.join(" ") : "Saved bills, expected income and card payments to the end of next month."}>
          {f.events.length === 0 ? (
            <ListRow title="Add bills and income" subtitle="Nothing is saved on Bills yet." href="/bills" />
          ) : (
            f.events.map((e) => (
              <ListRow
                key={`${e.date}-${e.label}-${String(e.amount.minor)}`}
                title={e.label}
                subtitle={`${shortDate(e.date, data.today)} · ${EVENT_KIND[e.kind]}`}
                detail={signedAmount(e.amount.minor < 0n ? "expense" : "income", e.amount, false)}
              />
            ))
          )}
        </ListSection>

        <ListSection header="Safety Buffer" footer={`The least you want left in your spendable accounts, in ${data.currency}. Saved when you tap Return or leave the field.`}>
          <IosFieldRow label="Buffer">
            <IosTextField value={plan.buffer} onChange={plan.setBuffer} onBlur={plan.commitBuffer} onKeyDown={plan.onBufferKey} inputMode="decimal" placeholder="0.00" enterKeyHint="done" />
          </IosFieldRow>
        </ListSection>

        <ListSection header="How It's Worked Out">
          {plan.howItWorks.map((line, index) => (
            <ListRow key={line} title={["Starting point", "Everyday spending", "Bills and cards", "Cautious line"][index]} subtitle={line} />
          ))}
        </ListSection>
      </List>

      <IosGrid title={`Budgets · ${monthLong(data.today.slice(0, 7))}`}>
        <IosCard icon="chart-bar" title="This Month" color="var(--ios-orange)" trailing={`Day ${data.month.day} of ${data.month.days}`}>
          {data.budgets.length === 0 ? (
            <IosNote>No budgets yet. Give a spending category a monthly limit to see how the month is going against it.</IosNote>
          ) : (
            <>
              <IosFacts items={[{ label: "Budgeted", value: money(data.summary.limit) }, { label: "Spent in them", value: money(data.summary.spent) }]} />
              {data.budgets.map((b) => {
                const status = budgetStatus(b);
                return (
                  <span key={b.categoryId} style={{ display: "grid", gap: 6 }}>
                    <span style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span className="ios-subheadline ios-emphasized">{b.categoryName}</span>
                      <span className="ios-subheadline ios-label-secondary pfa-money">
                        {bare(b.spent)} / {bare(b.limit)}
                      </span>
                    </span>
                    <IosProgress value={Math.min(1, b.ratio)} aria-label={`${b.categoryName}: ${Math.round(b.ratio * 100)}% of the limit used`} />
                    <span className="ios-footnote">
                      <Status tone={status.tone} icon={status.icon}>{status.text}</Status>
                    </span>
                  </span>
                );
              })}
            </>
          )}
        </IosCard>
      </IosGrid>

      <List>
        <ListSection header="Budgets" footer="Tap one to change its limit; swipe to remove it. Spending is summed from the ledger the way Home sums it.">
          {data.budgets.map((b) => (
            <ListRow
              key={b.categoryId}
              title={b.categoryName}
              subtitle={`${bare(b.limit)} a month · ${bare(b.projected)} at this pace`}
              icon={b.icon}
              iconColor={b.status === "over" ? "red" : b.status === "near" ? "orange" : "green"}
              onClick={() => plan.editBudget(b)}
              trailingActions={<ListRowAction label="Remove" icon="trash" destructive onClick={() => plan.removeBudget(b.categoryId)} />}
            />
          ))}
          <ListRow title="Add Budget" action disabled={data.unbudgeted.length === 0} onClick={() => plan.newBudget()} />
          <ListRow title="Manage Categories" href="/categories" />
        </ListSection>

        {data.suggestions.length > 0 ? (
          <ListSection header="Suggested Budgets" footer="From your last three complete months, rounded up. Nothing is set until you choose one.">
            {data.suggestions.map((s) => (
              <ListRow key={s.categoryId} title={s.categoryName} subtitle={`About ${money(s.average)} a month`} buttonLabel={`Use ${bare(s.suggested)}`} onButtonClick={() => plan.applySuggestion(s)} />
            ))}
          </ListSection>
        ) : null}
      </List>

      <IosGrid title="Goals">
        {data.goals.map((g) => {
          const status = goalStatus(g, data.today);
          return (
            <IosCard key={g.id} icon={g.reached ? "star-fill" : "star"} title={g.name} color="var(--ios-green)" onClick={() => setGoalActions(g)} label={`${g.name}: actions`}>
              <IosReading code={g.saved.currency.code} value={bare(g.saved)} size="title2" />
              <IosProgress value={g.progress} aria-label={`${g.name}: ${Math.round(g.progress * 100)}% of the target`} />
              <IosFacts
                items={[
                  { label: "Target", value: money(g.target) },
                  { label: "Progress from", value: g.accountName ?? "Kept by hand" },
                ]}
              />
              <span className="ios-footnote">
                <Status tone={status.tone} icon={status.icon}>{status.text}</Status>
              </span>
            </IosCard>
          );
        })}
      </IosGrid>
      <List>
        <ListSection footer="A goal moves no money. It follows an account's recorded balance, or a figure you keep by hand.">
          <ListRow title="Add Goal" action onClick={plan.newGoal} />
        </ListSection>
      </List>

      <ActionSheet
        open={goalActions !== null}
        onOpenChange={(open) => !open && setGoalActions(null)}
        title={goalActions?.name ?? ""}
        actions={[
          ...(goalActions && !goalActions.accountId ? [{ label: "Add Money", icon: "plus-circle" as const, onPress: () => goalActions && plan.addMoney(goalActions) }] : []),
          { label: "Edit", icon: "pencil", onPress: () => goalActions && plan.editGoal(goalActions) },
          { label: "Remove Goal", role: "destructive", icon: "trash", onPress: () => goalActions && plan.setRemovingGoal(goalActions) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
      <ActionSheet
        open={plan.removingGoal !== null}
        onOpenChange={(open) => !open && plan.setRemovingGoal(null)}
        title={`Remove “${plan.removingGoal?.name ?? ""}”?`}
        message="No money moves. An account it followed keeps its balance."
        actions={[
          { label: "Remove Goal", role: "destructive", onPress: () => plan.removingGoal && plan.removeGoal(plan.removingGoal.id) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
      <IosAlert open={plan.failure !== null} onOpenChange={(open) => !open && plan.setFailure(null)} title="Couldn't Save" message={plan.failure ?? ""} actions={[{ label: "OK", role: "default" }]} />
      <IosSheets plan={plan} data={data} />
    </IosPage>
  );
}

function IosSheets({ plan, data }: { plan: ReturnType<typeof usePlan>; data: PlanData }) {
  const { budget, goal, contribution } = plan;
  const errorFooter = (fallback: string) => (plan.sheetError ? <Status tone="bad">{plan.sheetError}</Status> : fallback);
  const suggestion = budget ? plan.suggestionFor(budget.categoryId) : undefined;
  const cancel = (close: () => void) => <IosButton variant="glass" onClick={close}>Cancel</IosButton>;
  const save = (label: string, disabled: boolean, onClick: () => void) => (
    <IosButton variant="glass-prominent" disabled={disabled || plan.pending} onClick={onClick}>
      {plan.pending ? "Saving…" : label}
    </IosButton>
  );
  return (
    <>
      <IosSheet
        open={budget !== null}
        onOpenChange={(open) => !open && plan.setBudget(null)}
        title={budget?.existing ? budget.name : "New Budget"}
        detents={["medium", "large"]}
        leading={cancel(() => plan.setBudget(null))}
        trailing={save("Save", !budget?.amount.trim() || !budget?.categoryId, plan.saveBudget)}
      >
        {budget ? (
          <List>
            <ListSection footer={errorFooter(suggestion ? `You spent about ${money(suggestion.average)} a month over the last three.` : `A monthly limit, in ${data.currency}.`)}>
              {budget.existing ? null : (
                <ListRow
                  title="Category"
                  popup={
                    <IosPopUp
                      label="Category"
                      options={data.unbudgeted.map((c) => ({ value: c.id, label: c.name }))}
                      value={budget.categoryId}
                      onChange={(categoryId) => {
                        const s = plan.suggestionFor(categoryId);
                        plan.setBudget({ ...budget, categoryId, name: data.unbudgeted.find((c) => c.id === categoryId)?.name ?? "", amount: s ? plainAmount(s.suggested) : budget.amount });
                      }}
                    />
                  }
                />
              )}
              <IosFieldRow label="Monthly limit">
                <IosTextField value={budget.amount} onChange={(amount) => plan.setBudget({ ...budget, amount })} placeholder="0.00" inputMode="decimal" />
              </IosFieldRow>
            </ListSection>
            {budget.existing ? (
              <ListSection>
                <ListRow title="Remove Budget" action destructive center onClick={() => plan.removeBudget(budget.categoryId)} />
              </ListSection>
            ) : null}
          </List>
        ) : null}
      </IosSheet>

      <IosSheet
        open={goal !== null}
        onOpenChange={(open) => !open && plan.setGoal(null)}
        title={goal?.id ? "Edit Goal" : "New Goal"}
        dismissible={!goal?.name && !goal?.target}
        leading={cancel(() => plan.setGoal(null))}
        trailing={save("Save", !goal?.name.trim() || !goal?.target.trim(), plan.saveGoal)}
      >
        {goal ? (
          <List>
            <ListSection>
              <IosFieldRow label="Name">
                <IosTextField value={goal.name} onChange={(name) => plan.setGoal({ ...goal, name })} placeholder="Required" maxLength={60} />
              </IosFieldRow>
              <IosFieldRow label="Target">
                <IosTextField value={goal.target} onChange={(target) => plan.setGoal({ ...goal, target })} placeholder="0.00" inputMode="decimal" />
              </IosFieldRow>
            </ListSection>
            <ListSection footer="Optional. With a date, the plan says what each month needs.">
              <IosFieldRow label="Target date">
                <IosTextField type="date" value={goal.targetDate} min={data.today} onChange={(targetDate) => plan.setGoal({ ...goal, targetDate })} clearButton="never" />
              </IosFieldRow>
            </ListSection>
            <ListSection footer={errorFooter("Follow an account to count its recorded balance, or keep the figure yourself.")}>
              <ListRow title="Progress" popup={<IosPopUp label="Progress" options={plan.accountChoices} value={goal.accountId} onChange={(accountId) => plan.setGoal({ ...goal, accountId })} />} />
              {goal.accountId ? null : (
                <IosFieldRow label="Set aside so far">
                  <IosTextField value={goal.saved} onChange={(saved) => plan.setGoal({ ...goal, saved })} placeholder="0.00" inputMode="decimal" />
                </IosFieldRow>
              )}
            </ListSection>
          </List>
        ) : null}
      </IosSheet>

      <IosSheet
        open={contribution !== null}
        onOpenChange={(open) => !open && plan.setContribution(null)}
        title="Add Money"
        detents={["medium"]}
        leading={cancel(() => plan.setContribution(null))}
        trailing={save("Add", !contribution?.amount.trim(), plan.saveContribution)}
      >
        {contribution ? (
          <List>
            <ListSection header={contribution.goal.name} footer={errorFooter(`In ${contribution.goal.target.currency.code}. Nothing moves between accounts; a negative amount takes some back.`)}>
              <IosFieldRow label="Amount">
                <IosTextField value={contribution.amount} onChange={(amount) => plan.setContribution({ ...contribution, amount })} placeholder="0.00" inputMode="decimal" />
              </IosFieldRow>
            </ListSection>
          </List>
        ) : null}
      </IosSheet>
    </>
  );
}
