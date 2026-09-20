"use client";

import { Button } from "../ui/form.tsx";
import { lockAction } from "./actions.ts";

/** buildspec.md §18: "a manual 'Lock now'". Drops the key from memory and closes the database. */
export function LockButton() {
  return (
    <form action={lockAction}>
      <Button variant="secondary" style={{ padding: "0 var(--space-4)" }}>
        Lock
      </Button>
    </form>
  );
}
