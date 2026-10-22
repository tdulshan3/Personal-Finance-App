"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { plural } from "../../ui/format.ts";
import { FormRow as IosFormRow, List, ListRow, ListSection, Spinner as IosSpinner, Toggle } from "../../ui/ios/ios.tsx";
import { Button, Checkbox, Column, FieldGrid, FormRow, FormSection, FormValue, Sheet, Spinner } from "../../ui/macos/macos.tsx";
import { IosPage, Secondary, Status } from "../../ui/page.tsx";

/**
 * Importing message history from an SMS Backup & Restore file (buildspec.md §5.3).
 *
 * The collector app only ever sees messages that arrive after it is installed. Older ones come in
 * here: the owner exports them on that phone, chooses the .xml file, sees what is in it without
 * anything being stored, ticks the senders to keep, and imports. The file is read in the browser
 * and posted as it is to `/api/import/sms-xml`, which does all the parsing.
 *
 * Senders already kept for live capture start ticked; every other sender starts unticked, with the
 * number of its messages the rules read as money beside it to help the choice. Nothing becomes a
 * transaction until it is accepted on Review.
 */

const MAX_BYTES = 64 * 1024 * 1024;

type SenderPreview = { senderKey: string; count: number; firstAt: number; lastAt: number; financial: number; known: boolean; enabled: boolean };
type Preview = {
  totalInFile: number;
  inbox: number;
  skippedNonInbox: number;
  skippedUnusable: number;
  senders: SenderPreview[];
  earliest: number | null;
  latest: number | null;
};
type Result = { staged: number; duplicates: number; filtered: number; considered: number };
type Phase = "idle" | "reading" | "preview" | "importing" | "done";

const day = (instant: number | null) =>
  instant === null ? "--" : new Date(instant).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function useImportHistory() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = async (query: string, text: string) => {
    const response = await fetch(`/api/import/sms-xml?${query}`, { method: "POST", headers: { "content-type": "text/xml; charset=utf-8" }, body: text });
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    if (!response.ok) throw new Error(body.detail ?? "The file could not be read.");
    return body;
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    setError(null);
    setResult(null);
    if (picked.size > MAX_BYTES) {
      setError("That file is over 64 MB. Export a shorter date range and try again.");
      return;
    }
    setPhase("reading");
    try {
      const text = await picked.text();
      const found = (await post("step=preview", text)) as Preview;
      setFile({ name: picked.name, text });
      setPreview(found);
      setChosen(new Set(found.senders.filter((s) => s.enabled).map((s) => s.senderKey)));
      setPhase("preview");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The file could not be read.");
      setPhase("idle");
    }
  };

  const toggle = (sender: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(sender);
      else next.delete(sender);
      return next;
    });

  const chooseMoney = () => setChosen(new Set((preview?.senders ?? []).filter((s) => s.enabled || s.financial > 0).map((s) => s.senderKey)));

  const run = async () => {
    if (!file || chosen.size === 0) return;
    setPhase("importing");
    setError(null);
    try {
      const query = new URLSearchParams([["step", "import"], ...[...chosen].map((sender): [string, string] => ["sender", sender])]);
      setResult((await post(query.toString(), file.text)) as Result);
      setPhase("done");
      setFile(null);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The import did not finish.");
      setPhase("preview");
    }
  };

  const cancel = () => {
    setPhase("idle");
    setFile(null);
    setPreview(null);
  };

  const chosenMessages = (preview?.senders ?? []).filter((s) => chosen.has(s.senderKey)).reduce((sum, s) => sum + s.count, 0);
  const picker = (
    <input
      ref={input}
      type="file"
      accept=".xml,text/xml,application/xml"
      className="visually-hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => void onFile(event)}
    />
  );
  return { phase, file, preview, chosen, chosenMessages, result, error, picker, choose: () => input.current?.click(), toggle, chooseMoney, run, cancel };
}

const EXPLANATION =
  "The collector only sees messages that arrive after it is installed. To bring in older ones, export them with SMS Backup & Restore on that phone and choose the .xml file here. Nothing is recorded until you accept it on Review, and one-time codes and offers are thrown away by the rules.";

const senderDetail = (s: SenderPreview) =>
  [plural(s.count, "message"), s.financial > 0 ? `${s.financial} look like money` : null, s.enabled ? "kept live" : s.known ? "stopped live" : null].filter(Boolean).join(" · ");

const resultText = (r: Result) => `${plural(r.staged, "message")} added, ${r.duplicates} already here, ${r.filtered} from senders you left out.`;

export type ImportFlow = ReturnType<typeof useImportHistory>;

/** The macOS section, inside the Capture pane's form. */
export function MacImportSection({ flow }: { flow: ImportFlow }) {
  return (
    <FormSection title="Import message history" footer={flow.error && !flow.preview ? <Status tone="bad">{flow.error}</Status> : EXPLANATION}>
      <FormRow label="Backup file" subtitle="An SMS Backup & Restore .xml export">
        {flow.phase === "reading" ? <Spinner label="Reading the file" /> : <Button size="small" onClick={flow.choose}>Choose File…</Button>}
      </FormRow>
      {flow.result ? (
        <FormRow label="Last import" subtitle={<a href="/review">Open Review</a>}>
          <FormValue>{resultText(flow.result)}</FormValue>
        </FormRow>
      ) : null}
    </FormSection>
  );
}

/**
 * The preview sheet and the hidden file picker. Rendered after the pane's form, never inside it:
 * a sheet is a dialog with a form of its own, and forms do not nest.
 */
export function MacImportSheet({ flow }: { flow: ImportFlow }) {
  // Each checkbox needs its own id: inside a FieldGrid row they would all inherit the row's one.
  const ids = useId();
  const open = flow.phase === "preview" || flow.phase === "importing";
  return (
    <>
      {flow.picker}
      <Sheet
        open={open}
        // Import keeps the sheet up until the server answers; Cancel and Escape close it at once.
        onClose={(button) => (button === "Cancel" || button === undefined ? flow.cancel() : undefined)}
        title="Import Message History"
        top={60}
        buttons={[
          { label: "Cancel", role: "cancel" },
          {
            label: flow.phase === "importing" ? "Importing…" : `Import ${plural(flow.chosenMessages, "Message")}`,
            role: "default",
            disabled: flow.chosen.size === 0 || flow.phase === "importing",
            onClick: () => void flow.run(),
          },
        ]}
      >
        {flow.preview ? (
          <FieldGrid
            rows={[
              { label: "File:", control: <FormValue>{flow.file?.name}</FormValue> },
              { label: "Covers:", control: <FormValue>{day(flow.preview.earliest)} to {day(flow.preview.latest)}</FormValue> },
              {
                label: "Messages:",
                control: <FormValue>{plural(flow.preview.inbox, "received message")}</FormValue>,
                note: `${flow.preview.skippedNonInbox} sent by you and ${flow.preview.skippedUnusable} unreadable are left out.`,
              },
              {
                label: "Senders:",
                control: (
                  <div style={{ maxHeight: 260, overflowY: "auto" }}>
                    <Column>
                      {flow.preview.senders.map((s, index) => (
                        <Checkbox key={s.senderKey} id={`${ids}-${index}`} checked={flow.chosen.has(s.senderKey)} onChange={(on) => flow.toggle(s.senderKey, on)} label={`${s.senderKey} — ${senderDetail(s)}`} />
                      ))}
                    </Column>
                  </div>
                ),
                note: (
                  <>
                    Only ticked senders are stored; the rest are counted and dropped.{" "}
                    <Button size="small" variant="borderless" onClick={flow.chooseMoney}>Tick the ones that look like money</Button>
                  </>
                ),
              },
              ...(flow.error ? [{ label: "", control: <Status tone="bad">{flow.error}</Status> }] : []),
            ]}
          />
        ) : null}
      </Sheet>
    </>
  );
}

/** The iOS screen, pushed from Settings. */
export function IosImportHistory({ onBack }: { onBack: () => void }) {
  const flow = useImportHistory();
  const preview = flow.phase === "preview" || flow.phase === "importing" ? flow.preview : null;
  return (
    <IosPage title="Import History" back={{ label: "Settings", onBack }}>
      {flow.picker}
      <List>
        <ListSection footer={flow.error && !preview ? <Status tone="bad">{flow.error}</Status> : EXPLANATION}>
          <ListRow
            title={flow.phase === "reading" ? "Reading the File…" : preview ? "Choose Another File…" : "Choose Backup File…"}
            subtitle={preview ? flow.file?.name : undefined}
            action
            disabled={flow.phase === "reading" || flow.phase === "importing"}
            onClick={flow.choose}
            detail={flow.phase === "reading" ? <IosSpinner size="small" label="Reading" /> : undefined}
          />
        </ListSection>

        {preview ? (
          <>
            <ListSection header="In This File" footer={`${preview.skippedNonInbox} sent by you and ${preview.skippedUnusable} unreadable are left out.`}>
              <ListRow title="Messages" detail={String(preview.inbox)} />
              <ListRow title="From" detail={day(preview.earliest)} />
              <ListRow title="To" detail={day(preview.latest)} />
            </ListSection>
            <ListSection header="Senders" footer="Only ticked senders are stored; the rest are counted and dropped. Senders you keep for live capture are ticked already.">
              {preview.senders.map((s) => (
                <IosFormRow key={s.senderKey} label={s.senderKey} subtitle={senderDetail(s)}>
                  <Toggle checked={flow.chosen.has(s.senderKey)} onChange={(on) => flow.toggle(s.senderKey, on)} />
                </IosFormRow>
              ))}
              <ListRow title="Tick the Ones That Look Like Money" action onClick={flow.chooseMoney} />
            </ListSection>
            <ListSection footer={flow.error ? <Status tone="bad">{flow.error}</Status> : undefined}>
              <ListRow
                title={flow.phase === "importing" ? "Importing…" : `Import ${plural(flow.chosenMessages, "Message")}`}
                action
                disabled={flow.chosen.size === 0 || flow.phase === "importing"}
                onClick={() => void flow.run()}
              />
            </ListSection>
          </>
        ) : null}

        {flow.result ? (
          <ListSection header="Imported" footer={<Secondary>New messages are read within a minute and wait on Review.</Secondary>}>
            <ListRow title="Added" detail={String(flow.result.staged)} />
            <ListRow title="Already here" detail={String(flow.result.duplicates)} />
            <ListRow title="Senders left out" detail={String(flow.result.filtered)} />
            <ListRow title="Open Review" href="/review" />
          </ListSection>
        ) : null}
      </List>
    </IosPage>
  );
}
