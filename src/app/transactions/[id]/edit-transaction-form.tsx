"use client";

import { startTransition, useActionState, useState } from "react";

import { ErrorNote, InfoNote } from "../../../ui/primitives.tsx";
import { Button, Field, FormRow, MoneyInput, Select, TextInput } from "../../../ui/form.tsx";
import type { EditTransactionState } from "./actions.ts";
import { editTransactionAction } from "./actions.ts";

export type EditTransactionData = {
  id: string;
  kind: "expense" | "income";
  revision: number;
  accountId: string;
  /** Plain major units with no code and no grouping, e.g. "3450.00" — never a number. */
  amountValue: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** The latest date the picker offers: today, or the record's own date if that is later. */
  maxDate: string;
  categoryId: string;
  merchantName: string;
  notes: string;
  /** More than one means the record is split, which this single-category form would flatten. */
  splitCount: number;
};

type AccountOption = { id: string; name: string; currency: string; archived: boolean };

/**
 * The edit form for an expense or income.
 *
 * Everything arrives as strings: the server owns money formatting and parsing (buildspec.md §1.6),
 * so the browser never turns an amount into a JavaScript number. The hidden revision makes a save
 * fail rather than overwrite a change made in another tab (§16).
 */
export function EditTransactionForm({
  data,
  accounts,
  categories,
}: {
  data: EditTransactionData;
  accounts: readonly AccountOption[];
  categories: readonly { id: string; name: string }[];
}) {
  const [state, runEdit, isPending] = useActionState<EditTransactionState, FormData>(
    editTransactionAction,
    {},
  );
  const [accountId, setAccountId] = useState<string>(data.accountId);

  const selected = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const currency = selected?.currency ?? "LKR";
  const isIncome = data.kind === "income";

  return (
    /*
     * Submitted from `onSubmit` rather than `action={...}` on purpose. React resets a form after
     * its action finishes — even when the action only returned an error — which would throw away
     * what the owner typed. Worse, that reset moves a controlled <select> back to its first option
     * while the state behind it keeps the old choice, so a retry after an error could quietly move
     * the record to a different account. Calling the action by hand skips the reset entirely.
     *
     * Keyed by revision: after a save the page re-renders with the new revision, and remounting
     * the form makes every field show what was actually stored.
     */
    <form
      key={data.revision}
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => runEdit(formData));
      }}
    >
      <input type="hidden" name="transactionId" value={data.id} />
      <input type="hidden" name="expectedRevision" value={data.revision} />
      <FormRow>
        {data.splitCount > 1 ? (
          <InfoNote>
            This record is split across {data.splitCount} categories. Saving here replaces the split
            with the single category you choose below.
          </InfoNote>
        ) : null}

        <Field
          label={isIncome ? "Received into" : "Paid from"}
          {...(selected?.archived
            ? { hint: "This account is archived. Restore it on Accounts, or pick another, before saving." }
            : {})}
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              name="accountId"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              describedBy={describedBy}
              required
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.currency}){account.archived ? " — archived" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Amount" hint={`Entered in ${currency}. Use a dot for decimals.`}>
          {({ id, describedBy }) => (
            <MoneyInput
              id={id}
              name="amount"
              currencyCode={currency}
              defaultValue={data.amountValue}
              required
              placeholder="0.00"
              describedBy={describedBy}
            />
          )}
        </Field>

        <Field label="Date" hint="The day the money moved, not the day you are recording it.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="occurredOn"
              type="date"
              defaultValue={data.date}
              max={data.maxDate}
              required
              describedBy={describedBy}
            />
          )}
        </Field>

        <Field label="Category">
          {({ id, describedBy }) => (
            <Select id={id} name="categoryId" defaultValue={data.categoryId} describedBy={describedBy}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label={isIncome ? "Payer (optional)" : "Merchant (optional)"}>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="merchantName"
              defaultValue={data.merchantName}
              maxLength={120}
              describedBy={describedBy}
            />
          )}
        </Field>

        <Field label="Notes (optional)">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="notes"
              defaultValue={data.notes}
              maxLength={500}
              describedBy={describedBy}
            />
          )}
        </Field>

        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
          Saving keeps the original in this record&apos;s history: the old entry is reversed and a
          corrected one takes its place.
        </span>

        {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
        {state.ok ? (
          <p role="status" style={{ fontSize: "var(--font-sm)", color: "var(--success)" }}>
            {state.ok}
          </p>
        ) : null}

        {/* Disabled while the save runs, so a double tap cannot submit twice. */}
        <Button disabled={isPending} aria-busy={isPending}>
          {isPending ? "Saving…" : "Save changes"}
        </Button>
      </FormRow>
    </form>
  );
}
