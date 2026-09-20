"use client";

import { Button } from "../../ui/form.tsx";
import { deleteTransactionAction, restoreTransactionAction } from "../actions.ts";

/**
 * buildspec.md §13: "Normal deletion goes to Trash, explains the balance/bill impact, and offers
 * undo." The confirm text names the record so a mistap on a dense list is recoverable *before* it
 * happens, and the hidden revision makes the write fail rather than clobber a newer edit (§16).
 */
export function DeleteTransactionButton({
  transactionId,
  expectedRevision,
  label,
}: {
  transactionId: string;
  expectedRevision: number;
  label: string;
}) {
  return (
    <form
      action={deleteTransactionAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            `Move "${label}" to Trash?\n\nIts effect on your balances is reversed straight away. ` +
              `You can restore it from Trash.`,
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="transactionId" value={transactionId} />
      <input type="hidden" name="expectedRevision" value={expectedRevision} />
      <Button variant="ghost" style={{ minHeight: "36px", padding: "0 var(--space-3)" }}>
        Delete
      </Button>
    </form>
  );
}

export function RestoreTransactionButton({
  transactionId,
  expectedRevision,
}: {
  transactionId: string;
  expectedRevision: number;
}) {
  return (
    <form action={restoreTransactionAction}>
      <input type="hidden" name="transactionId" value={transactionId} />
      <input type="hidden" name="expectedRevision" value={expectedRevision} />
      <Button variant="secondary" style={{ minHeight: "36px", padding: "0 var(--space-3)" }}>
        Restore
      </Button>
    </form>
  );
}
