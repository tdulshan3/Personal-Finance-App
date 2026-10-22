"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type { Money } from "../../core/domain/money.ts";
import { bare, dateFromLocal, delta, localFromDate, money, plainAmount, plural } from "../../ui/format.ts";
import {
  ActionSheet,
  Alert as IosAlert,
  BarButton,
  Button as IosButton,
  DatePicker,
  List,
  ListRow,
  ListSection,
  PopUpButton as IosPopUp,
  Sheet as IosSheet,
  TextField as IosTextField,
} from "../../ui/ios/ios.tsx";
import { IosFieldRow } from "../../ui/ios-parts.tsx";
import { iconForAccountType, labelForAccountType } from "../../ui/labels.ts";
import { usePhone } from "../../ui/look.tsx";
import {
  Alert,
  Button,
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
  Section,
  Sheet,
  Stack,
  Table,
  TextField,
  Tile,
  ToolbarButton,
  WindowBody,
} from "../../ui/macos/macos.tsx";
import type { TableColumn } from "../../ui/macos/macos.tsx";
import type { Tone } from "../../ui/page.tsx";
import { IosPage, MacPage, Status, formData } from "../../ui/page.tsx";
import type { AccountFormState } from "./account-actions.ts";
import { createAccountAction, setAccountArchivedAction, updateAccountAction } from "./account-actions.ts";
import { recordDifferenceAction } from "./balance-actions.ts";

export type AccountItem = {
  id: string;
  name: string;
  kind: string;
  type: string;
  currency: string;
  institution: string | null;
  revision: number;
  archived: boolean;
  balance: Money;
  creditLimit: Money | null;
  available: Money | null;
  /** Whole percent of the limit in use, or null without a limit. */
  utilisation: number | null;
  /** Ledger entries recorded against it: what archiving preserves. */
  entries: number;
};

export type BalanceCheckItem = {
  accountId: string;
  accountName: string;
  reported: Money;
  ledger: Money;
  difference: Money;
  observedAt: string;
  compares: "balance" | "available credit";
};

export type AccountsData = {
  today: string;
  currencies: string[];
  defaultCurrency: string;
  accounts: AccountItem[];
  books: { ok: boolean; journals: number; entries: number; problems: string[] };
  checks: BalanceCheckItem[];
};

const TYPES = [
  { value: "bank", label: "Bank" },
  { value: "cash", label: "Cash" },
  { value: "wallet", label: "Wallet" },
  { value: "credit_card", label: "Credit card" },
  { value: "savings", label: "Savings" },
  { value: "loan", label: "Loan" },
];

const isCredit = (account: AccountItem) => account.kind === "liability";

/** "Current balance" is what a card statement calls it; anything else is a recorded balance (§13). */
const balanceLabel = (account: AccountItem) => (isCredit(account) ? "Current balance" : "Recorded balance");

/** The one thing worth flagging about a credit line, as a status word with a tone. */
function creditNote(account: AccountItem): { tone: Tone; text: string } | null {
  if (!isCredit(account)) return null;
  // buildspec.md §20: a card in credit reads as a credit balance, never as debt owed.
  if (account.balance.minor < 0n) return { tone: "good", text: "In credit" };
  if (account.utilisation !== null) return { tone: account.utilisation >= 80 ? "warning" : "neutral", text: `${account.utilisation}% of limit used` };
  return { tone: "neutral", text: "No limit set" };
}

function archiveMessage(account: AccountItem): string {
  return (
    `Its ${plural(account.entries, "ledger entry", "ledger entries")} ${account.entries === 1 ? "stays" : "stay"} exactly as ${account.entries === 1 ? "it is" : "they are"}, ` +
    "and balances still include them. It just stops accepting new transactions and leaves the list. You can restore it at any time."
  );
}

/** Runs a state-returning account action and reports its outcome. */
function useAction() {
  const [pending, start] = useTransition();
  const run = (
    action: (prev: AccountFormState, data: FormData) => Promise<AccountFormState>,
    values: Record<string, string | number | null | undefined>,
    done?: (result: AccountFormState) => void,
  ) => start(async () => done?.(await action({}, formData(values))));
  return { pending, run };
}

export function AccountsView({ data }: { data: AccountsData }) {
  return usePhone() ? <IosAccounts data={data} /> : <MacAccounts data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* The account sheet: New Account and Edit Account, in either look                            */
/* ------------------------------------------------------------------------------------------ */

type Draft = { name: string; type: string; currency: string; institution: string; creditLimit: string; opening: string; openingDate: string };

function draftFor(data: AccountsData, account: AccountItem | null): Draft {
  return {
    name: account?.name ?? "",
    type: account?.type ?? "bank",
    currency: account?.currency ?? data.defaultCurrency,
    institution: account?.institution ?? "",
    creditLimit: account?.creditLimit ? plainAmount(account.creditLimit) : "",
    opening: "",
    openingDate: data.today,
  };
}

/**
 * One sheet for both jobs. Creating asks for everything; editing offers only what can change —
 * currency and type are fixed once anything is recorded against the account.
 */
function AccountSheet({ data, open, editing, onClose }: { data: AccountsData; open: boolean; editing: AccountItem | null; onClose: () => void }) {
  const phone = usePhone();
  const [draft, setDraft] = useState<Draft>(() => draftFor(data, editing));
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useAction();
  // Each opening starts from the account as it is now (or a blank form).
  useEffect(() => {
    if (open) {
      setDraft(draftFor(data, editing));
      setError(null);
    }
  }, [open, editing?.id, editing?.revision]);

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const debt = editing ? isCredit(editing) : draft.type === "credit_card" || draft.type === "loan";
  const currency = editing?.currency ?? draft.currency;
  const title = editing ? "Edit Account" : "New Account";
  const canSave = draft.name.trim().length > 0 && !pending;

  const save = () => {
    if (!canSave) return;
    setError(null);
    const done = (result: AccountFormState) => (result.error ? setError(result.error) : onClose());
    if (editing) {
      run(updateAccountAction, { accountId: editing.id, expectedRevision: editing.revision, name: draft.name, institution: draft.institution, creditLimit: debt ? draft.creditLimit : undefined }, done);
    } else {
      run(createAccountAction, { name: draft.name, type: draft.type, currency: draft.currency, institution: draft.institution, creditLimit: debt ? draft.creditLimit : undefined, opening: draft.opening, openingDate: draft.openingDate }, done);
    }
  };

  const limitNote = "Used to show what is left to spend. It is not money you have, and never counts toward your balance.";
  const openingLabel = debt ? "Amount owed now" : "Verified balance now";
  const openingNote = debt
    ? "Enter what you owe as a positive number. Optional."
    : "Only enter this if you have checked it. Leaving it blank is fine.";
  // buildspec.md §9.4: saying this at the point of entry stops the number being mistaken later for
  // a complete starting point.
  const startingPoint = "Recorded as a starting point on the date you give, not as income. Anything that happened before that date will not change this balance.";
  const fixedNote = "Currency and account type can't be changed — every transaction already recorded against this account assumes both.";

  if (phone) {
    return (
      <IosSheet
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title={title}
        dismissible={!pending}
        leading={<IosButton variant="glass" onClick={onClose}>Cancel</IosButton>}
        trailing={
          <IosButton variant="glass-prominent" disabled={!canSave} onClick={save}>
            {pending ? "Saving…" : editing ? "Save" : "Create"}
          </IosButton>
        }
      >
        <List>
          <ListSection footer={error ? <Status tone="bad">{error}</Status> : editing ? fixedNote : undefined}>
            <IosFieldRow label="Name">
              <IosTextField value={draft.name} onChange={(name) => set({ name })} placeholder="Required" maxLength={80} />
            </IosFieldRow>
            <IosFieldRow label="Institution">
              <IosTextField value={draft.institution} onChange={(institution) => set({ institution })} placeholder="Optional" maxLength={80} />
            </IosFieldRow>
            {editing ? null : (
              <>
                <ListRow title="Type" popup={<IosPopUp label="Type" options={TYPES} value={draft.type} onChange={(type) => set({ type })} />} />
                <ListRow title="Currency" popup={<IosPopUp label="Currency" options={data.currencies} value={draft.currency} onChange={(next) => set({ currency: next })} />} />
              </>
            )}
          </ListSection>
          {debt ? (
            <ListSection footer={`${limitNote} Leave it empty for no limit.`}>
              <IosFieldRow label="Credit limit">
                <IosTextField value={draft.creditLimit} onChange={(creditLimit) => set({ creditLimit })} placeholder="No limit" inputMode="decimal" />
              </IosFieldRow>
            </ListSection>
          ) : null}
          {editing ? null : (
            <ListSection footer={`${openingNote} ${startingPoint}`}>
              <IosFieldRow label={openingLabel}>
                <IosTextField value={draft.opening} onChange={(opening) => set({ opening })} placeholder="0.00" inputMode="decimal" />
              </IosFieldRow>
              <ListRow
                title="Observed on"
                control={<DatePicker components="date" label="Observed on" value={dateFromLocal(draft.openingDate)} max={dateFromLocal(data.today)} onChange={(date) => set({ openingDate: localFromDate(date) })} />}
              />
            </ListSection>
          )}
        </List>
      </IosSheet>
    );
  }

  return (
    <Sheet
      open={open}
      // The kit closes a sheet after its default button runs; saving closes it only on success, so
      // a refused figure stays on screen with its reason.
      onClose={(button) => (button === "Cancel" || button === undefined ? onClose() : undefined)}
      title={title}
      top={60}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: pending ? "Saving…" : editing ? "Save" : "Create", role: "default", disabled: !canSave, onClick: save },
      ]}
    >
      <FieldGrid
        rows={[
          { label: "Name:", control: <TextField value={draft.name} onChange={(name) => set({ name })} placeholder="Everyday bank" maxLength={80} autoFocus /> },
          ...(editing
            ? [
                { label: "Type:", control: <FormValue>{labelForAccountType(editing.type)}</FormValue> },
                { label: "Currency:", control: <FormValue>{editing.currency}</FormValue>, note: fixedNote },
              ]
            : [
                { label: "Type:", control: <PopUpButton options={TYPES} value={draft.type} onChange={(type) => set({ type })} /> },
                { label: "Currency:", control: <PopUpButton options={data.currencies} value={draft.currency} onChange={(next) => set({ currency: next })} />, note: "An account holds one currency. Totals are reported per currency, never added together." },
              ]),
          { label: "Institution:", control: <TextField value={draft.institution} onChange={(institution) => set({ institution })} placeholder="Optional" maxLength={80} /> },
          ...(debt
            ? [{ label: "Credit limit:", control: <TextField value={draft.creditLimit} onChange={(creditLimit) => set({ creditLimit })} placeholder="No limit" inputMode="decimal" />, note: `${limitNote} Leave it empty for no limit.` }]
            : []),
          ...(editing
            ? []
            : [
                { label: `${openingLabel}:`, control: <TextField value={draft.opening} onChange={(opening) => set({ opening })} placeholder={`0.00 ${currency}`} inputMode="decimal" />, note: openingNote },
                { label: "Observed on:", control: <TextField type="date" value={draft.openingDate} max={data.today} onChange={(openingDate) => set({ openingDate })} />, note: startingPoint },
              ]),
          ...(error ? [{ label: "", control: <Status tone="bad">{error}</Status> }] : []),
        ]}
      />
    </Sheet>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* macOS: balance check and tables, the selection in the inspector                            */
/* ------------------------------------------------------------------------------------------ */

function MacAccounts({ data }: { data: AccountsData }) {
  const active = data.accounts.filter((a) => !a.archived);
  const archived = data.accounts.filter((a) => a.archived);
  const [selectedId, setSelectedId] = useState<string | null>(active[0]?.id ?? archived[0]?.id ?? null);
  const selected = data.accounts.find((a) => a.id === selectedId) ?? null;
  const [inspector, setInspector] = useState(true);
  const [sheet, setSheet] = useState<"new" | "edit" | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [recording, setRecording] = useState<BalanceCheckItem | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const { pending, run } = useAction();
  const router = useRouter();
  const showTransactions = (account: AccountItem) => router.push(`/transactions?account=${encodeURIComponent(account.id)}` as Route);

  const report = (result: AccountFormState) => setNotice(result.error ? { tone: "bad", text: result.error } : result.ok ? { tone: "good", text: result.ok } : null);
  const archiveOrRestore = () => {
    if (!selected) return;
    if (selected.archived) run(setAccountArchivedAction, { accountId: selected.id, archived: "true" }, report);
    else setConfirmArchive(true);
  };

  const columns: TableColumn<AccountItem>[] = [
    { key: "name", title: "Account" },
    { key: "type", title: "Type", width: 110, render: (a) => labelForAccountType(a.type) },
    { key: "institution", title: "Institution", width: "16%", render: (a) => a.institution ?? "--" },
    { key: "balance", title: "Balance", width: 160, numeric: true, sortValue: (a) => Number(a.balance.minor), render: (a) => money(a.balance) },
    { key: "available", title: "Available credit", width: 160, numeric: true, sortValue: (a) => Number(a.available?.minor ?? 0n), render: (a) => (a.available ? money(a.available) : "--") },
    {
      key: "note",
      title: "Credit",
      width: 150,
      sortValue: (a) => a.utilisation ?? -1,
      render: (a) => {
        const note = creditNote(a);
        return note ? <Status tone={note.tone}>{note.text}</Status> : "--";
      },
    },
  ];

  const menu = (
    <>
      <MenuItem icon="pencil" disabled={!selected} onSelect={() => setSheet("edit")}>Edit…</MenuItem>
      <MenuItem icon="list-bullet" disabled={!selected} onSelect={() => selected && showTransactions(selected)}>
        Show Transactions
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={selected?.archived ? "arrow-uturn-left" : "archivebox"} disabled={!selected} onSelect={archiveOrRestore}>
        {selected?.archived ? "Restore" : "Archive…"}
      </MenuItem>
    </>
  );

  const table = (rows: AccountItem[], label: string, empty: string) => (
    <Tile flush>
      <ContextMenu menu={menu}>
        <Table
          label={label}
          columns={columns}
          rows={rows}
          rowIcon={(a) => iconForAccountType(a.type)}
          selection={selectedId ? [selectedId] : []}
          onSelectionChange={(ids) => {
            setSelectedId(ids[0] === undefined ? null : String(ids[0]));
            setNotice(null);
          }}
          onRowAction={() => setSheet("edit")}
          defaultSort={{ key: "name", direction: "ascending" }}
          emptyText={empty}
        />
      </ContextMenu>
    </Tile>
  );

  return (
    <MacPage
      title="Accounts"
      subtitle={`${plural(active.length, "account")}${archived.length > 0 ? ` · ${archived.length} archived` : ""}`}
      toolbar={
        <>
          <ToolbarButton icon="plus" label="New Account" onClick={() => setSheet("new")} />
          <ToolbarButton icon="pencil" label="Edit Account" disabled={!selected} onClick={() => setSheet("edit")} />
          <ToolbarButton
            icon={selected?.archived ? "arrow-uturn-left" : "archivebox"}
            label={selected?.archived ? "Restore Account" : "Archive Account"}
            disabled={!selected || pending}
            onClick={archiveOrRestore}
          />
          <ToolbarButton icon="sidebar-right" label={inspector ? "Hide Inspector" : "Show Inspector"} pressed={inspector} onClick={() => setInspector((on) => !on)} />
        </>
      }
      body={
        <WindowBody>
          <Content>
            <Stack>
              <Section
                title="Balance check"
                footer="The first line checks the books against themselves. The rest compare each account with the balance your bank last reported by SMS, as of that moment."
              >
                <Form>
                  <FormSection>
                    <FormRow
                      label="Double-entry ledger"
                      subtitle={
                        data.books.ok
                          ? `${data.books.journals} journals, ${data.books.entries} entries. Every one sums to zero, in every currency.`
                          : data.books.problems.join("; ")
                      }
                    >
                      <FormValue>{data.books.ok ? <Status tone="good">Books balance</Status> : <Status tone="bad">Books do not balance</Status>}</FormValue>
                    </FormRow>
                    {data.checks.length === 0 ? (
                      <FormRow label="Bank-reported balances" subtitle="Kept automatically when you accept a bank message that states one.">
                        <FormValue>None yet</FormValue>
                      </FormRow>
                    ) : (
                      data.checks.map((check) => (
                        <FormRow key={check.accountId} label={check.accountName} subtitle={checkSentence(check)}>
                          {check.difference.minor === 0n ? (
                            <FormValue><Status tone="good">Matches</Status></FormValue>
                          ) : check.compares === "balance" ? (
                            <Button size="small" disabled={pending} onClick={() => setRecording(check)}>Record {delta(check.difference)}…</Button>
                          ) : (
                            <FormValue><Status tone="warning">{delta(check.difference)}</Status></FormValue>
                          )}
                        </FormRow>
                      ))
                    )}
                  </FormSection>
                </Form>
              </Section>

              <Section title="Your accounts" footer="Recorded balances, calculated from what this app knows — not live figures from your bank.">
                {table(active, "Accounts", "No accounts yet. Add one with New Account.")}
              </Section>

              {archived.length > 0 ? (
                <Section title="Archived" footer="These keep every transaction recorded against them, and their balances still compute. They simply do not accept new entries.">
                  {table(archived, "Archived accounts", "None")}
                </Section>
              ) : null}
            </Stack>
          </Content>

          <Inspector hidden={!inspector} width={300}>
            {selected ? (
              <Form>
                <FormSection title={selected.name} footer={notice ? <Status tone={notice.tone}>{notice.text}</Status> : undefined}>
                  <FormRow label={balanceLabel(selected)}><FormValue>{money(selected.balance)}</FormValue></FormRow>
                  <FormRow label="Type"><FormValue>{labelForAccountType(selected.type)}</FormValue></FormRow>
                  <FormRow label="Currency"><FormValue>{selected.currency}</FormValue></FormRow>
                  <FormRow label="Institution"><FormValue>{selected.institution ?? "--"}</FormValue></FormRow>
                  {isCredit(selected) ? (
                    <>
                      <FormRow label="Credit limit"><FormValue>{selected.creditLimit ? money(selected.creditLimit) : "No limit set"}</FormValue></FormRow>
                      {selected.available ? <FormRow label="Available"><FormValue>{money(selected.available)}</FormValue></FormRow> : null}
                      <FormRow label="Credit">
                        <FormValue>{creditNote(selected) ? <Status tone={creditNote(selected)!.tone}>{creditNote(selected)!.text}</Status> : "--"}</FormValue>
                      </FormRow>
                    </>
                  ) : null}
                  <FormRow label="Ledger entries"><FormValue>{selected.entries}</FormValue></FormRow>
                  <FormRow label="Status"><FormValue>{selected.archived ? "Archived" : "Active"}</FormValue></FormRow>
                </FormSection>
                <FormSection>
                  <FormRow label="Details"><Button size="small" onClick={() => setSheet("edit")}>Edit…</Button></FormRow>
                  <FormRow label="Transactions"><Button size="small" onClick={() => showTransactions(selected)}>Show</Button></FormRow>
                  <FormRow label={selected.archived ? "Archived" : "Archive"}>
                    <Button size="small" disabled={pending} onClick={archiveOrRestore}>{selected.archived ? "Restore" : "Archive…"}</Button>
                  </FormRow>
                </FormSection>
              </Form>
            ) : (
              <EmptyState title="No Selection" message="Select an account to see its details." />
            )}
          </Inspector>

          <AccountSheet data={data} open={sheet !== null} editing={sheet === "edit" ? selected : null} onClose={() => setSheet(null)} />

          <Alert
            open={confirmArchive && selected !== null}
            onClose={() => setConfirmArchive(false)}
            title={`Archive “${selected?.name ?? ""}”?`}
            message={selected ? archiveMessage(selected) : undefined}
            buttons={[
              { label: "Archive", role: "default", onClick: () => selected && run(setAccountArchivedAction, { accountId: selected.id, archived: "false" }, report) },
              { label: "Cancel", role: "cancel" },
            ]}
          />

          <Alert
            open={recording !== null}
            onClose={() => setRecording(null)}
            title={recording ? `Record ${delta(recording.difference)} as unexplained?` : ""}
            message={recording ? recordMessage(recording) : undefined}
            buttons={[
              { label: "Record", role: "default", onClick: () => recording && run(recordDifferenceAction, { accountId: recording.accountId }, report) },
              { label: "Cancel", role: "cancel" },
            ]}
          />
        </WindowBody>
      }
    />
  );
}

function checkSentence(check: BalanceCheckItem): string {
  return check.difference.minor === 0n
    ? `Bank reported ${money(check.reported)} on ${check.observedAt}. Your books said the same.`
    : `Bank reported ${check.compares} ${money(check.reported)} on ${check.observedAt}; your books said ${money(check.ledger)}.`;
}

function recordMessage(check: BalanceCheckItem): string {
  return (
    `Best is to find and add the transaction that is missing. If you can't, this records the gap so ${check.accountName} ` +
    "matches your bank. It is labelled “Unexplained difference” and can be undone from Trash."
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS: a list pushed from Home, each account a pushed screen of its own                      */
/* ------------------------------------------------------------------------------------------ */

const tileColor = (account: AccountItem) => (account.archived ? "gray" : isCredit(account) ? "orange" : account.type === "savings" ? "green" : "blue");

function IosAccounts({ data }: { data: AccountsData }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [recording, setRecording] = useState<BalanceCheckItem | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const { pending, run } = useAction();
  const open = data.accounts.find((a) => a.id === openId);
  const active = data.accounts.filter((a) => !a.archived);
  const archived = data.accounts.filter((a) => a.archived);

  if (open) return <IosAccountScreen key={open.id} data={data} account={open} onBack={() => setOpenId(null)} />;

  const row = (account: AccountItem) => {
    const note = creditNote(account);
    return (
      <ListRow
        key={account.id}
        title={account.name}
        // Short, and the figure without its code: on a phone anything longer squeezes the balance
        // into an ellipsis. The institution and the full figure are on the account's own screen.
        subtitle={note?.text ?? labelForAccountType(account.type)}
        detail={bare(account.balance)}
        icon={iconForAccountType(account.type)}
        iconColor={tileColor(account)}
        onClick={() => setOpenId(account.id)}
      />
    );
  };

  return (
    <IosPage title="Accounts" back={{ label: "Home", href: "/" }} trailing={<BarButton icon="plus" label="New Account" onClick={() => setCreating(true)} />}>
      <List>
        <ListSection header="Balance Check" footer={notice ? <Status tone={notice.tone}>{notice.text}</Status> : "Each account against the balance your bank last reported by SMS, as of that moment."}>
          <ListRow
            title="Double-entry ledger"
            subtitle={data.books.ok ? `${data.books.journals} journals, ${data.books.entries} entries, all balanced` : data.books.problems.join("; ")}
            detail={data.books.ok ? <Status tone="good">OK</Status> : <Status tone="bad">Problem</Status>}
          />
          {data.checks.length === 0 ? (
            <ListRow title="Bank-reported balances" subtitle="From bank messages you accept" detail="None yet" />
          ) : (
            data.checks.map((check) => (
              <ListRow
                key={check.accountId}
                title={check.accountName}
                subtitle={checkSentence(check)}
                detail={check.difference.minor === 0n ? <Status tone="good">Matches</Status> : <Status tone="warning">{delta(check.difference)}</Status>}
              />
            ))
          )}
          {data.checks
            .filter((check) => check.difference.minor !== 0n && check.compares === "balance")
            .map((check) => (
              <ListRow key={`record-${check.accountId}`} title={`Record ${delta(check.difference)} for ${check.accountName}…`} action disabled={pending} onClick={() => setRecording(check)} />
            ))}
        </ListSection>

        <ListSection header="Your Accounts" footer="Recorded balances, calculated from what this app knows — not live figures from your bank.">
          {active.length === 0 ? <ListRow title="Add Account" action onClick={() => setCreating(true)} /> : active.map(row)}
        </ListSection>

        {archived.length > 0 ? (
          <ListSection header="Archived" footer="These keep every transaction recorded against them, and their balances still compute. They simply do not accept new entries.">
            {archived.map(row)}
          </ListSection>
        ) : null}
      </List>

      <AccountSheet data={data} open={creating} editing={null} onClose={() => setCreating(false)} />

      <IosAlert
        open={recording !== null}
        onOpenChange={(next) => !next && setRecording(null)}
        title={recording ? `Record ${delta(recording.difference)} as unexplained?` : ""}
        message={recording ? recordMessage(recording) : undefined}
        actions={[
          { label: "Cancel", role: "cancel" },
          {
            label: "Record",
            role: "default",
            onPress: () => {
              if (recording) run(recordDifferenceAction, { accountId: recording.accountId }, (r) => setNotice(r.error ? { tone: "bad", text: r.error } : { tone: "good", text: r.ok ?? "Recorded." }));
            },
          },
        ]}
      />
    </IosPage>
  );
}

function IosAccountScreen({ data, account, onBack }: { data: AccountsData; account: AccountItem; onBack: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const { pending, run } = useAction();
  const note = creditNote(account);
  const report = (result: AccountFormState) => setNotice(result.error ? { tone: "bad", text: result.error } : result.ok ? { tone: "good", text: result.ok } : null);

  return (
    <IosPage title={account.name} back={{ label: "Accounts", onBack }} trailing={<BarButton onClick={() => setEditing(true)}>Edit</BarButton>}>
      <List>
        <ListSection footer="A recorded balance, calculated from what this app knows — not a live figure from your bank.">
          <ListRow title={balanceLabel(account)} detail={money(account.balance)} />
          <ListRow title="Type" detail={labelForAccountType(account.type)} />
          <ListRow title="Currency" detail={account.currency} />
          <ListRow title="Institution" detail={account.institution ?? "None"} />
          {isCredit(account) ? (
            <>
              <ListRow title="Credit limit" detail={account.creditLimit ? money(account.creditLimit) : "No limit set"} />
              {account.available ? <ListRow title="Available" detail={money(account.available)} /> : null}
              {note ? <ListRow title="Credit" detail={<Status tone={note.tone}>{note.text}</Status>} /> : null}
            </>
          ) : null}
          <ListRow title="Ledger entries" detail={String(account.entries)} />
        </ListSection>
        <ListSection>
          <ListRow title="Show Transactions" href={`/transactions?account=${encodeURIComponent(account.id)}`} />
        </ListSection>
        <ListSection footer={notice ? <Status tone={notice.tone}>{notice.text}</Status> : account.archived ? "Archived accounts keep their history and still count in balances." : undefined}>
          {account.archived ? (
            <ListRow title="Restore Account" action disabled={pending} onClick={() => run(setAccountArchivedAction, { accountId: account.id, archived: "true" }, report)} />
          ) : (
            <ListRow title="Archive Account" action destructive disabled={pending} onClick={() => setConfirm(true)} />
          )}
        </ListSection>
      </List>

      <AccountSheet data={data} open={editing} editing={account} onClose={() => setEditing(false)} />

      <ActionSheet
        open={confirm}
        onOpenChange={setConfirm}
        title={`Archive “${account.name}”?`}
        message={archiveMessage(account)}
        actions={[
          { label: "Archive Account", role: "destructive", onPress: () => run(setAccountArchivedAction, { accountId: account.id, archived: "false" }, report) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
    </IosPage>
  );
}
