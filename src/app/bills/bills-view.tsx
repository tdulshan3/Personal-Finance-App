"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { Money } from "../../core/domain/money.ts";
import { bare, money, plainAmount, plural, relativeDays, shortDate, signedAmount } from "../../ui/format.ts";
import { useFrame } from "../../ui/frame.tsx";
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
  PopUpButton as IosPopUp,
  SegmentedControl as IosSegmented,
  Sheet as IosSheet,
  Stepper as IosStepper,
  TextField as IosTextField,
} from "../../ui/ios/ios.tsx";
import { IosCard, IosFacts, IosFieldRow } from "../../ui/ios-parts.tsx";
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
  Row,
  Section,
  SegmentedControl,
  Sheet,
  Stepper,
  Table,
  TextField,
  Tile,
  ToolbarButton,
} from "../../ui/macos/macos.tsx";
import type { RowId, TableColumn } from "../../ui/macos/macos.tsx";
import type { Tone } from "../../ui/page.tsx";
import { IosPage, MacPage, Secondary, Status } from "../../ui/page.tsx";
import { addSuggestionAction, removeRecurringAction, saveRecurringAction, setDueDayAction } from "./actions.ts";
import type { BillsState } from "./actions.ts";

type Direction = "out" | "in";

export type CardRow = {
  id: string;
  name: string;
  isLoan: boolean;
  owed: Money;
  dueDay: number | null;
  dueOn: string | null;
  daysLeft: number | null;
  available: Money | null;
  limit: Money | null;
};

export type ItemRow = {
  id: string;
  name: string;
  direction: Direction;
  amount: Money;
  dueDay: number;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: IconName | null;
  matchText: string | null;
  state: "paid" | "upcoming" | "overdue";
  dueThisMonth: string;
  nextDue: string;
  daysUntil: number;
  lastPaid: { date: string; amount: Money; transactionId: string } | null;
};

export type SuggestionRow = {
  key: string;
  name: string;
  direction: Direction;
  amount: Money;
  dueDay: number;
  accountName: string | null;
  categoryName: string | null;
  months: number;
  lastDate: string;
};

export type BillsData = {
  today: string;
  currency: string;
  cards: CardRow[];
  loans: CardRow[];
  items: ItemRow[];
  suggestions: SuggestionRow[];
  totals: { toPay: Money; toPayCount: number; overdue: number; paid: Money; paidCount: number; expected: Money; received: Money; cards: Money };
  accounts: { id: string; name: string; currency: string; kind: string }[];
  categories: { id: string; name: string; kind: "expense" | "income" }[];
};

type Draft = { id?: string | undefined; name: string; direction: Direction; amount: string; dueDay: number; accountId: string; categoryId: string; matchText: string };

/** "3rd", "21st": how a day of the month is said. */
function ordinal(day: number): string {
  const tail = day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${tail}`;
}

/** The state of this month's occurrence, as a status word with its symbol — never colour alone. */
function itemStatus(item: ItemRow, today: string): { text: string; tone: Tone; icon: IconName } {
  const income = item.direction === "in";
  if (item.state === "paid") {
    return { text: `${income ? "Received" : "Paid"} ${item.lastPaid ? shortDate(item.lastPaid.date, today) : ""}`.trim(), tone: "good", icon: "checkmark-circle-fill" };
  }
  if (item.state === "overdue") {
    const late = -item.daysUntil;
    return income
      ? { text: `Expected ${plural(late, "day")} ago`, tone: "warning", icon: "clock" }
      : { text: `${plural(late, "day")} late`, tone: "bad", icon: "exclamationmark-triangle" };
  }
  const when = relativeDays(item.daysUntil);
  return { text: `${income ? "Expected" : "Due"} ${when}`, tone: item.daysUntil <= 3 ? "warning" : "neutral", icon: "calendar" };
}

/** A card's payment, as a status word. */
function cardStatus(card: CardRow, today: string): { text: string; tone: Tone; icon: IconName } {
  if (card.owed.minor <= 0n) return { text: card.owed.minor < 0n ? "In credit · nothing owed" : "Nothing owed", tone: "good", icon: "checkmark-circle-fill" };
  if (card.dueOn === null || card.daysLeft === null) return { text: "No due day set", tone: "warning", icon: "exclamationmark-triangle" };
  return {
    text: `Due ${shortDate(card.dueOn, today)} · ${relativeDays(card.daysLeft)}`,
    tone: card.daysLeft <= 7 ? "warning" : "neutral",
    icon: card.daysLeft <= 7 ? "clock" : "calendar",
  };
}

const DAY_OPTIONS = [{ value: "", label: "Not set" }, ...Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: `Day ${index + 1}` }))];

function useBills(data: BillsData) {
  const { addTransaction } = useFrame();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ItemRow | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (action: () => Promise<BillsState>, after?: () => void) =>
    start(async () => {
      const result = await action();
      if (result.error) setFailure(result.error);
      else after?.();
    });

  const today = Number(data.today.slice(8, 10));
  const startNew = (direction: Direction = "out") => {
    setDraftError(null);
    setDraft({ name: "", direction, amount: "", dueDay: today, accountId: "", categoryId: "", matchText: "" });
  };
  const startEdit = (item: ItemRow) => {
    setDraftError(null);
    setDraft({
      id: item.id,
      name: item.name,
      direction: item.direction,
      amount: plainAmount(item.amount),
      dueDay: item.dueDay,
      accountId: item.accountId ?? "",
      categoryId: item.categoryId ?? "",
      // Shown only when it says something the name does not.
      matchText: item.matchText && item.matchText !== item.name.trim().toLowerCase() ? item.matchText : "",
    });
  };
  const saveDraft = () => {
    if (!draft) return;
    setDraftError(null);
    start(async () => {
      const result = await saveRecurringAction({
        id: draft.id,
        name: draft.name,
        direction: draft.direction,
        amount: draft.amount,
        dueDay: draft.dueDay,
        accountId: draft.accountId || null,
        categoryId: draft.categoryId || null,
        matchText: draft.matchText,
      });
      if (result.error) setDraftError(result.error);
      else setDraft(null);
    });
  };
  const remove = (id: string) => run(() => removeRecurringAction(id), () => setDraft(null));
  const addSuggestion = (key: string) => run(() => addSuggestionAction(key));
  const setDueDay = (card: CardRow, value: string) => run(() => setDueDayAction({ accountId: card.id, dueDay: value === "" ? null : Number(value) }));

  const payCard = (card: CardRow) => addTransaction({ kind: "transfer", toAccountId: card.id, amount: plainAmount(card.owed) });
  const payItem = (item: ItemRow) => {
    // Prefill the merchant so the payment is recognised: the name, unless the match text says otherwise.
    const merchant = item.matchText && !item.name.toLowerCase().includes(item.matchText) ? item.matchText : item.name;
    addTransaction({
      kind: item.direction === "in" ? "income" : "expense",
      accountId: item.accountId ?? undefined,
      amount: plainAmount(item.amount),
      merchantName: merchant,
      categoryId: item.categoryId ?? undefined,
    });
  };

  // What the edit form offers: income only into a bank, cash or wallet account; categories by direction.
  const accountChoices = (direction: Direction) => [
    { value: "", label: "Any account" },
    ...data.accounts.filter((a) => direction === "out" || a.kind === "asset").map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` })),
  ];
  const categoryChoices = (direction: Direction) => [
    { value: "", label: "None" },
    ...data.categories.filter((c) => c.kind === (direction === "in" ? "income" : "expense")).map((c) => ({ value: c.id, label: c.name })),
  ];
  const draftCurrency = draft?.accountId ? (data.accounts.find((a) => a.id === draft.accountId)?.currency ?? data.currency) : data.currency;

  return {
    draft, setDraft, draftError, saveDraft, startNew, startEdit,
    removing, setRemoving, remove, addSuggestion, setDueDay, payCard, payItem,
    failure, setFailure, pending, accountChoices, categoryChoices, draftCurrency,
  };
}

const HOW_IT_WORKS = [
  "What you spend on a card this month is billed and paid next month, so each card shows one payment, on its due day, for what is on it today.",
  "That figure is your recorded balance, not a statement. If your statement says something different, the difference is spending or a payment not recorded yet.",
  "Paying a card moves money from a bank account into the card. It is a transfer, never counted as spending twice.",
  "A bill counts as paid when a transaction this month matches it: its merchant or payer contains the bill's match text. Nothing is ticked by hand.",
  "Suggestions come from merchants and payers seen about once a month for about the same amount. They are only suggestions; nothing is tracked until you add it.",
];

export function BillsView({ data }: { data: BillsData }) {
  return usePhone() ? <IosBills data={data} /> : <MacBills data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function MacBills({ data }: { data: BillsData }) {
  const bills = useBills(data);
  const router = useRouter();
  const [selection, setSelection] = useState<RowId[]>([]);
  const selected = data.items.find((item) => selection.includes(item.id)) ?? null;

  const columns: TableColumn<ItemRow>[] = [
    { key: "name", title: "Name" },
    { key: "dueDay", title: "Day", width: 70, render: (r) => ordinal(r.dueDay) },
    { key: "amount", title: "Amount", width: 150, numeric: true, sortValue: (r) => Number(r.amount.minor), render: (r) => signedAmount(r.direction === "in" ? "income" : "expense", r.amount) },
    { key: "account", title: "Account", width: "18%", sortValue: (r) => r.accountName ?? "", render: (r) => r.accountName ?? "Any account" },
    {
      key: "state",
      title: "This month",
      width: 190,
      sortValue: (r) => r.daysUntil,
      render: (r) => {
        const status = itemStatus(r, data.today);
        return <Status tone={status.tone} icon={status.icon}>{status.text}</Status>;
      },
    },
    {
      key: "last",
      title: "Last payment",
      width: 200,
      sortValue: (r) => r.lastPaid?.date ?? "",
      render: (r) => (r.lastPaid ? <a href={`/transactions/${r.lastPaid.transactionId}`}>{`${shortDate(r.lastPaid.date, data.today)} · ${bare(r.lastPaid.amount)}`}</a> : "--"),
    },
  ];

  return (
    <MacPage
      title="Bills"
      subtitle={`${plural(data.totals.toPayCount, "bill")} still to pay this month${data.totals.overdue > 0 ? ` · ${data.totals.overdue} late` : ""}`}
      toolbar={
        <>
          <ToolbarButton icon="plus" label="Add Bill or Income" onClick={() => bills.startNew()} />
          <ToolbarButton icon="square-and-pencil" label="Record Payment" disabled={!selected || selected.state === "paid"} onClick={() => selected && bills.payItem(selected)} />
          <ToolbarButton icon="pencil" label="Edit" disabled={!selected} onClick={() => selected && bills.startEdit(selected)} />
          <ToolbarButton icon="trash" label="Remove" disabled={!selected} onClick={() => selected && bills.setRemoving(selected)} />
        </>
      }
    >
      <Section title="This month" footer={`Totals in ${data.currency}.`}>
        <Grid>
          <Tile
            label="Still to pay"
            icon="calendar"
            value={money(data.totals.toPay)}
            detail={data.totals.overdue > 0 ? <Status tone="bad">{data.totals.overdue} late</Status> : plural(data.totals.toPayCount, "bill")}
          />
          <Tile label="Paid" icon="checkmark-circle-fill" value={money(data.totals.paid)} detail={plural(data.totals.paidCount, "bill")} />
          <Tile label="Income expected" icon="arrow-down-circle" value={money(data.totals.expected)} detail={`${money(data.totals.received)} received so far`} />
          <Tile label="On your cards" icon="creditcard" value={money(data.totals.cards)} detail="Due next month" />
        </Grid>
      </Section>

      <Section title="Credit cards">
        {data.cards.length === 0 ? (
          <Tile>
            <EmptyState
              icon="creditcard"
              title="No Credit Cards"
              message="Add a credit card on Accounts and its payment appears here, growing as you record spending on it."
              actions={<Button onClick={() => router.push("/accounts")}>Go to Accounts</Button>}
            />
          </Tile>
        ) : (
          <Grid min={300} columns={3}>
            {data.cards.map((card) => {
              const status = cardStatus(card, data.today);
              return (
                <Tile
                  key={card.id}
                  label={card.name}
                  icon="creditcard"
                  value={money(card.owed.minor < 0n ? { ...card.owed, minor: -card.owed.minor } : card.owed)}
                  detail={<Status tone={status.tone} icon={status.icon}>{status.text}</Status>}
                >
                  <Row>
                    <PopUpButton
                      size="small"
                      aria-label={`Payment due day for ${card.name}`}
                      options={DAY_OPTIONS}
                      value={card.dueDay === null ? "" : String(card.dueDay)}
                      onChange={(value) => bills.setDueDay(card, value)}
                    />
                    {card.owed.minor > 0n ? (
                      <Button size="small" onClick={() => bills.payCard(card)}>
                        Record Payment…
                      </Button>
                    ) : null}
                  </Row>
                  {card.available ? <Secondary>{money(card.available)} available{card.limit ? ` of ${money(card.limit)}` : ""}</Secondary> : null}
                </Tile>
              );
            })}
          </Grid>
        )}
      </Section>

      <Section title="Bills and income" footer="Select a row to record its payment, edit or remove it; double-click to edit. A payment is recognised from the ledger by its merchant or payer.">
        {data.items.length === 0 ? (
          <Tile>
            <EmptyState
              icon="calendar"
              title="No Bills Yet"
              message="Add the rent, broadband or a subscription, or your salary, to see what is due and plan around it."
              actions={
                <>
                  <Button onClick={() => bills.startNew("out")}>Add Bill…</Button>
                  <Button onClick={() => bills.startNew("in")}>Add Income…</Button>
                </>
              }
            />
          </Tile>
        ) : (
          <Tile flush>
            <ContextMenu
              menu={
                <>
                  <MenuItem icon="square-and-pencil" disabled={!selected || selected.state === "paid"} onSelect={() => selected && bills.payItem(selected)}>
                    Record Payment…
                  </MenuItem>
                  <MenuItem icon="pencil" disabled={!selected} onSelect={() => selected && bills.startEdit(selected)}>
                    Edit…
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon="trash" disabled={!selected} onSelect={() => selected && bills.setRemoving(selected)}>
                    Remove…
                  </MenuItem>
                </>
              }
            >
              <Table
                label="Bills and income"
                columns={columns}
                rows={data.items}
                rowIcon={(r) => (r.direction === "in" ? "arrow-down-circle" : (r.categoryIcon ?? "calendar"))}
                selection={selection}
                onSelectionChange={setSelection}
                onRowAction={(r) => bills.startEdit(r)}
              />
            </ContextMenu>
          </Tile>
        )}
      </Section>

      {data.suggestions.length > 0 ? (
        <Section title="Suggested from your history" footer="Seen about once a month for about the same amount. Nothing is tracked until you add it.">
          <Form>
            <FormSection>
              {data.suggestions.map((s) => (
                <FormRow
                  key={s.key}
                  label={`${s.name} · ${signedAmount(s.direction === "in" ? "income" : "expense", s.amount)}`}
                  subtitle={`${s.direction === "in" ? "Income" : "Bill"} seen in ${plural(s.months, "month")}, around the ${ordinal(s.dueDay)}${s.categoryName ? ` · ${s.categoryName}` : ""}${s.accountName ? ` · ${s.accountName}` : ""} · last ${shortDate(s.lastDate, data.today)}`}
                >
                  <Button size="small" disabled={bills.pending} onClick={() => bills.addSuggestion(s.key)}>
                    Add
                  </Button>
                </FormRow>
              ))}
            </FormSection>
          </Form>
        </Section>
      ) : null}

      {data.loans.length > 0 ? (
        <Section title="Loans" footer="A loan's balance is the whole amount still owed, not this month's bill. Add its instalment as a bill to plan for it.">
          <Form>
            <FormSection>
              {data.loans.map((loan) => (
                <FormRow key={loan.id} label={loan.name} subtitle="Still owed">
                  <span className="pfa-money">{money(loan.owed)}</span>
                </FormRow>
              ))}
            </FormSection>
          </Form>
        </Section>
      ) : null}

      <Section title="How this works">
        <GroupBox>
          {HOW_IT_WORKS.map((line) => (
            <p key={line} style={{ margin: "0 0 6px" }}>
              <Secondary>{line}</Secondary>
            </p>
          ))}
        </GroupBox>
      </Section>

      <MacDraftSheet bills={bills} items={data.items} />

      <Alert
        open={bills.removing !== null}
        onClose={() => bills.setRemoving(null)}
        title={`Remove “${bills.removing?.name ?? ""}”?`}
        message="Its past payments stay in your ledger. It just stops appearing in Bills and the plan."
        buttons={[
          { label: "Remove", role: "destructive", onClick: () => bills.removing && bills.remove(bills.removing.id) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
      <Alert open={bills.failure !== null} onClose={() => bills.setFailure(null)} title="That could not be saved" message={bills.failure ?? ""} />
    </MacPage>
  );
}

function MacDraftSheet({ bills, items }: { bills: ReturnType<typeof useBills>; items: readonly ItemRow[] }) {
  const { draft, setDraft } = bills;
  const set = (change: Partial<Draft>) => draft && setDraft({ ...draft, ...change });
  const existing = draft?.id !== undefined;
  return (
    <Sheet
      open={draft !== null}
      // The kit closes a sheet after its default button; Save closes it only once the save succeeds.
      onClose={(button) => (button === "Cancel" || button === undefined ? setDraft(null) : undefined)}
      title={existing ? `Edit “${draft?.name}”` : "New Bill or Income"}
      top={60}
      buttons={[
        // An alert over a sheet is the kit's way to confirm; the sheet closes once the removal succeeds.
        ...(existing ? [{ label: "Remove…", role: "leading" as const, onClick: () => bills.setRemoving(items.find((item) => item.id === draft?.id) ?? null) }] : []),
        { label: "Cancel", role: "cancel" },
        { label: bills.pending ? "Saving…" : "Save", role: "default", disabled: bills.pending || !draft?.name.trim() || !draft?.amount.trim(), onClick: bills.saveDraft },
      ]}
    >
      {draft ? (
        <FieldGrid
          rows={[
            { label: "Name:", control: <TextField value={draft.name} onChange={(name) => set({ name })} placeholder="Rent, Broadband, Salary" maxLength={60} autoFocus /> },
            {
              label: "Type:",
              control: (
                <SegmentedControl
                  label="Type"
                  options={[{ value: "out", label: "Money out" }, { value: "in", label: "Money in" }]}
                  value={draft.direction}
                  onChange={(value) => set({ direction: value as Direction, categoryId: "", accountId: value === "in" && bills.accountChoices("in").every((o) => o.value !== draft.accountId) ? "" : draft.accountId })}
                />
              ),
            },
            { label: "Amount:", control: <TextField value={draft.amount} onChange={(amount) => set({ amount })} placeholder="0.00" inputMode="decimal" />, note: `What it usually is, in ${bills.draftCurrency}.` },
            { label: "Day of month:", control: <Stepper value={draft.dueDay} min={1} max={31} onChange={(dueDay) => set({ dueDay })} label="Day of month" />, note: "In a shorter month, its last day." },
            { label: "Account:", control: <PopUpButton options={bills.accountChoices(draft.direction)} value={draft.accountId} onChange={(accountId) => set({ accountId })} /> },
            { label: "Category:", control: <PopUpButton options={bills.categoryChoices(draft.direction)} value={draft.categoryId} onChange={(categoryId) => set({ categoryId })} /> },
            {
              label: "Matches:",
              control: <TextField value={draft.matchText} onChange={(matchText) => set({ matchText })} placeholder={draft.name || "Merchant or payer"} maxLength={60} />,
              note: bills.draftError ?? "A payment counts when its merchant or payer contains this. Leave it empty to use the name.",
              ...(bills.draftError ? { error: true } : {}),
            },
          ]}
        />
      ) : null}
    </Sheet>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

function IosBills({ data }: { data: BillsData }) {
  const bills = useBills(data);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const card = data.cards.find((c) => c.id === openCard);

  if (card) {
    const status = cardStatus(card, data.today);
    return (
      <IosPage title={card.name} back={{ label: "Bills", onBack: () => setOpenCard(null) }}>
        <List>
          <ListSection footer="What you spend on the card this month is billed and paid next month, so this is the whole of what is on it today.">
            <ListRow title={card.owed.minor < 0n ? "In credit" : "Owed"} detail={money(card.owed.minor < 0n ? { ...card.owed, minor: -card.owed.minor } : card.owed)} />
            <ListRow title="Payment" detail={<Status tone={status.tone} icon={status.icon}>{status.text}</Status>} />
            {card.available ? <ListRow title="Available credit" detail={money(card.available)} /> : null}
          </ListSection>
          <ListSection footer="The day of the month the bank wants paying. The app cannot know it by itself.">
            <ListRow
              title="Due Day"
              popup={<IosPopUp label="Due Day" options={DAY_OPTIONS} value={card.dueDay === null ? "" : String(card.dueDay)} onChange={(value) => bills.setDueDay(card, value)} />}
            />
          </ListSection>
          {card.owed.minor > 0n ? (
            <ListSection footer="Recorded as a transfer from your bank into the card, never as a second lot of spending.">
              <ListRow title="Record Payment" action onClick={() => bills.payCard(card)} />
            </ListSection>
          ) : null}
        </List>
        <IosFailure bills={bills} />
      </IosPage>
    );
  }

  return (
    <IosPage
      title="Bills"
      subtitle={`${plural(data.totals.toPayCount, "bill")} still to pay this month`}
      trailing={<BarButton icon="plus" label="Add Bill or Income" onClick={() => bills.startNew()} />}
    >
      <IosGrid>
        <IosCard icon="calendar" title="This Month" color="var(--ios-orange)" trailing={data.totals.overdue > 0 ? `${data.totals.overdue} late` : undefined}>
          <IosFacts
            items={[
              { label: "Still to pay", value: money(data.totals.toPay) },
              { label: "Paid", value: money(data.totals.paid) },
              { label: "Income expected", value: money(data.totals.expected) },
              { label: "On cards, due next month", value: money(data.totals.cards) },
            ]}
          />
        </IosCard>
      </IosGrid>

      <List>
        <ListSection header="Credit Cards" footer={data.cards.length === 0 ? "Add a credit card on Accounts and its payment appears here." : "Each card's payment falls due next month for what is on it today."}>
          {data.cards.length === 0 ? (
            <ListRow title="Go to Accounts" href="/accounts" icon="creditcard" iconColor="blue" />
          ) : (
            data.cards.map((c) => {
              const status = cardStatus(c, data.today);
              return (
                <ListRow
                  key={c.id}
                  title={c.name}
                  // Only the status's first part fits beside the amount on a phone; the card's screen has the rest.
                  subtitle={<Status tone={status.tone} icon={status.icon}>{status.text.split(" · ")[0]}</Status>}
                  detail={bare(c.owed.minor < 0n ? { ...c.owed, minor: -c.owed.minor } : c.owed)}
                  icon="creditcard"
                  iconColor="blue"
                  onClick={() => setOpenCard(c.id)}
                  leadingActions={c.owed.minor > 0n ? <ListRowAction label="Pay" icon="square-and-pencil" color="accent" onClick={() => bills.payCard(c)} /> : undefined}
                />
              );
            })
          )}
        </ListSection>

        <ListSection header="Bills & Income" footer="A payment counts when a transaction this month matches it by merchant or payer. Swipe right to record one, left to remove.">
          {data.items.length === 0 ? (
            <ListRow title="Add a Bill or Income" action onClick={() => bills.startNew()} />
          ) : (
            data.items.map((item) => {
              const status = itemStatus(item, data.today);
              return (
                <ListRow
                  key={item.id}
                  title={item.name}
                  // The state alone: a longer subtitle squeezes the amount into an ellipsis. The day and the
                  // account are on the item's edit screen.
                  subtitle={<Status tone={status.tone} icon={status.icon}>{status.text.replace(/^(Expected|Due) in /, "In ").replace(/^(Expected|Due) (today|tomorrow)$/, (_, __, day: string) => day.charAt(0).toUpperCase() + day.slice(1))}</Status>}
                  detail={signedAmount(item.direction === "in" ? "income" : "expense", item.amount, false)}
                  icon={item.direction === "in" ? "arrow-down-circle" : (item.categoryIcon ?? "calendar")}
                  iconColor={item.direction === "in" ? "green" : "orange"}
                  onClick={() => bills.startEdit(item)}
                  leadingActions={
                    item.state !== "paid" ? <ListRowAction label="Record" icon="square-and-pencil" color="accent" onClick={() => bills.payItem(item)} /> : undefined
                  }
                  trailingActions={<ListRowAction label="Remove" icon="trash" destructive onClick={() => bills.setRemoving(item)} />}
                />
              );
            })
          )}
        </ListSection>

        {data.suggestions.length > 0 ? (
          <ListSection header="Suggested" footer="From your last six months: seen about once a month for about the same amount. Nothing is tracked until you add it.">
            {data.suggestions.map((s) => (
              <ListRow
                key={s.key}
                title={s.name}
                subtitle={`${signedAmount(s.direction === "in" ? "income" : "expense", s.amount)} · around the ${ordinal(s.dueDay)} · ${plural(s.months, "month")}`}
                buttonLabel="Add"
                onButtonClick={() => bills.addSuggestion(s.key)}
              />
            ))}
          </ListSection>
        ) : null}

        {data.loans.length > 0 ? (
          <ListSection header="Loans" footer="A loan's balance is the whole amount still owed, not this month's bill. Add its instalment as a bill to plan for it.">
            {data.loans.map((loan) => (
              <ListRow key={loan.id} title={loan.name} subtitle="Still owed" detail={bare(loan.owed)} icon="doc-text" iconColor="gray" />
            ))}
          </ListSection>
        ) : null}

        <ListSection header="How This Works" footer={HOW_IT_WORKS.slice(2).join(" ")}>
          <ListRow title="Card payments" subtitle={HOW_IT_WORKS[0]} />
          <ListRow title="Recorded, not statement, balance" subtitle={HOW_IT_WORKS[1]} />
        </ListSection>
      </List>

      <IosDraftSheet bills={bills} />

      <ActionSheet
        open={bills.removing !== null && bills.draft === null}
        onOpenChange={(open) => !open && bills.setRemoving(null)}
        title={`Remove “${bills.removing?.name ?? ""}”?`}
        message="Its past payments stay in your ledger. It just stops appearing in Bills and the plan."
        actions={[
          { label: "Remove", role: "destructive", onPress: () => bills.removing && bills.remove(bills.removing.id) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
      <IosFailure bills={bills} />
    </IosPage>
  );
}

function IosFailure({ bills }: { bills: ReturnType<typeof useBills> }) {
  return (
    <IosAlert
      open={bills.failure !== null}
      onOpenChange={(open) => !open && bills.setFailure(null)}
      title="Couldn't Save"
      message={bills.failure ?? ""}
      actions={[{ label: "OK", role: "default" }]}
    />
  );
}

function IosDraftSheet({ bills }: { bills: ReturnType<typeof useBills> }) {
  const { draft, setDraft } = bills;
  const [confirming, setConfirming] = useState(false);
  const set = (change: Partial<Draft>) => draft && setDraft({ ...draft, ...change });
  const existing = draft?.id !== undefined;
  const canSave = Boolean(draft?.name.trim() && draft.amount.trim()) && !bills.pending;
  return (
    <IosSheet
      open={draft !== null}
      onOpenChange={(open) => !open && setDraft(null)}
      title={existing ? "Edit" : "New Bill or Income"}
      dismissible={!existing && !draft?.name && !draft?.amount}
      leading={<IosButton variant="glass" onClick={() => setDraft(null)}>Cancel</IosButton>}
      trailing={
        <IosButton variant="glass-prominent" disabled={!canSave} onClick={bills.saveDraft}>
          {bills.pending ? "Saving…" : "Save"}
        </IosButton>
      }
    >
      {draft ? (
        <List>
          <ListSection>
            <ListRow
              control={
                <IosSegmented
                  label="Type"
                  options={[{ value: "out", label: "Money Out" }, { value: "in", label: "Money In" }]}
                  value={draft.direction}
                  onChange={(value) => set({ direction: value as Direction, categoryId: "", accountId: value === "in" && bills.accountChoices("in").every((o) => o.value !== draft.accountId) ? "" : draft.accountId })}
                />
              }
            />
          </ListSection>
          <ListSection footer={`What it usually is, in ${bills.draftCurrency}. In a shorter month, the last day counts.`}>
            <IosFieldRow label="Name">
              <IosTextField value={draft.name} onChange={(name) => set({ name })} placeholder="Required" maxLength={60} />
            </IosFieldRow>
            <IosFieldRow label="Amount">
              <IosTextField value={draft.amount} onChange={(amount) => set({ amount })} placeholder="0.00" inputMode="decimal" />
            </IosFieldRow>
            <ListRow title={`Day ${draft.dueDay} of the month`} control={<IosStepper value={draft.dueDay} min={1} max={31} onChange={(dueDay) => set({ dueDay })} label="Day of month" />} />
          </ListSection>
          <ListSection>
            <ListRow title="Account" popup={<IosPopUp label="Account" options={bills.accountChoices(draft.direction)} value={draft.accountId} onChange={(accountId) => set({ accountId })} />} />
            <ListRow title="Category" popup={<IosPopUp label="Category" options={bills.categoryChoices(draft.direction)} value={draft.categoryId} onChange={(categoryId) => set({ categoryId })} />} />
          </ListSection>
          <ListSection
            footer={bills.draftError ? <Status tone="bad">{bills.draftError}</Status> : "A payment counts when its merchant or payer contains this. Leave it empty to use the name."}
          >
            <IosFieldRow label="Matches">
              <IosTextField value={draft.matchText} onChange={(matchText) => set({ matchText })} placeholder={draft.name || "Merchant"} maxLength={60} />
            </IosFieldRow>
          </ListSection>
          {existing ? (
            <ListSection>
              <ListRow title="Remove" action destructive center onClick={() => setConfirming(true)} />
            </ListSection>
          ) : null}
        </List>
      ) : null}
      <ActionSheet
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove “${draft?.name ?? ""}”?`}
        message="Its past payments stay in your ledger. It just stops appearing in Bills and the plan."
        actions={[
          {
            label: "Remove",
            role: "destructive",
            onPress: () => {
              if (draft?.id) bills.remove(draft.id);
            },
          },
          { label: "Cancel", role: "cancel" },
        ]}
      />
    </IosSheet>
  );
}
