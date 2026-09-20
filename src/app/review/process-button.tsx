"use client";

import { useActionState } from "react";

import { ErrorNote } from "../../ui/primitives.tsx";
import { SubmitButton } from "../../ui/form.tsx";
import type { ReviewState } from "./actions.ts";
import { processNowAction } from "./actions.ts";

export function ProcessButton() {
  const [state, run] = useActionState<ReviewState, FormData>(processNowAction, {});
  return (
    <form action={run} style={{ display: "grid", gap: "var(--space-2)" }}>
      <SubmitButton variant="secondary" pendingLabel="Checking messages…">Check for new messages now</SubmitButton>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      {state.ok ? <p role="status" style={{ fontSize: "var(--font-sm)", color: "var(--success)" }}>{state.ok}</p> : null}
    </form>
  );
}
