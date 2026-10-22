"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import type { Money } from "../../../core/domain/money.ts";
import { dateFromLocal, localFromDate, longDate, signedAmount } from "../../../ui/format.ts";
import {
  BarButton,
  Button as IosButton,
  DatePicker,
  List,
  ListRow,
  ListSection,
  PopUpButton as IosPopUp,
  Sheet as IosSheet,
  TextField as IosTextField,
} from "../../../ui/ios/ios.tsx";
import { IosFieldRow } from "../../../ui/ios-parts.tsx";
import { usePhone } from "../../../ui/look.tsx";
import { Button, FieldGrid, Form, FormRow, FormSection, FormValue, PopUpButton, Section, Sheet, TextArea, TextField, ToolbarButton } from "../../../ui/macos/macos.tsx";
import type { Tone } from "../../../ui/page.tsx";
import { IosPage, MacPage, Secondary, Status, formData } from "../../../ui/page.tsx";
import { useTrashCommands } from "../trash-commands.tsx";
import { editTransactionAction } from "./actions.ts";

export type EditData = {
  kind: "expense" | "income";
  accountId: string;
  /** Plain major units with no code and no grouping, e.g. "3450.00" — never a number. */
  amountValue: string;
  date: string;
  /** The latest date the picker offers: today, or the record's own date if that is later. */
  maxDate: string;
  categoryId: string;
  merchantName: string;
  notes: string;
  /** More than one means the record is split, which this single-category form would flatten. */
  splitCount: number;
  accounts: { id: string; name: string; currency: string; archived: boolean }[];
  categories: { id: string; name: string }[];
};

export type DetailData = {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  status: string;
  precision: string | null;
  historyOnly: boolean;
  changes: number;
  amount: Money;
  date: string;
  accountLines: { label: string; value: string }[];
  categories: string[];
  merchant: string | null;
  notes: string | null;
  revision: number;
  notEditable: string | null;
  edit: EditData | null;
};

const STATUS: Record<string, { text: string; tone: Tone }> = {
  posted: { text: "Posted", tone: "good" },
  pending: { text: "Pending", tone: "neutral" },
  deleted: { text: "In Trash", tone: "warning" },
  merged: { text: "Merged", tone: "neutral" },
};

const HISTORY_ONLY_NOTE = "Kept for categories and estimates only. It is from before the tracked balance starts, so it is never added to today's balance.";
const EDIT_NOTE = "Saving keeps the original in this record's history: the old entry is reversed and a corrected one takes its place.";

function useDetail(data: DetailData) {
  const router = useRouter();
  const trash = useTrashCommands();
  const [editing, setEditing] = useState(false);
  const status = STATUS[data.status] ?? { text: data.status, tone: "neutral" as Tone };
  const target = { id: data.id, revision: data.revision, title: data.title };
  const history = data.changes > 0 ? `Edited ${data.changes} ${data.changes === 1 ? "time" : "times"}` : "Not edited since it was recorded";
  return { router, trash, editing, setEditing, status, target, history };
}

export function DetailView({ data }: { data: DetailData }) {
  return usePhone() ? <IosDetail data={data} /> : <MacDetail data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function MacDetail({ data }: { data: DetailData }) {
  const { router, trash, editing, setEditing, status, target, history } = useDetail(data);
  return (
    <MacPage
      title={data.title}
      subtitle={trash.message ? <Status tone={trash.message.tone}>{trash.message.text}</Status> : `${data.kindLabel} · ${longDate(data.date)}`}
      toolbar={
        <>
          <ToolbarButton icon="chevron-left" label="All Transactions" onClick={() => router.push("/transactions")} />
          {data.edit ? <ToolbarButton icon="pencil" label="Edit" onClick={() => setEditing(true)} /> : null}
          {data.status === "posted" ? (
            <ToolbarButton icon="trash" label="Move to Trash" disabled={trash.pending} onClick={() => trash.askToTrash(target)} />
          ) : data.status === "deleted" ? (
            <ToolbarButton icon="arrow-uturn-left" label="Restore" disabled={trash.pending} onClick={() => trash.restore(target)} />
          ) : null}
          <ToolbarButton icon="clock" label="Show in Activity" onClick={() => router.push("/activity")} />
        </>
      }
    >
      <Section title="Details">
        <Form style={{ maxWidth: 640 }}>
          <FormSection footer={data.historyOnly ? HISTORY_ONLY_NOTE : undefined}>
            <FormRow label="Status">
              <FormValue>
                <Status tone={status.tone}>{status.text}</Status>
                {data.historyOnly ? " · History only" : ""}
              </FormValue>
            </FormRow>
            <FormRow label="Type"><FormValue>{data.kindLabel}</FormValue></FormRow>
            <FormRow label="Amount"><FormValue>{signedAmount(data.kind, data.amount)}</FormValue></FormRow>
            {/* §16: a date-only record must never be shown as though the time were known. */}
            <FormRow label="Date" {...(data.precision ? { subtitle: data.precision } : {})}><FormValue>{longDate(data.date)}</FormValue></FormRow>
            {data.accountLines.map((line) => (
              <FormRow key={line.label} label={line.label}><FormValue>{line.value}</FormValue></FormRow>
            ))}
            {data.categories.length > 0 ? (
              <FormRow label={data.categories.length > 1 ? "Categories" : "Category"}><FormValue>{data.categories.join(", ")}</FormValue></FormRow>
            ) : null}
            {data.merchant ? <FormRow label={data.kind === "income" ? "Payer" : "Merchant"}><FormValue>{data.merchant}</FormValue></FormRow> : null}
            {data.notes ? <FormRow label="Notes"><FormValue>{data.notes}</FormValue></FormRow> : null}
          </FormSection>
          <FormSection
            title="History"
            footer={
              data.status === "deleted"
                ? "Deleted records keep their history and can be restored."
                : data.status === "posted"
                  ? "Moving it to Trash reverses its effect on your balances straight away, and you can restore it from Trash."
                  : undefined
            }
          >
            <FormRow label="Changes"><FormValue>{history}</FormValue></FormRow>
            <FormRow label="Every change, with who made it">
              <Button size="small" onClick={() => router.push("/activity")}>Show in Activity</Button>
            </FormRow>
          </FormSection>
          <FormSection title="Correct it" footer={data.edit ? EDIT_NOTE : (data.notEditable ?? undefined)}>
            {data.edit ? (
              <FormRow label="Amount, date, account, category, merchant or notes">
                <Button size="small" onClick={() => setEditing(true)}>Edit…</Button>
              </FormRow>
            ) : data.status === "deleted" ? (
              <FormRow label="In Trash">
                <Button size="small" disabled={trash.pending} onClick={() => trash.restore(target)}>Restore</Button>
              </FormRow>
            ) : (
              <FormRow label="Editing"><FormValue>Not available for this record</FormValue></FormRow>
            )}
          </FormSection>
        </Form>
      </Section>
      {data.edit ? <EditSheet key={data.revision} open={editing} onClose={() => setEditing(false)} data={data} edit={data.edit} /> : null}
      {trash.dialog}
    </MacPage>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

function IosDetail({ data }: { data: DetailData }) {
  const { router, trash, editing, setEditing, status, target, history } = useDetail(data);
  return (
    <IosPage
      title={data.title}
      subtitle={trash.message ? <Status tone={trash.message.tone}>{trash.message.text}</Status> : undefined}
      back={{ label: "Transactions", href: "/transactions" }}
      trailing={data.edit ? <BarButton onClick={() => setEditing(true)}>Edit</BarButton> : undefined}
    >
      <List>
        <ListSection footer={data.historyOnly ? HISTORY_ONLY_NOTE : undefined}>
          <ListRow title="Amount" detail={signedAmount(data.kind, data.amount)} />
          <ListRow title="Type" detail={data.kindLabel} />
          <ListRow title="Date" detail={longDate(data.date)} {...(data.precision ? { subtitle: data.precision } : {})} />
          {data.accountLines.map((line) => (
            <ListRow key={line.label} title={line.label} detail={line.value} />
          ))}
          {data.categories.length > 0 ? <ListRow title={data.categories.length > 1 ? "Categories" : "Category"} detail={data.categories.join(", ")} /> : null}
          {data.merchant ? <ListRow title={data.kind === "income" ? "Payer" : "Merchant"} detail={data.merchant} /> : null}
          {data.notes ? <ListRow title="Notes" subtitle={data.notes} /> : null}
        </ListSection>

        <ListSection header="History" footer={data.edit ? EDIT_NOTE : (data.notEditable ?? undefined)}>
          <ListRow title="Status" detail={<Status tone={status.tone}>{status.text}</Status>} />
          {data.historyOnly ? <ListRow title="Recorded as" detail="History only" /> : null}
          <ListRow title="Changes" detail={history} />
          <ListRow title="Show in Activity" onClick={() => router.push("/activity" as Route)} />
        </ListSection>

        {data.status === "posted" ? (
          <ListSection footer="Its effect on your balances is reversed straight away. You can restore it from Trash.">
            <ListRow title="Move to Trash" action destructive center disabled={trash.pending} onClick={() => trash.askToTrash(target)} />
          </ListSection>
        ) : data.status === "deleted" ? (
          <ListSection footer="Deleted records keep their history and can be restored.">
            <ListRow title="Restore" action center disabled={trash.pending} onClick={() => trash.restore(target)} />
          </ListSection>
        ) : null}
      </List>
      {data.edit ? <EditSheet key={data.revision} open={editing} onClose={() => setEditing(false)} data={data} edit={data.edit} /> : null}
      {trash.dialog}
    </IosPage>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The edit sheet, in either look                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Correcting an expense or income.
 *
 * Everything arrives as strings: the server owns money parsing (buildspec.md §1.6), so the browser
 * never turns an amount into a JavaScript number. The revision travels with the save, so it fails
 * rather than overwrite a change made in another window (§16), and the sheet is keyed by revision
 * so that after a save every field shows what was actually stored.
 */
function EditSheet({ open, onClose, data, edit }: { open: boolean; onClose: () => void; data: DetailData; edit: EditData }) {
  const phone = usePhone();
  const [accountId, setAccountId] = useState(edit.accountId);
  const [amount, setAmount] = useState(edit.amountValue);
  const [date, setDate] = useState(edit.date);
  const [categoryId, setCategoryId] = useState(edit.categoryId);
  const [merchant, setMerchant] = useState(edit.merchantName);
  const [notes, setNotes] = useState(edit.notes);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // A fresh copy of the stored values each time it opens, so a cancelled edit leaves nothing behind.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setAccountId(edit.accountId);
      setAmount(edit.amountValue);
      setDate(edit.date);
      setCategoryId(edit.categoryId);
      setMerchant(edit.merchantName);
      setNotes(edit.notes);
      setError(null);
    }
    wasOpen.current = open;
  }, [open, edit]);

  const account = edit.accounts.find((a) => a.id === accountId) ?? edit.accounts[0];
  const currency = account?.currency ?? data.amount.currency.code;
  const isIncome = edit.kind === "income";
  const accountLabel = isIncome ? "Received into" : "Paid from";
  const whoLabel = isIncome ? "Payer" : "Merchant";
  const archivedHint = account?.archived ? "This account is archived. Restore it on Accounts, or pick another, before saving." : null;
  const splitHint = edit.splitCount > 1 ? `This record is split across ${edit.splitCount} categories. Saving replaces the split with the one category chosen here.` : null;
  const canSave = Boolean(account) && amount.trim().length > 0 && !pending;

  const save = () => {
    if (!canSave || !account) return;
    setError(null);
    start(async () => {
      const result = await editTransactionAction(
        {},
        formData({
          transactionId: data.id,
          expectedRevision: data.revision,
          accountId: account.id,
          amount: amount.trim(),
          occurredOn: date,
          categoryId,
          merchantName: merchant.trim(),
          notes: notes.trim(),
        }),
      );
      if (result.error) setError(result.error);
      else onClose();
    });
  };

  const accountOptions = edit.accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})${a.archived ? " — archived" : ""}` }));
  const categoryOptions = edit.categories.map((c) => ({ value: c.id, label: c.name }));

  if (phone) {
    return (
      <IosSheet
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title="Edit Transaction"
        leading={<IosButton variant="glass" onClick={onClose}>Cancel</IosButton>}
        trailing={<IosButton variant="glass-prominent" disabled={!canSave} onClick={save}>{pending ? "Saving…" : "Save"}</IosButton>}
      >
        <List>
          {splitHint ? <ListSection footer={splitHint}><ListRow title="Split record" detail={`${edit.splitCount} categories`} /></ListSection> : null}
          <ListSection footer={`Entered in ${currency}. Use a dot for decimals.`}>
            <IosFieldRow label="Amount">
              <IosTextField value={amount} onChange={setAmount} placeholder="0.00" inputMode="decimal" autoComplete="off" />
            </IosFieldRow>
            <ListRow
              title="Date"
              control={<DatePicker components="date" label="Date" value={dateFromLocal(date)} max={dateFromLocal(edit.maxDate)} onChange={(d) => setDate(localFromDate(d))} />}
            />
          </ListSection>
          <ListSection footer={archivedHint ?? undefined}>
            <ListRow title={accountLabel} popup={<IosPopUp label={accountLabel} options={accountOptions} value={account?.id ?? ""} onChange={setAccountId} />} />
            <ListRow title="Category" popup={<IosPopUp label="Category" options={categoryOptions} value={categoryId} onChange={setCategoryId} />} />
          </ListSection>
          <ListSection footer={error ? <Status tone="bad">{error}</Status> : EDIT_NOTE}>
            <IosFieldRow label={whoLabel}>
              <IosTextField value={merchant} onChange={setMerchant} placeholder="Optional" maxLength={120} />
            </IosFieldRow>
            <IosFieldRow label="Notes">
              <IosTextField value={notes} onChange={setNotes} placeholder="Optional" maxLength={500} />
            </IosFieldRow>
          </ListSection>
        </List>
      </IosSheet>
    );
  }

  return (
    <Sheet
      open={open}
      // The kit closes a sheet after its default button runs. Saving closes it only on success, so
      // a refused amount stays on screen with its reason; Cancel and Escape close it straight away.
      onClose={(button) => (button === "Cancel" || button === undefined ? onClose() : undefined)}
      title="Edit Transaction"
      top={60}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: pending ? "Saving…" : "Save", role: "default", disabled: !canSave, onClick: save },
      ]}
    >
      <FieldGrid
        rows={[
          ...(splitHint ? [{ label: "Split:", control: <Secondary>{edit.splitCount} categories</Secondary>, note: splitHint }] : []),
          { label: `${accountLabel}:`, control: <PopUpButton options={accountOptions} value={account?.id ?? ""} onChange={setAccountId} />, ...(archivedHint ? { note: archivedHint, error: true } : {}) },
          { label: "Amount:", control: <TextField value={amount} onChange={setAmount} placeholder="0.00" inputMode="decimal" autoComplete="off" autoFocus />, note: `In ${currency}. Use a dot for decimals.` },
          { label: "Date:", control: <TextField type="date" value={date} max={edit.maxDate} onChange={setDate} />, note: "The day the money moved, not the day you are recording it." },
          { label: "Category:", control: <PopUpButton options={categoryOptions} value={categoryId} onChange={setCategoryId} /> },
          { label: `${whoLabel}:`, control: <TextField value={merchant} onChange={setMerchant} placeholder="Optional" maxLength={120} /> },
          { label: "Notes:", control: <TextArea value={notes} onChange={setNotes} rows={2} maxLength={500} />, ...(error ? { note: error, error: true } : { note: EDIT_NOTE }) },
        ]}
      />
    </Sheet>
  );
}
