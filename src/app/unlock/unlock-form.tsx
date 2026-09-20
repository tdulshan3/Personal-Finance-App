"use client";

import { useActionState } from "react";

import { Card, ErrorNote, Shell } from "../../ui/primitives.tsx";
import { Field, FormRow, SubmitButton, TextInput } from "../../ui/form.tsx";
import type { ActionState } from "../actions.ts";
import { unlockAction } from "../actions.ts";

export function UnlockForm({ needsSessionOnly }: { needsSessionOnly: boolean }) {
  const [state, formAction] = useActionState<ActionState, FormData>(unlockAction, {});

  return (
    <Shell>
      <header style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-6)" }}>
        <h1>Locked</h1>
        <p style={{ color: "var(--text-secondary)" }}>
          {needsSessionOnly
            ? "The ledger is open, but this browser has not been confirmed. Enter your passphrase to continue."
            : "Enter your passphrase to decrypt the ledger. Message capture is paused until you do."}
        </p>
      </header>

      <Card>
        <form action={formAction}>
          <FormRow>
            <Field label="Passphrase">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="passphrase"
                  type="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                  describedBy={describedBy}
                />
              )}
            </Field>

            {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

            <SubmitButton pendingLabel="Unlocking…">Unlock</SubmitButton>
          </FormRow>
        </form>
      </Card>
    </Shell>
  );
}
