"use client";

import { startTransition, useActionState } from "react";

import { Button, Select } from "../../ui/form.tsx";
import { ErrorNote } from "../../ui/primitives.tsx";
import type { DueDayState } from "./actions.ts";
import { setDueDayAction } from "./actions.ts";

/** The one thing the app cannot know by itself: which day of the month this card's bill is due. */
export function DueDayForm({ accountId, accountName, dueDay }: { accountId: string; accountName: string; dueDay: number | null }) {
  const [state, run, pending] = useActionState<DueDayState, FormData>(setDueDayAction, {});
  return (
    <form
      onSubmit={(event) => {
        // onSubmit rather than `action`, so React does not reset the select after saving.
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => run(formData));
      }}
      style={{ display: "grid", gap: "var(--space-2)" }}
    >
      <input type="hidden" name="accountId" value={accountId} />
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 180px", minWidth: 0 }}>
          <Select name="dueDay" defaultValue={dueDay === null ? "" : String(dueDay)} aria-label={`Payment due day for ${accountName}`}>
            <option value="">No due day set</option>
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
              <option key={day} value={day}>
                Due on day {day} of each month
              </option>
            ))}
          </Select>
        </div>
        <Button variant="secondary" disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      {state.ok ? <p role="status" style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--success)" }}>{state.ok}</p> : null}
    </form>
  );
}
