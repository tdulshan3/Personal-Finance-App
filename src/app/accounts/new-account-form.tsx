"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";

import { ErrorNote, InfoNote } from "../../ui/primitives.tsx";
import { Button, Field, FormRow, MoneyInput, Select, TextInput } from "../../ui/form.tsx";
import type { ActionState } from "../actions.ts";
import { createAccountAction } from "../actions.ts";

const TYPES = [
  { value: "bank", label: "Bank" },
  { value: "cash", label: "Cash" },
  { value: "wallet", label: "Wallet" },
  { value: "credit_card", label: "Credit card" },
  { value: "savings", label: "Savings" },
  { value: "loan", label: "Loan" },
] as const;

export function NewAccountForm({
  currencies,
  today,
}: {
  currencies: readonly string[];
  today: string;
}) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(createAccountAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  const [currency, setCurrency] = useState("LKR");
  const [type, setType] = useState<string>("bank");

  // A created account clears the form for the next one; an error leaves every field as typed.
  useEffect(() => {
    if (!state.ok) return;
    formRef.current?.reset();
    setType("bank");
    setCurrency("LKR");
  }, [state]);

  const isDebt = type === "credit_card" || type === "loan";

  return (
    /*
     * `onSubmit`, not `action={...}`: React 19 resets a form when its action settles, even on a
     * validation error. The controlled Type select would snap back to "Bank" while state still said
     * "Credit card", and the retry would create an asset where the owner chose a debt.
     */
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        if (isPending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => formAction(formData));
      }}
    >
      <FormRow>
        <Field label="Name">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="name"
              required
              maxLength={80}
              placeholder="Everyday bank"
              describedBy={describedBy}
            />
          )}
        </Field>

        <Field label="Type">
          {({ id, describedBy }) => (
            <Select
              id={id}
              name="type"
              value={type}
              onChange={(event) => setType(event.target.value)}
              describedBy={describedBy}
            >
              {TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Currency"
          hint="An account holds one currency. Totals are reported per currency, never added together."
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              name="currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              describedBy={describedBy}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {isDebt ? (
          <Field
            label="Credit limit (optional)"
            hint="Used to show what is left to spend. It is not money you have, and never counts toward your balance."
          >
            {({ id, describedBy }) => (
              <MoneyInput
                id={id}
                name="creditLimit"
                currencyCode={currency}
                placeholder="0.00"
                describedBy={describedBy}
              />
            )}
          </Field>
        ) : null}

        <Field label="Institution (optional)">
          {({ id, describedBy }) => (
            <TextInput id={id} name="institution" maxLength={80} describedBy={describedBy} />
          )}
        </Field>

        <Field
          label={isDebt ? "Amount currently owed (optional)" : "Verified balance now (optional)"}
          hint={
            isDebt
              ? "Enter what you owe as a positive number."
              : "Only enter this if you have checked it. Leaving it blank is fine."
          }
        >
          {({ id, describedBy }) => (
            <MoneyInput
              id={id}
              name="opening"
              currencyCode={currency}
              placeholder="0.00"
              describedBy={describedBy}
            />
          )}
        </Field>

        <Field label="Balance observed on" hint="Required if you entered a balance above.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="openingDate"
              type="date"
              defaultValue={today}
              max={today}
              describedBy={describedBy}
            />
          )}
        </Field>

        {/*
          buildspec.md §9.4: "Do not treat today's balance as an opening balance before twelve
          months of history." Saying this at the point of entry is what stops the number being
          mistaken for a complete starting point later.
        */}
        <InfoNote>
          This is recorded as a starting point at the date you give, not as income. Anything that
          happened before that date will not change this balance.
        </InfoNote>

        {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
        {state.ok ? (
          <p role="status" style={{ color: "var(--success)", fontSize: "var(--font-sm)" }}>
            Account created.
          </p>
        ) : null}

        <Button disabled={isPending} aria-busy={isPending}>
          {isPending ? "Creating…" : "Create account"}
        </Button>
      </FormRow>
    </form>
  );
}
