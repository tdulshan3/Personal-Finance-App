"use client";

import { useActionState } from "react";

import { Card, ErrorNote, InfoNote } from "../../ui/primitives.tsx";
import { Field, FormRow, SubmitButton, TextInput } from "../../ui/form.tsx";
import type { BackupState } from "./backup-actions.ts";
import { createBackupAction } from "./backup-actions.ts";

export type ExistingBackup = {
  name: string;
  /** Already formatted on the server, e.g. "48.0 KB". */
  sizeText: string;
  /** Already formatted on the server, in the owner's timezone. */
  savedText: string;
};

/** Owner-facing names for the row counts a backup's manifest records. */
const COUNT_LABELS: Readonly<Record<string, string>> = {
  ledger_accounts: "Ledger accounts",
  transactions: "Transactions",
  transaction_revisions: "Revisions",
  journals: "Journals",
  journal_entries: "Journal entries",
  categories: "Categories",
  audit_events: "Activity events",
};

/*
 * A plain link, with no `download` attribute: the route already answers with
 * `content-disposition: attachment`, and without the attribute an expired session shows its
 * "unlock first" message instead of a download that silently fails.
 */
function downloadHref(name: string): string {
  return `/api/backup/download?file=${encodeURIComponent(name)}`;
}

/**
 * Backup.
 *
 * buildspec.md §18 asks for encrypted backups under "an independently recoverable password/key
 * mechanism" — a password of its own, so the file opens on a phone that has never seen this vault.
 * That independence is also the risk, which is why the warning sits directly above the button.
 */
export function BackupCard({ existing }: { existing: readonly ExistingBackup[] }) {
  const [state, formAction] = useActionState<BackupState, FormData>(createBackupAction, {});

  return (
    <Card title="Backup">
      <p
        style={{
          fontSize: "var(--font-sm)",
          color: "var(--text-secondary)",
          marginBottom: "var(--space-4)",
        }}
      >
        Makes an encrypted copy of the whole ledger on this device. Download it and keep it somewhere
        else — a backup that only lives on the phone is lost with the phone.
      </p>

      <form action={formAction}>
        <FormRow>
          <Field label="Backup password" hint="At least 12 characters.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="backupPassphrase"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                describedBy={describedBy}
              />
            )}
          </Field>
          <Field label="Repeat backup password">
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

          <InfoNote>
            This password is separate from your unlock passphrase and is the only way to open the
            backup. There is no recovery.
          </InfoNote>

          {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

          {state.ok && state.fileName ? (
            <div
              role="status"
              style={{
                display: "grid",
                gap: "var(--space-2)",
                background: "var(--surface-sunken)",
                borderRadius: "var(--radius-input)",
                padding: "var(--space-4)",
                fontSize: "var(--font-sm)",
              }}
            >
              <span style={{ color: "var(--success)", fontWeight: 560 }}>{state.ok}</span>
              <span style={{ overflowWrap: "anywhere" }}>{state.fileName}</span>
              {state.counts ? (
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    color: "var(--text-secondary)",
                    display: "grid",
                    gap: "2px",
                  }}
                >
                  {Object.entries(state.counts).map(([table, count]) => (
                    <li key={table}>
                      {COUNT_LABELS[table] ?? table}: {count}
                    </li>
                  ))}
                </ul>
              ) : null}
              <a href={downloadHref(state.fileName)}>Download this backup</a>
            </div>
          ) : null}

          <SubmitButton pendingLabel="Creating backup…">Create backup</SubmitButton>
        </FormRow>
      </form>

      <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-5)" }}>
        <span style={{ fontSize: "var(--font-sm)", fontWeight: 560 }}>Backups on this device</span>
        {existing.length === 0 ? (
          <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>None yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-3)" }}>
            {existing.map((backup) => (
              <li
                key={backup.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-3)",
                  paddingBottom: "var(--space-3)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ display: "grid", gap: "2px", minWidth: 0 }}>
                  <span style={{ fontWeight: 560, overflowWrap: "anywhere" }}>{backup.name}</span>
                  <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                    {backup.savedText} · {backup.sizeText}
                  </span>
                </div>
                <a href={downloadHref(backup.name)}>Download</a>
              </li>
            ))}
          </ul>
        )}
        <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
          Restoring a backup isn&apos;t available in the app yet.
        </p>
      </div>
    </Card>
  );
}
