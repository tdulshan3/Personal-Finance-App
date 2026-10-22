"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";

import { ActionSheet } from "../../ui/ios/ios.tsx";
import { usePhone } from "../../ui/look.tsx";
import { Alert } from "../../ui/macos/macos.tsx";
import { moveToTrash, restoreFromTrash } from "./actions.ts";

export type TrashTarget = { readonly id: string; readonly revision: number; readonly title: string };

/**
 * Move to Trash and Restore, with the confirmation each look uses for a destructive action: a
 * macOS alert, an iOS action sheet. The question names the record and says what happens to the
 * balances, so a mis-click on a dense list is caught before it does anything (buildspec.md §13).
 *
 * Restoring is not destructive, so it runs straight away.
 */
export function useTrashCommands(): {
  askToTrash: (target: TrashTarget) => void;
  restore: (target: TrashTarget) => void;
  pending: boolean;
  message: { readonly tone: "good" | "bad"; readonly text: string } | null;
  dialog: ReactNode;
} {
  const phone = usePhone();
  const [target, setTarget] = useState<TrashTarget | null>(null);
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const run = (action: typeof moveToTrash, chosen: TrashTarget) =>
    start(async () => {
      const result = await action({ transactionId: chosen.id, expectedRevision: chosen.revision });
      setMessage(result.error ? { tone: "bad", text: result.error } : { tone: "good", text: result.ok ?? "Done." });
    });

  const confirm = () => {
    if (target) run(moveToTrash, target);
    setTarget(null);
  };
  const title = target ? `Move “${target.title}” to Trash?` : "";
  const explanation = "Its effect on your balances is reversed straight away. You can restore it from Trash.";

  const dialog = phone ? (
    <ActionSheet
      open={target !== null}
      onOpenChange={(open) => !open && setTarget(null)}
      title={title}
      message={explanation}
      actions={[
        { label: "Move to Trash", role: "destructive", onPress: confirm },
        { label: "Cancel", role: "cancel" },
      ]}
    />
  ) : (
    <Alert
      open={target !== null}
      onClose={() => setTarget(null)}
      title={title}
      message={explanation}
      buttons={[
        { label: "Move to Trash", role: "destructive", onClick: confirm },
        { label: "Cancel", role: "cancel" },
      ]}
    />
  );

  return {
    askToTrash: (chosen) => {
      setMessage(null);
      setTarget(chosen);
    },
    restore: (chosen) => {
      setMessage(null);
      run(restoreFromTrash, chosen);
    },
    pending,
    message,
    dialog,
  };
}
