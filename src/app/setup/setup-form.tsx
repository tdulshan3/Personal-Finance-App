"use client";

import { useActionState } from "react";

import { Card, ErrorNote, InfoNote, Shell } from "../../ui/primitives.tsx";
import { Field, FormRow, Select, SubmitButton, TextInput } from "../../ui/form.tsx";
import type { ActionState } from "../actions.ts";
import { setupAction } from "../actions.ts";

export function SetupForm({
  currencies,
  zones,
  defaultZone,
  defaultCurrency,
}: {
  currencies: readonly string[];
  zones: readonly string[];
  defaultZone: string;
  defaultCurrency: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(setupAction, {});

  return (
    <Shell>
      <header style={{ display: "grid", gap: "var(--space-2)" }}>
        <h1>Set up your ledger</h1>
        <p style={{ color: "var(--text-secondary)" }}>
          Everything stays on this phone. Nothing is uploaded anywhere.
        </p>
      </header>

      <Card>
        <form action={formAction}>
          <FormRow>
            <Field
              label="Passphrase"
              hint="At least 12 characters. This unlocks the app and encrypts the database."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="passphrase"
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  describedBy={describedBy}
                />
              )}
            </Field>

            <Field label="Repeat passphrase">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="confirm"
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  describedBy={describedBy}
                />
              )}
            </Field>

            {/*
              buildspec.md §18: the backup password must be "independently recoverable" and cannot
              be rescued by the app. Saying so before the first write is the only honest moment.
            */}
            <InfoNote>
              There is no recovery. If you forget this passphrase, the ledger cannot be opened —
              not by you and not by this app. Write it down and store it somewhere separate.
            </InfoNote>

            <Field
              label="Currency"
              hint="Used for new accounts. Each account keeps its own currency, and totals are never mixed."
            >
              {({ id, describedBy }) => (
                <Select id={id} name="currency" defaultValue={defaultCurrency} describedBy={describedBy}>
                  {currencies.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="Timezone" hint="Decides which day a transaction belongs to.">
              {({ id, describedBy }) => (
                <Select id={id} name="zone" defaultValue={defaultZone} describedBy={describedBy}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

            <SubmitButton pendingLabel="Creating your ledger…">Create ledger</SubmitButton>
          </FormRow>
        </form>
      </Card>
    </Shell>
  );
}
