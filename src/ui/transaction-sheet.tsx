"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { createTransactionAction } from "../app/actions.ts";
import { localFromDate, dateFromLocal } from "./format.ts";
import {
  Button as IosButton,
  DatePicker,
  List,
  ListRow,
  ListSection,
  PopUpButton as IosPopUp,
  SegmentedControl as IosSegmented,
  Sheet as IosSheet,
  TextField as IosTextField,
} from "./ios/ios.tsx";
import { IosFieldRow } from "./ios-parts.tsx";
import type { IconName } from "./labels.ts";
import { usePhone } from "./look.tsx";
import { FieldGrid, PopUpButton, SegmentedControl, Sheet, TextField } from "./macos/macos.tsx";
import { Status, formData } from "./page.tsx";

/**
 * New Transaction, as a sheet over whatever screen is open (buildspec.md §13: "Keep a visible Add
 * button available without chat").
 *
 * The rules all live in `createTransactionAction` and the finance service; this sheet only offers
 * choices that can succeed — income lands in a bank, cash or wallet account; a transfer goes to a
 * different account in the same currency; income categories for income, spending ones otherwise —
 * and shows the service's own message when something is still refused.
 *
 * Each opening gets its own idempotency key, so a double click or a retried Save posts once.
 */

export type TxKind = "expense" | "income" | "transfer" | "refund";

export type QuickData = {
  readonly accounts: readonly { id: string; name: string; currency: string; kind: string; type: string }[];
  readonly categories: readonly { id: string; name: string; kind: "expense" | "income"; icon: IconName }[];
  readonly today: string;
};

export type AddPrefill = {
  readonly kind?: TxKind | undefined;
  readonly accountId?: string | undefined;
  readonly toAccountId?: string | undefined;
  readonly amount?: string | undefined;
  readonly merchantName?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly notes?: string | undefined;
};

const KINDS: readonly { value: TxKind; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
  { value: "refund", label: "Refund" },
];

export function TransactionSheet({ open, prefill, onClose, data }: { open: boolean; prefill: AddPrefill; onClose: () => void; data: QuickData }) {
  // A fresh form, and a fresh idempotency key, every time the sheet opens.
  const [session, setSession] = useState(0);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setSession((n) => n + 1);
    wasOpen.current = open;
  }, [open]);
  return <SheetBody key={session} open={open} prefill={prefill} onClose={onClose} data={data} />;
}

function SheetBody({ open, prefill, onClose, data }: { open: boolean; prefill: AddPrefill; onClose: () => void; data: QuickData }) {
  const phone = usePhone();
  const [kind, setKind] = useState<TxKind>(prefill.kind ?? "expense");
  const assets = data.accounts.filter((a) => a.kind === "asset");
  const firstAccount = prefill.accountId ?? (prefill.kind === "transfer" && prefill.toAccountId ? assets.find((a) => a.id !== prefill.toAccountId)?.id : undefined) ?? assets[0]?.id ?? data.accounts[0]?.id ?? "";
  const [accountId, setAccountId] = useState(firstAccount);
  const [toAccountId, setToAccountId] = useState(prefill.toAccountId ?? "");
  const [amount, setAmount] = useState(prefill.amount ?? "");
  const [fee, setFee] = useState("");
  const [date, setDate] = useState(data.today);
  const [categoryId, setCategoryId] = useState(prefill.categoryId ?? "");
  const [merchant, setMerchant] = useState(prefill.merchantName ?? "");
  const [notes, setNotes] = useState(prefill.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const idempotencyKey = useMemo(() => globalThis.crypto?.randomUUID?.() ?? String(Date.now()), []);

  const fromOptions = kind === "income" ? assets : data.accounts;
  const account = data.accounts.find((a) => a.id === accountId) ?? fromOptions[0];
  const currency = account?.currency ?? "LKR";
  const toOptions = data.accounts.filter((a) => a.id !== account?.id && a.currency === currency);
  const categoryKind = kind === "income" ? "income" : "expense";
  const categories = data.categories.filter((c) => c.kind === categoryKind);
  const category = categories.find((c) => c.id === categoryId) ?? categories.find((c) => c.id === (kind === "income" ? "income" : "uncategorized")) ?? categories[0];
  const target = toOptions.find((a) => a.id === toAccountId) ?? toOptions[0];

  // Keep the chosen account valid when the type changes (a card cannot receive income).
  useEffect(() => {
    if (account && account.id !== accountId) setAccountId(account.id);
  }, [account, accountId]);

  const canSave = Boolean(account) && amount.trim().length > 0 && (kind !== "transfer" || Boolean(target)) && !pending;

  const save = () => {
    if (!canSave || !account) return;
    setError(null);
    start(async () => {
      const result = await createTransactionAction(
        {},
        formData({
          kind,
          accountId: account.id,
          toAccountId: kind === "transfer" ? target?.id : undefined,
          amount: amount.trim(),
          fee: kind === "transfer" ? fee.trim() : undefined,
          occurredOn: date,
          categoryId: kind === "transfer" ? undefined : category?.id,
          merchantName: kind === "transfer" ? undefined : merchant.trim(),
          notes: notes.trim(),
          idempotencyKey,
        }),
      );
      if (result.error) setError(result.error);
      else onClose();
    });
  };

  const accountLabel = (a: { name: string; currency: string }) => `${a.name} (${a.currency})`;
  const fromLabel = kind === "transfer" ? "From" : kind === "income" ? "Into" : kind === "refund" ? "Refunded to" : "Paid from";
  const whoLabel = kind === "income" ? "Payer" : "Merchant";

  if (phone) {
    return (
      <IosSheet
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title="New Transaction"
        dismissible={amount === "" && merchant === ""}
        leading={<IosButton variant="glass" onClick={onClose}>Cancel</IosButton>}
        trailing={
          <IosButton variant="glass-prominent" disabled={!canSave} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </IosButton>
        }
      >
        <List>
          <ListSection>
            <ListRow control={<IosSegmented label="Type" options={KINDS} value={kind} onChange={setKind} />} />
          </ListSection>
          <ListSection footer={`Entered in ${currency}. Use a dot for decimals.`}>
            <IosFieldRow label="Amount">
              <IosTextField value={amount} onChange={setAmount} placeholder="0.00" inputMode="decimal" autoComplete="off" />
            </IosFieldRow>
            {kind === "transfer" ? (
              <IosFieldRow label="Fee">
                <IosTextField value={fee} onChange={setFee} placeholder="Optional" inputMode="decimal" autoComplete="off" />
              </IosFieldRow>
            ) : null}
            <ListRow
              title="Date"
              control={<DatePicker components="date" label="Date" value={dateFromLocal(date)} max={dateFromLocal(data.today)} onChange={(d) => setDate(localFromDate(d))} />}
            />
          </ListSection>
          <ListSection footer={kind === "transfer" ? "Paying a credit card is a transfer, not a second expense." : undefined}>
            <ListRow
              title={fromLabel}
              popup={<IosPopUp label={fromLabel} options={fromOptions.map((a) => ({ value: a.id, label: accountLabel(a) }))} value={account?.id ?? ""} onChange={setAccountId} />}
            />
            {kind === "transfer" ? (
              <ListRow
                title="To"
                popup={
                  toOptions.length > 0 ? (
                    <IosPopUp label="To" options={toOptions.map((a) => ({ value: a.id, label: accountLabel(a) }))} value={target?.id ?? ""} onChange={setToAccountId} />
                  ) : undefined
                }
                detail={toOptions.length === 0 ? `No other ${currency} account` : undefined}
              />
            ) : (
              <ListRow
                title="Category"
                popup={<IosPopUp label="Category" options={categories.map((c) => ({ value: c.id, label: c.name, icon: c.icon }))} value={category?.id ?? ""} onChange={setCategoryId} />}
              />
            )}
          </ListSection>
          <ListSection footer={error ? <Status tone="bad">{error}</Status> : undefined}>
            {kind !== "transfer" ? (
              <IosFieldRow label={whoLabel}>
                <IosTextField value={merchant} onChange={setMerchant} placeholder="Optional" maxLength={120} />
              </IosFieldRow>
            ) : null}
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
      title="New Transaction"
      top={60}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: pending ? "Saving…" : "Save", role: "default", disabled: !canSave, onClick: save },
      ]}
    >
      <FieldGrid
        rows={[
          { label: "Type:", control: <SegmentedControl label="Type" options={[...KINDS]} value={kind} onChange={(v) => setKind(v as TxKind)} /> },
          {
            label: `${fromLabel}:`,
            control: <PopUpButton options={fromOptions.map((a) => ({ value: a.id, label: accountLabel(a) }))} value={account?.id ?? ""} onChange={setAccountId} />,
          },
          ...(kind === "transfer"
            ? [
                {
                  label: "To:",
                  control:
                    toOptions.length > 0 ? (
                      <PopUpButton options={toOptions.map((a) => ({ value: a.id, label: accountLabel(a) }))} value={target?.id ?? ""} onChange={setToAccountId} />
                    ) : (
                      <Status tone="warning">No other {currency} account</Status>
                    ),
                  note: "Paying a credit card is a transfer, not a second expense.",
                },
              ]
            : []),
          {
            label: "Amount:",
            control: <TextField value={amount} onChange={setAmount} placeholder="0.00" inputMode="decimal" autoComplete="off" autoFocus />,
            note: `In ${currency}. Use a dot for decimals.`,
          },
          ...(kind === "transfer" ? [{ label: "Fee:", control: <TextField value={fee} onChange={setFee} placeholder="Optional" inputMode="decimal" />, note: "Recorded as spending, separately from the money moved." }] : []),
          { label: "Date:", control: <TextField type="date" value={date} max={data.today} onChange={setDate} />, note: "The day the money moved." },
          ...(kind === "transfer"
            ? []
            : [
                { label: "Category:", control: <PopUpButton options={categories.map((c) => ({ value: c.id, label: c.name }))} value={category?.id ?? ""} onChange={setCategoryId} /> },
                { label: `${whoLabel}:`, control: <TextField value={merchant} onChange={setMerchant} placeholder="Optional" maxLength={120} /> },
              ]),
          { label: "Notes:", control: <TextField value={notes} onChange={setNotes} placeholder="Optional" maxLength={500} />, ...(error ? { note: error, error: true } : {}) },
        ]}
      />
    </Sheet>
  );
}
