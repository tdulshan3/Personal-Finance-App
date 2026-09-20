"use client";

import Link from "next/link";
import { startTransition, useActionState } from "react";

import { Badge, ErrorNote } from "../../ui/primitives.tsx";
import { Button, Field, MoneyInput, Select, TextInput } from "../../ui/form.tsx";
import type { ReviewState } from "./actions.ts";
import { acceptReviewAction, ignoreReviewAction } from "./actions.ts";
import styles from "./review.module.css";

export type ReviewCardData = {
  eventId: string;
  kind: string;
  kindLabel: string;
  postable: boolean;
  sender: string;
  receivedLabel: string;
  sourceText: string | null;
  amountValue: string;
  currency: string | null;
  merchantText: string | null;
  accountHint: string | null;
  occurredOn: string;
  flags: readonly string[];
  engine: string;
  modelName: string | null;
  suggestedAccountId: string | null;
  suggestedCategoryId: string | null;
  possibleDuplicate: { transactionId: string; label: string } | null;
};

const FLAG_LABELS: Record<string, string> = {
  date_ambiguous: "Date could be read two ways — check it",
  date_missing: "No date in the message — using the day it arrived",
  from_model: "Read by the model — check every field",
  model_output_invalid: "The model's answer was unusable — enter it by hand",
  evidence_rejected: "The model's answer did not match the message — enter it by hand",
};

/**
 * One message awaiting a decision.
 *
 * buildspec.md §7.4: "exact source, proposed fields, highlighted evidence, rejection reasons, and
 * edit/accept/ignore controls." Every proposed field is editable before it is accepted; nothing the
 * rules or the model said becomes a transaction until the owner presses the button.
 */
export function ReviewCard({
  data,
  accounts,
  categories,
  today,
}: {
  data: ReviewCardData;
  accounts: readonly { id: string; name: string; currency: string }[];
  categories: readonly { id: string; name: string }[];
  today: string;
}) {
  const [state, runAccept, isAccepting] = useActionState<ReviewState, FormData>(acceptReviewAction, {});
  const defaultKind = data.kind === "posted_income" ? "income" : data.kind === "refund" ? "refund" : "expense";

  return (
    <li className={styles.item}>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
        <strong>{data.sender}</strong>
        <Badge tone="primary">{data.kindLabel}</Badge>
        <Badge>{data.engine === "model" ? `model${data.modelName ? ` · ${data.modelName}` : ""}` : "rules"}</Badge>
        <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{data.receivedLabel}</span>
      </div>

      {data.sourceText ? (
        <blockquote
          style={{
            margin: 0, padding: "var(--space-3) var(--space-4)", background: "var(--surface-sunken)",
            borderRadius: "var(--radius-input)", fontSize: "var(--font-sm)", whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {data.sourceText}
        </blockquote>
      ) : null}

      {data.flags.filter((f) => FLAG_LABELS[f]).map((flag) => (
        <span key={flag} style={{ fontSize: "var(--font-sm)", color: "var(--warning)" }}>
          {FLAG_LABELS[flag]}
        </span>
      ))}

      {data.possibleDuplicate ? (
        <span style={{ fontSize: "var(--font-sm)", color: "var(--warning)" }}>
          Possible duplicate of{" "}
          <Link href={`/transactions/${data.possibleDuplicate.transactionId}`}>{data.possibleDuplicate.label}</Link>
          . If it is the same payment, ignore this one.
        </span>
      ) : null}

      {data.postable ? (
        <form
          onSubmit={(event) => {
            // `onSubmit`, not `action={...}`: React 19 resets a form when its action settles, even
            // on a validation error. Here that would quietly put the account and category back to
            // what the rules suggested, discarding the owner's correction just before they press
            // Accept again.
            event.preventDefault();
            if (isAccepting) return;
            const formData = new FormData(event.currentTarget);
            startTransition(() => runAccept(formData));
          }}
        >
          <input type="hidden" name="eventId" value={data.eventId} />
          {/* One column on a phone; on a wide screen the fields pair up: type+account, amount+date. */}
          <div className={styles.fields}>
            <Field label="Record as">
              {({ id, describedBy }) => (
                <Select id={id} name="kind" defaultValue={defaultKind} describedBy={describedBy}>
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                  <option value="refund">Refund</option>
                </Select>
              )}
            </Field>
            <Field
              label="Account"
              {...(data.accountHint
                ? { hint: `The message mentions ****${data.accountHint}. Your choice is remembered for next time.` }
                : {})}
            >
              {({ id, describedBy }) => (
                <Select id={id} name="accountId" defaultValue={data.suggestedAccountId ?? ""} required describedBy={describedBy}>
                  <option value="" disabled>Choose an account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Amount">
              {({ id, describedBy }) => (
                <MoneyInput id={id} name="amount" currencyCode={data.currency ?? "LKR"} defaultValue={data.amountValue} required describedBy={describedBy} />
              )}
            </Field>
            <Field label="Date">
              {({ id, describedBy }) => (
                <TextInput id={id} name="occurredOn" type="date" defaultValue={data.occurredOn} max={today} required describedBy={describedBy} />
              )}
            </Field>
            <Field label="Category">
              {({ id, describedBy }) => (
                <Select id={id} name="categoryId" defaultValue={data.suggestedCategoryId ?? (defaultKind === "income" ? "income" : "uncategorized")} describedBy={describedBy}>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Merchant or payer">
              {({ id, describedBy }) => (
                <TextInput id={id} name="merchantName" defaultValue={data.merchantText ?? ""} maxLength={120} describedBy={describedBy} />
              )}
            </Field>
            <div className={styles.full}>
              {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
              <Button disabled={isAccepting} aria-busy={isAccepting}>
                {isAccepting ? "Recording…" : "Accept and record"}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
          Nothing has moved yet, so there is nothing to record. Bills and scheduled payments get
          their own screen later; for now this is just for your information.
        </p>
      )}

      <form action={ignoreReviewAction}>
        <input type="hidden" name="eventId" value={data.eventId} />
        <Button variant="ghost" style={{ minHeight: "40px", padding: "0 var(--space-3)" }}>
          {data.postable ? "Ignore this message" : "Dismiss"}
        </Button>
      </form>
    </li>
  );
}
