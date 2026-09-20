"use client";

import { startTransition, useActionState, useMemo, useState } from "react";

import { ErrorNote } from "../../../ui/primitives.tsx";
import { Button, Field, FormRow, MoneyInput, Select, TextInput } from "../../../ui/form.tsx";
import type { ActionState } from "../../actions.ts";
import { createTransactionAction } from "../../actions.ts";
import styles from "../transaction-form.module.css";

type AccountOption = { id: string; name: string; currency: string; kind: string };

const KINDS = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
  { value: "refund", label: "Refund" },
] as const;

export function NewTransactionForm({
  accounts,
  categories,
  today,
  initial,
}: {
  accounts: readonly AccountOption[];
  categories: readonly { id: string; name: string }[];
  today: string;
  /** Pre-filled from a link such as Bills' "Record payment". Every field stays editable. */
  initial?: { kind?: string | undefined; fromAccountId?: string | undefined; toAccountId?: string | undefined; amount?: string | undefined } | undefined;
}) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(createTransactionAction, {});
  const [kind, setKind] = useState<string>(initial?.kind ?? "expense");
  const [accountId, setAccountId] = useState<string>(initial?.fromAccountId ?? accounts[0]?.id ?? "");

  /*
   * buildspec.md §16 requires an idempotency key per mutation. Generating it once per mounted form
   * means a double tap or a retried submit replays the same key and cannot post twice.
   */
  const idempotencyKey = useMemo(
    () => (globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
    [],
  );

  const selected = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const currency = selected?.currency ?? "LKR";
  const isTransfer = kind === "transfer";
  const showCategory = kind !== "transfer";

  return (
    /*
     * Submitted from `onSubmit` rather than `action={...}` on purpose. React 19 resets a form once
     * its action settles, even when the action only returned a validation error. That wipes what
     * was typed and snaps a controlled select back to its first option while state still holds the
     * old choice, so the retry could post against a different account than the one on screen.
     */
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (isPending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => formAction(formData));
      }}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormRow>
        {/* Two to a line on a desktop; on a phone this wrapper has no box and nothing changes. */}
        <div className={styles.pairs}>
          {/* A transfer's Type keeps its own line, so From and To pair up underneath it. */}
          <div className={isTransfer ? styles.cellWide : styles.cell}>
            <Field label="Type">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  name="kind"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                  describedBy={describedBy}
                >
                  {KINDS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <Field label={isTransfer ? "From account" : "Account"}>
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
                    {account.name} ({account.currency})
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {isTransfer ? (
            <Field
              label="To account"
              hint="Paying a credit card is a transfer, not a second expense."
            >
              {({ id, describedBy }) => (
                <Select id={id} name="toAccountId" defaultValue={initial?.toAccountId ?? ""} describedBy={describedBy} required>
                  {accounts
                    .filter((account) => account.id !== accountId)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name} ({account.currency})
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          ) : null}

          <Field label="Amount" hint={`Entered in ${currency}. Use a dot for decimals.`}>
            {({ id, describedBy }) => (
              <MoneyInput
                id={id}
                name="amount"
                currencyCode={currency}
                required
                placeholder="0.00"
                defaultValue={initial?.amount ?? ""}
                describedBy={describedBy}
              />
            )}
          </Field>

          {isTransfer ? (
            <Field label="Fee (optional)" hint="Charged separately so it shows as spending, not as transferred money.">
              {({ id, describedBy }) => (
                <MoneyInput
                  id={id}
                  name="fee"
                  currencyCode={currency}
                  placeholder="0.00"
                  describedBy={describedBy}
                />
              )}
            </Field>
          ) : null}

          <Field label="Date" hint="The day the money moved, not the day you are recording it.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="occurredOn"
                type="date"
                defaultValue={today}
                max={today}
                required
                describedBy={describedBy}
              />
            )}
          </Field>

          {showCategory ? (
            <Field label="Category">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  name="categoryId"
                  defaultValue={kind === "income" ? "income" : "uncategorized"}
                  describedBy={describedBy}
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}

          {!isTransfer ? (
            <Field label="Merchant or payer (optional)">
              {({ id, describedBy }) => (
                <TextInput id={id} name="merchantName" maxLength={120} describedBy={describedBy} />
              )}
            </Field>
          ) : null}
        </div>

        <Field label="Notes (optional)">
          {({ id, describedBy }) => (
            <TextInput id={id} name="notes" maxLength={500} describedBy={describedBy} />
          )}
        </Field>

        {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

        <Button disabled={isPending} aria-busy={isPending}>
          {isPending ? "Saving…" : "Save transaction"}
        </Button>
      </FormRow>
    </form>
  );
}
