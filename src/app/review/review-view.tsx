"use client";

import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useState, useTransition } from "react";
import type { ReactNode } from "react";

import { dateFromLocal, localFromDate } from "../../ui/format.ts";
import {
  ActionSheet,
  BarButton,
  DatePicker,
  EmptyState as IosEmptyState,
  List as IosList,
  ListRow,
  ListSection,
  PopUpButton as IosPopUp,
  SegmentedControl as IosSegmented,
  TextField as IosTextField,
} from "../../ui/ios/ios.tsx";
import { IosFieldRow } from "../../ui/ios-parts.tsx";
import type { IconName } from "../../ui/labels.ts";
import { usePhone } from "../../ui/look.tsx";
import {
  Alert,
  Button,
  Column,
  Content,
  EmptyState,
  Form,
  FormRow,
  FormSection,
  GroupBox,
  List,
  ListColumn,
  PopUpButton,
  Row,
  Section,
  SegmentedControl,
  Spacer,
  Stack,
  TextField,
  ToolbarButton,
  WindowBody,
} from "../../ui/macos/macos.tsx";
import type { Tone } from "../../ui/page.tsx";
import { IosPage, MacPage, Secondary, Status, formData } from "../../ui/page.tsx";
import type { ReviewState } from "./actions.ts";
import { acceptReviewAction, ignoreReviewAction, processNowAction } from "./actions.ts";

/**
 * Review, in both looks (buildspec.md §7.4): "exact source, proposed fields, highlighted evidence,
 * rejection reasons, and edit/accept/ignore controls." Every proposed field is editable before it
 * is accepted; nothing the rules or the model said becomes a transaction until the owner says so.
 *
 * macOS: a three-column window — the messages in a list column, the selected one beside it with
 * its accept form; the toolbar's Accept and Ignore act on the selection. iOS: the inbox as a list,
 * and each message pushed as its own screen with Accept in the navigation bar.
 */

export type ReviewMessage = {
  eventId: string;
  kind: string;
  kindLabel: string;
  postable: boolean;
  sender: string;
  receivedLabel: string;
  sourceText: string | null;
  /** "LKR 1,250.00", for the list. */
  amountText: string | null;
  /** Without the code, for a phone row, where "LKR " would push the figure into an ellipsis. */
  amountBare: string | null;
  /** "1250.00", the editable starting value. */
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
  balanceCheck: { accountName: string; reported: string; projected: string; difference: string | null } | null;
  pairedWith: { eventId: string; sender: string; sourceText: string | null } | null;
  /** Reloads the inbox with this pairing undone. */
  splitHref: string | null;
};

export type ReviewData = {
  messages: ReviewMessage[];
  counts: { staged: number; waitingForModel: number; openReviews: number };
  /** Background checks are running. */
  checking: boolean;
  today: string;
  accounts: { id: string; name: string; currency: string }[];
  categories: { id: string; name: string; kind: "expense" | "income" }[];
};

type RecordKind = "expense" | "income" | "refund";
type Draft = { kind: RecordKind; accountId: string; amount: string; date: string; categoryId: string; merchant: string };

const RECORD_AS: { value: RecordKind; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "refund", label: "Refund" },
];

const FLAG_LABELS: Record<string, string> = {
  date_ambiguous: "Date could be read two ways — check it",
  date_missing: "No date in the message — using the day it arrived",
  from_model: "Read by the model — check every field",
  model_output_invalid: "The model's answer was unusable — enter it by hand",
  evidence_rejected: "The model's answer did not match the message — enter it by hand",
};

const NOTHING_TO_RECORD =
  "Nothing has moved yet, so there is nothing to record. It is here for your information; if it repeats every month, add it on Bills.";

const draftFor = (m: ReviewMessage): Draft => ({
  kind: m.kind === "posted_income" ? "income" : m.kind === "refund" ? "refund" : "expense",
  accountId: m.suggestedAccountId ?? "",
  amount: m.amountValue,
  date: m.occurredOn,
  categoryId: m.suggestedCategoryId ?? "",
  merchant: m.merchantText ?? "",
});

const engineText = (m: ReviewMessage) => (m.engine === "model" ? `Read by the model${m.modelName ? ` (${m.modelName})` : ""}` : "Read by the rules");

const accountHint = (m: ReviewMessage) =>
  m.accountHint ? `The message mentions ****${m.accountHint}. Your choice of account is remembered for next time.` : undefined;

const pairedExplanation = (m: ReviewMessage) =>
  m.pairedWith
    ? `Your bank and ${m.pairedWith.sender} both reported this amount within minutes, so it is recorded once: paid from the bank account, filed under what it was for.`
    : "";

type Note = { key: string; tone: Tone; icon: IconName; text: ReactNode; href?: string };

/** What to check before accepting: the reader's doubts, a possible duplicate, the bank's balance. */
function notesFor(m: ReviewMessage): Note[] {
  const notes: Note[] = m.flags
    .filter((flag) => FLAG_LABELS[flag])
    .map((flag) => ({ key: flag, tone: "warning" as const, icon: "exclamationmark-triangle" as const, text: FLAG_LABELS[flag] }));
  if (m.possibleDuplicate) {
    notes.push({
      key: "duplicate",
      tone: "warning",
      icon: "doc-on-doc",
      text: `Possible duplicate of ${m.possibleDuplicate.label}. If it is the same payment, ignore this one.`,
      href: `/transactions/${m.possibleDuplicate.transactionId}`,
    });
  }
  if (m.balanceCheck) {
    const check = m.balanceCheck;
    notes.push(
      check.difference
        ? {
            key: "balance",
            tone: "bad",
            icon: "exclamationmark-triangle",
            text: `Does not balance. Your bank says ${check.reported} is left in ${check.accountName}; after recording this your books would say ${check.projected} (${check.difference}). Something earlier was probably never recorded. You can still accept this, then fix the gap on Accounts.`,
          }
        : {
            key: "balance",
            tone: "good",
            icon: "checkmark-circle-fill",
            text: `Balanced. After recording this, ${check.accountName} will show ${check.projected}, exactly what your bank reports.`,
          },
    );
  }
  return notes;
}

function useReview(data: ReviewData) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [report, setReport] = useState<{ tone: Tone; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  const draftOf = (m: ReviewMessage) => drafts[m.eventId] ?? draftFor(m);
  const update = (m: ReviewMessage, change: Partial<Draft>) => setDrafts((all) => ({ ...all, [m.eventId]: { ...draftOf(m), ...change } }));

  /** Income categories for income, spending ones for an expense or a refund. */
  const categoriesFor = (kind: RecordKind) => data.categories.filter((c) => c.kind === (kind === "income" ? "income" : "expense"));
  const categoryOf = (draft: Draft) => {
    const options = categoriesFor(draft.kind);
    return (
      options.find((c) => c.id === draft.categoryId) ??
      options.find((c) => c.id === (draft.kind === "income" ? "income" : "uncategorized")) ??
      options[0]
    );
  };
  const currencyOf = (m: ReviewMessage, draft: Draft) => data.accounts.find((a) => a.id === draft.accountId)?.currency ?? m.currency ?? "LKR";

  const run = (key: string, task: () => Promise<ReviewState>, after: (result: ReviewState) => void) => {
    if (busy) return;
    setBusy(key);
    start(async () => {
      try {
        after(await task());
      } finally {
        setBusy(null);
      }
    });
  };

  const accept = (m: ReviewMessage) => {
    const draft = draftOf(m);
    if (!draft.accountId) {
      setErrors((all) => ({ ...all, [m.eventId]: "Choose the account this happened on." }));
      return;
    }
    setErrors((all) => ({ ...all, [m.eventId]: "" }));
    run(
      m.eventId,
      () =>
        acceptReviewAction(
          {},
          formData({
            eventId: m.eventId,
            pairedEventId: m.pairedWith?.eventId,
            kind: draft.kind,
            accountId: draft.accountId,
            amount: draft.amount.trim(),
            occurredOn: draft.date,
            categoryId: categoryOf(draft)?.id,
            merchantName: draft.merchant.trim(),
          }),
        ),
      (result) => {
        if (result.error) setErrors((all) => ({ ...all, [m.eventId]: result.error! }));
        else setReport({ tone: "good", text: `Recorded the message from ${m.sender}.` });
      },
    );
  };

  const ignore = (m: ReviewMessage) =>
    run(
      m.eventId,
      () => ignoreReviewAction({}, formData({ eventId: m.eventId })),
      (result) => {
        if (result.error) setErrors((all) => ({ ...all, [m.eventId]: result.error! }));
        else setReport({ tone: "neutral", text: `${m.postable ? "Ignored" : "Dismissed"} the message from ${m.sender}.` });
      },
    );

  const check = () =>
    run("check", () => processNowAction({}, new FormData()), (result) =>
      setReport(result.error ? { tone: "bad", text: result.error } : { tone: "good", text: result.ok ?? "Done." }),
    );

  const summary = [
    `${data.messages.length} to review`,
    ...(data.counts.staged > 0 ? [`${data.counts.staged} not read yet`] : []),
    ...(data.counts.waitingForModel > 0 ? [`${data.counts.waitingForModel} waiting for the model`] : []),
    data.checking ? "checking every minute" : "background checks off",
  ].join(" · ");

  return { draftOf, update, categoriesFor, categoryOf, currencyOf, errors, report, busy, accept, ignore, check, summary };
}

type Review = ReturnType<typeof useReview>;

export function ReviewView({ data }: { data: ReviewData }) {
  return usePhone() ? <IosReview data={data} /> : <MacReview data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function MacReview({ data }: { data: ReviewData }) {
  const review = useReview(data);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // After an accept or an ignore the message leaves the list, and the next one takes its place.
  const selected = data.messages.find((m) => m.eventId === selectedId) ?? data.messages[0];

  return (
    <>
      <MacPage
        title="Review"
        subtitle={review.report ? <Status tone={review.report.tone}>{review.report.text}</Status> : review.summary}
        toolbar={
          <>
            <ToolbarButton icon="arrow-clockwise" label="Check for New Messages" disabled={review.busy !== null} onClick={review.check} />
            <ToolbarButton
              icon="checkmark"
              label="Accept and Record"
              disabled={!selected?.postable || review.busy !== null}
              onClick={() => selected && review.accept(selected)}
            />
            <ToolbarButton
              icon="xmark"
              label={selected && !selected.postable ? "Dismiss" : "Ignore"}
              disabled={!selected || review.busy !== null}
              onClick={() => setConfirming(true)}
            />
          </>
        }
        body={
          <WindowBody>
            <ListColumn>
              {data.messages.length > 0 ? (
                <List
                  label="Messages to review"
                  selection={selected ? [selected.eventId] : []}
                  onSelectionChange={(ids) => setSelectedId(ids[0] === undefined ? null : String(ids[0]))}
                  items={data.messages.map((m) => ({
                    id: m.eventId,
                    title: m.sender,
                    subtitle: `${m.kindLabel} · ${m.receivedLabel}`,
                    detail: m.amountText ?? undefined,
                  }))}
                />
              ) : (
                <EmptyState title="No Messages to Review" />
              )}
            </ListColumn>
            <Content>
              {selected ? (
                <MacMessage key={selected.eventId} message={selected} review={review} data={data} onIgnore={() => setConfirming(true)} />
              ) : data.messages.length === 0 ? (
                <EmptyState
                  icon="tray"
                  title="No Messages to Review"
                  message={
                    data.accounts.length === 0
                      ? "Add an account first, then bank messages from the senders you keep appear here."
                      : "New bank messages appear here within moments of arriving. Nothing is recorded until you accept it."
                  }
                  actions={<Button onClick={review.check} disabled={review.busy !== null}>Check for New Messages</Button>}
                />
              ) : (
                <EmptyState title="No Selection" message="Select a message to review it." />
              )}
            </Content>
          </WindowBody>
        }
      />
      <Alert
        open={confirming}
        onClose={() => setConfirming(false)}
        title={selected?.postable === false ? `Dismiss the message from ${selected.sender}?` : `Ignore the message from ${selected?.sender ?? ""}?`}
        message="It stays out of your records. The message itself is kept, so nothing is lost."
        buttons={[
          { label: selected?.postable === false ? "Dismiss" : "Ignore", role: "destructive", onClick: () => selected && review.ignore(selected) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
    </>
  );
}

function MacMessage({ message: m, review, data, onIgnore }: { message: ReviewMessage; review: Review; data: ReviewData; onIgnore: () => void }) {
  const draft = review.draftOf(m);
  const category = review.categoryOf(draft);
  const error = review.errors[m.eventId];
  const notes = notesFor(m);
  const busy = review.busy === m.eventId;

  return (
    <Stack>
      <Section title={m.sender} footer={`${m.kindLabel} · ${engineText(m)} · Received ${m.receivedLabel}`}>
        <GroupBox>
          <p className="pfa-quote">{m.sourceText ?? "The text of this message is not stored."}</p>
        </GroupBox>
      </Section>

      {m.pairedWith ? (
        <Section
          title={`Same payment · ${m.pairedWith.sender}`}
          footer={
            <>
              {pairedExplanation(m)} {m.splitHref ? <a href={m.splitHref}>Not the same payment? Show them separately</a> : null}
            </>
          }
        >
          <GroupBox>
            <p className="pfa-quote">{m.pairedWith.sourceText ?? "The text of this message is not stored."}</p>
          </GroupBox>
        </Section>
      ) : null}

      {notes.length > 0 ? (
        <Section title="Before you accept">
          <Column>
            {notes.map((note) => (
              <Status key={note.key} tone={note.tone} icon={note.icon}>
                {note.text} {note.href ? <a href={note.href}>Open it</a> : null}
              </Status>
            ))}
          </Column>
        </Section>
      ) : null}

      {m.postable ? (
        <Section title="Record as">
          <Form style={{ maxWidth: 640 }} onSubmit={() => review.accept(m)}>
            <FormSection footer={error ? <Status tone="bad">{error}</Status> : accountHint(m)}>
              <FormRow label="Type">
                <SegmentedControl label="Record as" options={RECORD_AS} value={draft.kind} onChange={(kind) => review.update(m, { kind: kind as RecordKind })} />
              </FormRow>
              <FormRow label="Account">
                <PopUpButton
                  options={[{ value: "", label: "Choose an account…", disabled: true }, ...data.accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))]}
                  value={draft.accountId}
                  onChange={(accountId) => review.update(m, { accountId })}
                />
              </FormRow>
              <FormRow label="Amount" subtitle={`In ${review.currencyOf(m, draft)}`}>
                <TextField value={draft.amount} onChange={(amount) => review.update(m, { amount })} inputMode="decimal" placeholder="0.00" autoComplete="off" />
              </FormRow>
              <FormRow label="Date">
                <TextField type="date" value={draft.date} max={data.today} onChange={(date) => review.update(m, { date })} />
              </FormRow>
              <FormRow label="Category">
                <PopUpButton
                  options={review.categoriesFor(draft.kind).map((c) => ({ value: c.id, label: c.name }))}
                  value={category?.id ?? ""}
                  onChange={(categoryId) => review.update(m, { categoryId })}
                />
              </FormRow>
              <FormRow label={draft.kind === "income" ? "Payer" : "Merchant"}>
                <TextField value={draft.merchant} onChange={(merchant) => review.update(m, { merchant })} maxLength={120} placeholder="Optional" />
              </FormRow>
            </FormSection>
            <Row>
              <Spacer />
              <Button onClick={onIgnore} disabled={review.busy !== null}>Ignore</Button>
              <Button type="submit" variant="prominent" disabled={review.busy !== null}>
                {busy ? "Recording…" : "Accept and Record"}
              </Button>
            </Row>
          </Form>
        </Section>
      ) : (
        <Section title="Nothing to record" footer={error ? <Status tone="bad">{error}</Status> : undefined}>
          <Secondary>{NOTHING_TO_RECORD}</Secondary>
          <Row>
            <Button onClick={onIgnore} disabled={review.busy !== null}>Dismiss</Button>
          </Row>
        </Section>
      )}
    </Stack>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

function IosReview({ data }: { data: ReviewData }) {
  const review = useReview(data);
  const [openId, setOpenId] = useState<string | null>(null);
  // An accepted or ignored message leaves the inbox, and its screen with it.
  const open = data.messages.find((m) => m.eventId === openId);
  if (open) return <IosMessage key={open.eventId} message={open} review={review} data={data} onBack={() => setOpenId(null)} />;

  return (
    <IosPage title="Review" back={{ label: "Home", href: "/" }}>
      <IosList>
        <ListSection
          header="Inbox"
          footer={review.report ? <Status tone={review.report.tone}>{review.report.text}</Status> : "Messages become transactions only when you say so."}
        >
          <ListRow title="To review" detail={String(data.messages.length)} />
          <ListRow title="Not read yet" detail={String(data.counts.staged)} />
          {data.counts.waitingForModel > 0 ? <ListRow title="Waiting for the model" detail={String(data.counts.waitingForModel)} /> : null}
          <ListRow title="Background checks" detail={data.checking ? <Status tone="good">Every minute</Status> : <Status tone="warning">Off</Status>} />
          <ListRow
            title={review.busy === "check" ? "Checking…" : "Check for New Messages"}
            action
            disabled={review.busy !== null}
            onClick={review.check}
          />
        </ListSection>
        {data.messages.length > 0 ? (
          <ListSection header="Messages">
            {data.messages.map((m) => (
              <ListRow
                key={m.eventId}
                title={m.sender}
                subtitle={`${m.kindLabel} · ${m.receivedLabel}`}
                detail={m.amountBare ?? undefined}
                onClick={() => setOpenId(m.eventId)}
              />
            ))}
          </ListSection>
        ) : null}
      </IosList>
      {data.messages.length === 0 ? (
        <IosEmptyState
          icon="tray"
          title="Nothing to Review"
          description={
            data.accounts.length === 0
              ? "Add an account first, then bank messages from the senders you keep appear here."
              : "New bank messages appear here within moments of arriving."
          }
        />
      ) : null}
    </IosPage>
  );
}

function IosMessage({ message: m, review, data, onBack }: { message: ReviewMessage; review: Review; data: ReviewData; onBack: () => void }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const draft = review.draftOf(m);
  const category = review.categoryOf(draft);
  const error = review.errors[m.eventId];
  const notes = notesFor(m);
  const busy = review.busy === m.eventId;

  return (
    <IosPage
      title={m.sender}
      back={{ label: "Review", onBack }}
      trailing={
        m.postable ? (
          <BarButton variant="prominent" disabled={review.busy !== null} onClick={() => review.accept(m)}>
            {busy ? "Recording…" : "Accept"}
          </BarButton>
        ) : undefined
      }
    >
      <IosList>
        <ListSection header="Message" footer={`${m.kindLabel} · ${engineText(m)} · ${m.receivedLabel}`}>
          <ListRow title={<span className="pfa-quote">{m.sourceText ?? "The text of this message is not stored."}</span>} />
        </ListSection>

        {m.pairedWith ? (
          <ListSection header={`Same Payment · ${m.pairedWith.sender}`} footer={pairedExplanation(m)}>
            <ListRow title={<span className="pfa-quote">{m.pairedWith.sourceText ?? "The text of this message is not stored."}</span>} />
            {m.splitHref ? <ListRow title="Not the Same Payment? Show Separately" action onClick={() => router.push(m.splitHref as Route)} /> : null}
          </ListSection>
        ) : null}

        {notes.length > 0 ? (
          <ListSection header="Before You Accept">
            {notes.map((note) => (
              <ListRow key={note.key} title={<Status tone={note.tone} icon={note.icon}>{note.text}</Status>} {...(note.href ? { href: note.href } : {})} />
            ))}
          </ListSection>
        ) : null}

        {m.postable ? (
          <>
            <ListSection header="Record As" footer={error ? <Status tone="bad">{error}</Status> : accountHint(m)}>
              <ListRow control={<IosSegmented label="Record as" options={RECORD_AS} value={draft.kind} onChange={(kind) => review.update(m, { kind })} />} />
              <ListRow
                title="Account"
                popup={
                  <IosPopUp
                    label="Account"
                    options={[{ value: "", label: "Choose…", disabled: true }, ...data.accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))]}
                    value={draft.accountId}
                    onChange={(accountId) => review.update(m, { accountId })}
                  />
                }
              />
              <IosFieldRow label="Amount">
                <IosTextField value={draft.amount} onChange={(amount) => review.update(m, { amount })} inputMode="decimal" placeholder="0.00" autoComplete="off" />
              </IosFieldRow>
              <ListRow
                title="Date"
                control={
                  <DatePicker
                    components="date"
                    label="Date"
                    value={dateFromLocal(draft.date)}
                    max={dateFromLocal(data.today)}
                    onChange={(date) => review.update(m, { date: localFromDate(date) })}
                  />
                }
              />
              <ListRow
                title="Category"
                popup={
                  <IosPopUp
                    label="Category"
                    options={review.categoriesFor(draft.kind).map((c) => ({ value: c.id, label: c.name }))}
                    value={category?.id ?? ""}
                    onChange={(categoryId) => review.update(m, { categoryId })}
                  />
                }
              />
              <IosFieldRow label={draft.kind === "income" ? "Payer" : "Merchant"}>
                <IosTextField value={draft.merchant} onChange={(merchant) => review.update(m, { merchant })} placeholder="Optional" maxLength={120} />
              </IosFieldRow>
            </ListSection>
            <ListSection>
              <ListRow title="Ignore This Message" action destructive center disabled={review.busy !== null} onClick={() => setConfirming(true)} />
            </ListSection>
          </>
        ) : (
          <ListSection footer={error ? <Status tone="bad">{error}</Status> : NOTHING_TO_RECORD}>
            <ListRow title="Dismiss" action destructive center disabled={review.busy !== null} onClick={() => setConfirming(true)} />
          </ListSection>
        )}
      </IosList>
      <ActionSheet
        open={confirming}
        onOpenChange={setConfirming}
        title={m.postable ? "Ignore this message?" : "Dismiss this message?"}
        message="It stays out of your records. The message itself is kept, so nothing is lost."
        actions={[
          { label: m.postable ? "Ignore Message" : "Dismiss", role: "destructive", onPress: () => review.ignore(m) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
    </IosPage>
  );
}
