"use client";

import { useActionState, useState } from "react";

import { Badge, ErrorNote } from "../../ui/primitives.tsx";
import { Button, Field, FormRow, MoneyInput, SubmitButton, TextInput } from "../../ui/form.tsx";
import type { AccountFormState } from "./account-actions.ts";
import { archiveAccountAction, updateAccountAction } from "./account-actions.ts";

export type AccountRowData = {
  id: string;
  name: string;
  kind: string;
  type: string;
  typeLabel: string;
  currency: string;
  institution: string | null;
  revision: number;
  archived: boolean;
  /** Already formatted; the server owns money formatting so the client never parses it. */
  balanceText: string;
  balanceIsNegative: boolean;
  creditLimitText: string | null;
  /** Raw major-unit string for the edit field, e.g. "500000.00". */
  creditLimitValue: string | null;
  availableText: string | null;
  utilisationPercent: number | null;
  entries: number;
};

/**
 * One account, with its edit form.
 *
 * buildspec.md §13 asks the Accounts screen to "display balance type, freshness and tracking
 * start" and to use accurate labels. A credit line says **Current balance** rather than "amount
 * owed", because that is what a card statement calls it and because §20 requires a card in credit
 * to read as a credit balance rather than as debt.
 */
export function AccountRow({ data }: { data: AccountRowData }) {
  const [editing, setEditing] = useState(false);
  const [state, runUpdate] = useActionState<AccountFormState, FormData>(updateAccountAction, {});
  const isCredit = data.kind === "liability";

  return (
    <li
      style={{
        display: "grid",
        gap: "var(--space-3)",
        paddingBottom: "var(--space-4)",
        borderBottom: "1px solid var(--border)",
        opacity: data.archived ? 0.6 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-4)", alignItems: "flex-start" }}>
        <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
          <span style={{ fontWeight: 560, overflowWrap: "anywhere" }}>{data.name}</span>
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
            {data.typeLabel} · {data.currency}
            {data.institution ? ` · ${data.institution}` : ""}
          </span>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {data.archived ? <Badge tone="warning">Archived</Badge> : null}
            {isCredit && data.balanceIsNegative ? <Badge tone="success">In credit</Badge> : null}
            {data.utilisationPercent !== null ? (
              <Badge tone={data.utilisationPercent >= 80 ? "danger" : "neutral"}>
                {data.utilisationPercent}% of limit used
              </Badge>
            ) : null}
          </div>
        </div>

        <div style={{ display: "grid", gap: "2px", justifyItems: "end" }}>
          <span
            className="money"
            style={{
              fontWeight: 560,
              color: data.balanceIsNegative && isCredit ? "var(--success)" : "var(--text)",
            }}
          >
            {data.balanceText}
          </span>
          <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
            {isCredit ? "Current balance" : "Recorded balance"}
          </span>
          {data.availableText ? (
            <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {data.availableText} available{data.creditLimitText ? ` of ${data.creditLimitText}` : ""}
            </span>
          ) : isCredit && !data.creditLimitText ? (
            <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              no limit set
            </span>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setEditing((v) => !v)}
          style={{ minHeight: "36px", padding: "0 var(--space-4)", fontSize: "var(--font-sm)" }}
        >
          {editing ? "Close" : "Edit"}
        </Button>
        <form
          action={archiveAccountAction}
          onSubmit={(event) => {
            if (data.archived) return;
            if (
              !window.confirm(
                `Archive "${data.name}"?\n\nIts ${data.entries} ledger ${
                  data.entries === 1 ? "entry stays" : "entries stay"
                } exactly as they are and balances still include them. It just stops accepting new ` +
                  `transactions and leaves the list. You can restore it at any time.`,
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="accountId" value={data.id} />
          <input type="hidden" name="archived" value={String(data.archived)} />
          <Button
            variant={data.archived ? "primary" : "ghost"}
            style={{ minHeight: "36px", padding: "0 var(--space-4)", fontSize: "var(--font-sm)" }}
          >
            {data.archived ? "Restore" : "Archive"}
          </Button>
        </form>
      </div>

      {editing ? (
        <form action={runUpdate} style={{ background: "var(--surface-sunken)", padding: "var(--space-4)", borderRadius: "var(--radius-input)" }}>
          <input type="hidden" name="accountId" value={data.id} />
          <input type="hidden" name="expectedRevision" value={data.revision} />
          <FormRow>
            <Field label="Name">
              {({ id, describedBy }) => (
                <TextInput id={id} name="name" defaultValue={data.name} required maxLength={80} describedBy={describedBy} />
              )}
            </Field>
            <Field label="Institution (optional)">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="institution"
                  defaultValue={data.institution ?? ""}
                  maxLength={80}
                  describedBy={describedBy}
                />
              )}
            </Field>

            {isCredit ? (
              <Field
                label="Credit limit (optional)"
                hint="Used to show what is left to spend. It is not money you have, and never counts toward your balance."
              >
                {({ id, describedBy }) => (
                  <MoneyInput
                    id={id}
                    name="creditLimit"
                    currencyCode={data.currency}
                    defaultValue={data.creditLimitValue ?? ""}
                    placeholder="0.00"
                    describedBy={describedBy}
                  />
                )}
              </Field>
            ) : null}

            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              Currency and account type cannot be changed — every transaction already recorded
              against this account assumes both.
            </span>

            {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
            {state.ok ? (
              <p role="status" style={{ fontSize: "var(--font-sm)", color: "var(--success)" }}>
                {state.ok} Reload to see it above.
              </p>
            ) : null}

            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
          </FormRow>
        </form>
      ) : null}
    </li>
  );
}
