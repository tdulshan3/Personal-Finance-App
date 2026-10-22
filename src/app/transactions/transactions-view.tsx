"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { Money } from "../../core/domain/money.ts";
import { dateFromLocal, localFromDate, plural, shortDate, signedAmount } from "../../ui/format.ts";
import { useFrame } from "../../ui/frame.tsx";
import {
  BarButton,
  Button as IosButton,
  DatePicker,
  EmptyState as IosEmptyState,
  List,
  ListRow,
  ListRowAction,
  ListSection,
  Menu,
  MenuDivider,
  MenuItem as IosMenuItem,
  MenuSection,
  SearchField as IosSearchField,
  Sheet as IosSheet,
} from "../../ui/ios/ios.tsx";
import type { IconName } from "../../ui/labels.ts";
import { usePhone } from "../../ui/look.tsx";
import {
  Button,
  Checkbox,
  Content,
  ContextMenu,
  EmptyState,
  FieldGrid,
  Form,
  FormRow,
  FormSection,
  FormValue,
  Inspector,
  MenuItem,
  MenuSeparator,
  PopUpButton,
  Row,
  SearchField,
  SegmentedControl,
  Spacer,
  Table,
  TextField,
  ToolbarButton,
  WindowBody,
} from "../../ui/macos/macos.tsx";
import type { RowId, TableColumn } from "../../ui/macos/macos.tsx";
import { IosPage, MacPage, Status } from "../../ui/page.tsx";
import { useTrashCommands } from "./trash-commands.tsx";

export type TxRow = {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  categoryName: string | null;
  icon: IconName;
  account: string | null;
  date: string;
  precision: string | null;
  historyOnly: boolean;
  amount: Money;
  revision: number;
  notes: string | null;
};

export type Filters = {
  text: string;
  accountId: string;
  categoryId: string;
  from: string;
  to: string;
  includeHistoryOnly: boolean;
  trash: boolean;
};

export type TransactionsData = {
  today: string;
  filters: Filters;
  exportHref: string;
  otherViewHref: string;
  limitReached: boolean;
  rows: TxRow[];
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string; kind: "expense" | "income" }[];
};

/** The filters as this screen's URL: they live in GET parameters, never in hidden state. */
function hrefFor(filters: Filters): Route {
  const query = new URLSearchParams();
  if (filters.text.trim()) query.set("q", filters.text.trim());
  if (filters.accountId) query.set("account", filters.accountId);
  if (filters.categoryId) query.set("category", filters.categoryId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.includeHistoryOnly) query.set("history", "1");
  if (filters.trash) query.set("view", "trash");
  const text = query.toString();
  return (text ? `/transactions?${text}` : "/transactions") as Route;
}

type Preset = "all" | "month" | "last" | "3m" | "year";

/** Common date ranges, worked out from today's local date as plain calendar strings. */
function presetRange(preset: Preset, today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const first = (y: number, m: number) => {
    const index = y * 12 + (m - 1);
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
  };
  const last = (y: number, m: number) => {
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const index = y * 12 + (m - 1);
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-${String(days).padStart(2, "0")}`;
  };
  switch (preset) {
    case "month":
      return { from: first(year, month), to: today };
    case "last": {
      const y = month === 1 ? year - 1 : year;
      const m = month === 1 ? 12 : month - 1;
      return { from: first(y, m), to: last(y, m) };
    }
    case "3m":
      return { from: first(year, month - 2), to: today };
    case "year":
      return { from: `${year}-01-01`, to: today };
    default:
      return { from: "", to: "" };
  }
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: "all", label: "All Time" },
  { value: "month", label: "This Month" },
  { value: "last", label: "Last Month" },
  { value: "3m", label: "Last 3 Months" },
  { value: "year", label: "This Year" },
];

function presetOf(filters: Filters, today: string): Preset | null {
  return PRESETS.find((p) => {
    const range = presetRange(p.value, today);
    return range.from === filters.from && range.to === filters.to;
  })?.value ?? null;
}

/** What the list is showing, in words: "Groceries · Everyday Bank · 1 Oct to 22 Oct". */
function describeFilters(data: TransactionsData): string[] {
  const { filters, today } = data;
  const parts: string[] = [];
  if (filters.text) parts.push(`“${filters.text}”`);
  if (filters.categoryId) parts.push(data.categories.find((c) => c.id === filters.categoryId)?.name ?? filters.categoryId);
  if (filters.accountId) parts.push(data.accounts.find((a) => a.id === filters.accountId)?.name ?? "One account");
  const preset = presetOf(filters, today);
  if (preset && preset !== "all") parts.push(PRESETS.find((p) => p.value === preset)!.label);
  else if (filters.from || filters.to) parts.push(`${filters.from ? shortDate(filters.from, today) : "Start"} to ${filters.to ? shortDate(filters.to, today) : "today"}`);
  if (filters.includeHistoryOnly && !filters.trash) parts.push("with history-only");
  return parts;
}

const hasFilters = (f: Filters) => Boolean(f.text || f.accountId || f.categoryId || f.from || f.to || f.includeHistoryOnly);

/** The labels a record carries besides its category: §16's date-only note and history-only. */
const labelsOf = (row: TxRow) => [row.precision, row.historyOnly ? "History only" : null].filter(Boolean).join(" · ");

/**
 * What a list row adds. The list shows dates and never times, so §16's precision note says nothing
 * there and only crowds out the amount; the inspector and the detail screen still show it.
 */
const rowLabelsOf = (row: TxRow) => (row.historyOnly ? "History only" : "");

function useLedger(data: TransactionsData) {
  const router = useRouter();
  const { addTransaction } = useFrame();
  const [text, setText] = useState(data.filters.text);
  // The search text this screen last put in the URL. Only a URL change from elsewhere (Back, Clear
  // Filters) is copied into the field, so a result arriving mid-typing never eats keystrokes.
  const pushed = useRef(data.filters.text);
  const go = (next: Partial<Filters>, replace = false) => {
    const merged = { ...data.filters, text, ...next };
    pushed.current = merged.text.trim();
    if (next.text !== undefined) setText(next.text);
    if (replace) router.replace(hrefFor(merged), { scroll: false });
    else router.push(hrefFor(merged), { scroll: false });
  };

  // Searching follows the typing after a short pause, without a history entry per keystroke.
  const latest = useRef(data.filters);
  latest.current = data.filters;
  useEffect(() => {
    if (text.trim() === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = text.trim();
      router.replace(hrefFor({ ...latest.current, text }), { scroll: false });
    }, 450);
    return () => clearTimeout(timer);
  }, [text, router]);
  useEffect(() => {
    if (data.filters.text === pushed.current) return;
    pushed.current = data.filters.text;
    setText(data.filters.text);
  }, [data.filters.text]);

  const multiCurrency = new Set(data.rows.map((r) => r.amount.currency.code)).size > 1;
  const summary = [
    data.filters.trash ? plural(data.rows.length, "deleted record") : `${data.rows.length} shown`,
    ...describeFilters(data),
  ].join(" · ");
  return { router, addTransaction, text, setText, go, multiCurrency, summary, trash: useTrashCommands() };
}

export function TransactionsView({ data }: { data: TransactionsData }) {
  return usePhone() ? <IosTransactions data={data} /> : <MacTransactions data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS: table + inspector, commands on the selection                                          */
/* ------------------------------------------------------------------------------------------ */

function MacTransactions({ data }: { data: TransactionsData }) {
  const ledger = useLedger(data);
  const { router, trash } = ledger;
  const [selection, setSelection] = useState<RowId[]>([]);
  const [showInspector, setShowInspector] = useState(true);
  const selected = data.rows.find((r) => selection.includes(r.id));
  const inTrash = data.filters.trash;
  const open = (row: TxRow) => router.push(`/transactions/${row.id}` as Route);
  const act = (row: TxRow | undefined) => {
    if (!row) return;
    if (inTrash) trash.restore({ id: row.id, revision: row.revision, title: row.title });
    else trash.askToTrash({ id: row.id, revision: row.revision, title: row.title });
  };

  // ⌘⌫ moves the selected record to Trash (⌘⌫ restores it in the Trash view), as in the Finder.
  const actRef = useRef(act);
  actRef.current = act;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && selectedRef.current) {
        event.preventDefault();
        actRef.current(selectedRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const columns: TableColumn<TxRow>[] = [
    { key: "date", title: "Date", width: 96, render: (r) => shortDate(r.date, data.today) },
    {
      key: "title",
      title: "Merchant or payer",
      render: (r) => (
        <>
          {r.title}
          {rowLabelsOf(r) ? <span className="mac-label-secondary"> · {rowLabelsOf(r)}</span> : null}
        </>
      ),
    },
    { key: "categoryName", title: "Category", width: "18%", render: (r) => r.categoryName ?? r.kindLabel },
    { key: "account", title: "Account", width: "22%", render: (r) => r.account ?? "--" },
    { key: "amount", title: "Amount", width: 150, numeric: true, sortValue: (r) => Number(r.amount.minor) * (r.kind === "expense" ? -1 : 1), render: (r) => signedAmount(r.kind, r.amount) },
  ];

  const subtitle = trash.message ? <Status tone={trash.message.tone}>{trash.message.text}</Status> : data.limitReached ? `${ledger.summary} · first ${data.rows.length}, narrow the filters for more` : ledger.summary;

  return (
    <MacPage
      title={inTrash ? "Trash" : "Transactions"}
      subtitle={subtitle}
      toolbar={
        <>
          <SegmentedControl
            label="Show"
            options={[{ value: "ledger", label: "Transactions" }, { value: "trash", label: "Trash" }]}
            value={inTrash ? "trash" : "ledger"}
            onChange={(value) => ledger.go({ trash: value === "trash" })}
          />
          {inTrash ? null : <ToolbarButton icon="plus" label="New Transaction" onClick={() => ledger.addTransaction()} />}
          {inTrash ? (
            <ToolbarButton icon="arrow-uturn-left" label="Restore" disabled={!selected || trash.pending} onClick={() => act(selected)} />
          ) : (
            <ToolbarButton icon="trash" label="Move to Trash" disabled={!selected || trash.pending} onClick={() => act(selected)} />
          )}
          <ToolbarButton icon="line-3-horizontal" label="Filter" popover={<FilterPopover data={data} onApply={(next) => ledger.go(next)} />} />
          <ToolbarButton icon="square-and-arrow-up" label="Export as CSV" onClick={() => window.location.assign(data.exportHref)} />
          <ToolbarButton icon="sidebar-right" label={showInspector ? "Hide Inspector" : "Show Inspector"} pressed={showInspector} onClick={() => setShowInspector((on) => !on)} />
        </>
      }
      search={<SearchField value={ledger.text} onChange={ledger.setText} width={200} placeholder="Merchant or notes" label="Search transactions" />}
      body={
        <WindowBody>
          {data.rows.length === 0 ? (
            <Content>
              <EmptyState
                icon={inTrash ? "trash" : "magnifyingglass"}
                title={inTrash ? "Trash Is Empty" : hasFilters(data.filters) ? "No Transactions Match" : "No Transactions"}
                message={
                  inTrash
                    ? "Deleted transactions wait here until you restore them."
                    : hasFilters(data.filters)
                      ? "Try a wider date range or clear the filters."
                      : "Record one with the + button, or accept a bank message in Review."
                }
                actions={
                  hasFilters(data.filters) ? (
                    <Button onClick={() => ledger.go({ text: "", accountId: "", categoryId: "", from: "", to: "", includeHistoryOnly: false })}>Clear Filters</Button>
                  ) : inTrash ? null : (
                    <Button variant="prominent" onClick={() => ledger.addTransaction()}>New Transaction</Button>
                  )
                }
              />
            </Content>
          ) : (
            <Content flush>
              <ContextMenu
                menu={
                  <>
                    <MenuItem icon="doc-text" disabled={!selected} onSelect={() => selected && open(selected)}>Open</MenuItem>
                    <MenuSeparator />
                    {inTrash ? (
                      <MenuItem icon="arrow-uturn-left" shortcut="⌘⌫" disabled={!selected} onSelect={() => act(selected)}>Restore</MenuItem>
                    ) : (
                      <MenuItem icon="trash" shortcut="⌘⌫" disabled={!selected} onSelect={() => act(selected)}>Move to Trash</MenuItem>
                    )}
                  </>
                }
              >
                <Table
                  label={inTrash ? "Deleted transactions" : "Transactions"}
                  columns={columns}
                  rows={data.rows}
                  rowIcon={(r) => r.icon}
                  selection={selection}
                  onSelectionChange={setSelection}
                  onRowAction={open}
                  sticky
                />
              </ContextMenu>
            </Content>
          )}
          <Inspector hidden={!showInspector} label="Transaction details">
            {selected ? (
              <>
                <Form>
                  <FormSection title={selected.title}>
                    <FormRow label="Type"><FormValue>{selected.kindLabel}</FormValue></FormRow>
                    <FormRow label="Amount"><FormValue>{signedAmount(selected.kind, selected.amount)}</FormValue></FormRow>
                    <FormRow label="Date"><FormValue>{shortDate(selected.date)}</FormValue></FormRow>
                    {selected.account ? <FormRow label={selected.kind === "transfer" ? "Accounts" : "Account"}><FormValue>{selected.account}</FormValue></FormRow> : null}
                    {selected.categoryName ? <FormRow label="Category"><FormValue>{selected.categoryName}</FormValue></FormRow> : null}
                    {selected.notes ? <FormRow label="Notes"><FormValue>{selected.notes}</FormValue></FormRow> : null}
                  </FormSection>
                  {labelsOf(selected) ? (
                    <FormSection footer={selected.historyOnly ? "Kept for categories and estimates only. It is from before the tracked balance starts, so it never changes today's balance." : "Only the day is known, so it is never ordered within the day."}>
                      <FormRow label="Recorded as"><FormValue>{labelsOf(selected)}</FormValue></FormRow>
                    </FormSection>
                  ) : null}
                </Form>
                <Row>
                  {inTrash ? (
                    <Button disabled={trash.pending} onClick={() => act(selected)}>Restore</Button>
                  ) : (
                    <Button variant="destructive" disabled={trash.pending} onClick={() => act(selected)}>Move to Trash</Button>
                  )}
                  <Spacer />
                  <Button variant="prominent" onClick={() => open(selected)}>Open</Button>
                </Row>
              </>
            ) : (
              <EmptyState title="No Selection" message="Select a transaction to see it here. Double-click opens it." />
            )}
          </Inspector>
          {trash.dialog}
        </WindowBody>
      }
    />
  );
}

/** The filters as a small dialog in a popover: changes apply together, so the list moves once. */
function FilterPopover({ data, onApply }: { data: TransactionsData; onApply: (next: Partial<Filters>) => void }) {
  const [draft, setDraft] = useState(data.filters);
  useEffect(() => setDraft(data.filters), [data.filters]);
  const preset = presetOf(draft, data.today);
  return (
    <>
      <FieldGrid
        rows={[
          {
            label: "Period:",
            control: (
              <PopUpButton
                options={[...PRESETS.map((p) => ({ value: p.value, label: p.label })), { value: "custom", label: "Custom Range" }]}
                value={preset ?? "custom"}
                onChange={(value) => value !== "custom" && setDraft({ ...draft, ...presetRange(value as Preset, data.today) })}
              />
            ),
          },
          { label: "From:", control: <TextField type="date" value={draft.from} max={draft.to || data.today} onChange={(from) => setDraft({ ...draft, from })} /> },
          { label: "To:", control: <TextField type="date" value={draft.to} min={draft.from || undefined} onChange={(to) => setDraft({ ...draft, to })} /> },
          {
            label: "Account:",
            control: <PopUpButton options={[{ value: "", label: "All Accounts" }, ...data.accounts.map((a) => ({ value: a.id, label: a.name }))]} value={draft.accountId} onChange={(accountId) => setDraft({ ...draft, accountId })} />,
          },
          {
            label: "Category:",
            control: <PopUpButton options={[{ value: "", label: "All Categories" }, ...data.categories.map((c) => ({ value: c.id, label: c.name }))]} value={draft.categoryId} onChange={(categoryId) => setDraft({ ...draft, categoryId })} />,
          },
          {
            label: "",
            control: <Checkbox label="Include history-only records" checked={draft.includeHistoryOnly} onChange={(includeHistoryOnly) => setDraft({ ...draft, includeHistoryOnly })} />,
            note: "Records from before an account's tracking started. They never change a balance.",
          },
        ]}
      />
      <Row>
        <Button onClick={() => onApply({ accountId: "", categoryId: "", from: "", to: "", includeHistoryOnly: false })}>Clear</Button>
        <Spacer />
        <Button variant="prominent" onClick={() => onApply(draft)}>Apply</Button>
      </Row>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS: search, a filter menu, one section per day, swipe actions                               */
/* ------------------------------------------------------------------------------------------ */

function dayHeader(date: string, today: string): string {
  const yesterday = localFromDate(new Date(dateFromLocal(today).getTime() - 86_400_000));
  if (date === today) return "Today";
  if (date === yesterday) return "Yesterday";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }), timeZone: "UTC" });
}

function IosTransactions({ data }: { data: TransactionsData }) {
  const ledger = useLedger(data);
  const { trash } = ledger;
  const [rangeOpen, setRangeOpen] = useState(false);
  const inTrash = data.filters.trash;
  const preset = presetOf(data.filters, data.today);

  const days: { date: string; rows: TxRow[] }[] = [];
  for (const row of data.rows) {
    const last = days[days.length - 1];
    if (last && last.date === row.date) last.rows.push(row);
    else days.push({ date: row.date, rows: [row] });
  }
  const clear = () => ledger.go({ text: "", accountId: "", categoryId: "", from: "", to: "", includeHistoryOnly: false });

  const filterMenu = (
    <Menu label="Filter" trigger={<BarButton icon="line-3-horizontal" label="Filter" {...(hasFilters({ ...data.filters, text: "" }) ? { tinted: true } : {})} />}>
      <MenuSection title="Period">
        {PRESETS.map((p) => (
          <IosMenuItem key={p.value} role="menuitemradio" label={p.label} checked={preset === p.value} onSelect={() => ledger.go(presetRange(p.value, data.today))} />
        ))}
        <IosMenuItem role="menuitemradio" label="Custom Range…" checked={preset === null} onSelect={() => setRangeOpen(true)} />
      </MenuSection>
      <IosMenuItem icon="creditcard" label="Account" subtitle={data.accounts.find((a) => a.id === data.filters.accountId)?.name ?? "All Accounts"}>
        <IosMenuItem role="menuitemradio" label="All Accounts" checked={!data.filters.accountId} onSelect={() => ledger.go({ accountId: "" })} />
        {data.accounts.map((a) => (
          <IosMenuItem key={a.id} role="menuitemradio" label={a.name} checked={data.filters.accountId === a.id} onSelect={() => ledger.go({ accountId: a.id })} />
        ))}
      </IosMenuItem>
      <IosMenuItem icon="tag" label="Category" subtitle={data.categories.find((c) => c.id === data.filters.categoryId)?.name ?? "All Categories"}>
        <IosMenuItem role="menuitemradio" label="All Categories" checked={!data.filters.categoryId} onSelect={() => ledger.go({ categoryId: "" })} />
        {data.categories.map((c) => (
          <IosMenuItem key={c.id} role="menuitemradio" label={c.name} checked={data.filters.categoryId === c.id} onSelect={() => ledger.go({ categoryId: c.id })} />
        ))}
      </IosMenuItem>
      {inTrash ? null : (
        <IosMenuItem label="Include History-Only" checked={data.filters.includeHistoryOnly} onSelect={() => ledger.go({ includeHistoryOnly: !data.filters.includeHistoryOnly })} />
      )}
      <MenuDivider />
      <IosMenuItem icon={inTrash ? "list-bullet" : "trash"} label={inTrash ? "Show Transactions" : "Show Trash"} onSelect={() => ledger.go({ trash: !inTrash })} />
      <IosMenuItem icon="square-and-arrow-up" label="Export as CSV" onSelect={() => window.location.assign(data.exportHref)} />
      {hasFilters(data.filters) ? <IosMenuItem icon="xmark-circle-fill" label="Clear Filters" onSelect={clear} /> : null}
    </Menu>
  );

  return (
    <IosPage
      title={inTrash ? "Trash" : "Transactions"}
      subtitle={trash.message ? <Status tone={trash.message.tone}>{trash.message.text}</Status> : ledger.summary}
      back={inTrash ? { label: "Transactions", href: data.otherViewHref as Route } : undefined}
      accessory={<IosSearchField value={ledger.text} onChange={ledger.setText} placeholder="Merchant or notes" label="Search transactions" />}
      trailing={
        <>
          {filterMenu}
          {inTrash ? null : <BarButton icon="plus" label="New Transaction" onClick={() => ledger.addTransaction()} />}
        </>
      }
    >
      {data.rows.length === 0 ? (
        <IosEmptyState
          icon={inTrash ? "trash" : "magnifyingglass"}
          title={inTrash ? "Trash Is Empty" : hasFilters(data.filters) ? "No Results" : "No Transactions"}
          description={
            inTrash
              ? "Deleted transactions wait here until you restore them."
              : hasFilters(data.filters)
                ? "Try a wider date range or clear the filters."
                : "Record one with the + button, or accept a bank message in Review."
          }
          {...(hasFilters(data.filters) ? { actionLabel: "Clear Filters", onAction: clear } : inTrash ? {} : { actionLabel: "New Transaction", onAction: () => ledger.addTransaction() })}
        />
      ) : (
        <List>
          {days.map((day, index) => (
            <ListSection
              key={day.date}
              header={dayHeader(day.date, data.today)}
              footer={index === days.length - 1 && data.limitReached ? `The first ${data.rows.length} are shown. Narrow the filters to see older ones.` : undefined}
            >
              {day.rows.map((row) => (
                <ListRow
                  key={row.id}
                  title={row.title}
                  subtitle={[row.categoryName ?? row.kindLabel, row.account, rowLabelsOf(row) || null].filter(Boolean).join(" · ")}
                  detail={signedAmount(row.kind, row.amount, ledger.multiCurrency)}
                  href={`/transactions/${row.id}`}
                  trailingActions={
                    inTrash ? (
                      <ListRowAction label="Restore" icon="arrow-uturn-left" color="accent" onClick={() => trash.restore({ id: row.id, revision: row.revision, title: row.title })} />
                    ) : (
                      <ListRowAction label="Delete" icon="trash" destructive onClick={() => trash.askToTrash({ id: row.id, revision: row.revision, title: row.title })} />
                    )
                  }
                />
              ))}
            </ListSection>
          ))}
        </List>
      )}
      <RangeSheet
        open={rangeOpen}
        onClose={() => setRangeOpen(false)}
        today={data.today}
        from={data.filters.from}
        to={data.filters.to}
        onApply={(range) => {
          setRangeOpen(false);
          ledger.go(range);
        }}
      />
      {trash.dialog}
    </IosPage>
  );
}

/** A custom date range: two date pickers in a medium sheet. */
function RangeSheet({ open, onClose, today, from, to, onApply }: { open: boolean; onClose: () => void; today: string; from: string; to: string; onApply: (range: { from: string; to: string }) => void }) {
  const [start, setStart] = useState(from || `${today.slice(0, 8)}01`);
  const [end, setEnd] = useState(to || today);
  useEffect(() => {
    if (!open) return;
    setStart(from || `${today.slice(0, 8)}01`);
    setEnd(to || today);
  }, [open, from, to, today]);
  return (
    <IosSheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Date Range"
      detents={["medium", "large"]}
      leading={<IosButton variant="glass" onClick={onClose}>Cancel</IosButton>}
      trailing={<IosButton variant="glass-prominent" onClick={() => onApply(start <= end ? { from: start, to: end } : { from: end, to: start })}>Apply</IosButton>}
    >
      <List>
        <ListSection footer="Both days are included.">
          <ListRow title="From" control={<DatePicker components="date" label="From" value={dateFromLocal(start)} max={dateFromLocal(today)} onChange={(d) => setStart(localFromDate(d))} />} />
          <ListRow title="To" control={<DatePicker components="date" label="To" value={dateFromLocal(end)} max={dateFromLocal(today)} onChange={(d) => setEnd(localFromDate(d))} />} />
        </ListSection>
      </List>
    </IosSheet>
  );
}
