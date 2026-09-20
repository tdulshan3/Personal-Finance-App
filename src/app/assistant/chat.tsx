"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";

import { Button, SubmitButton } from "../../ui/form.tsx";
import { Badge, ErrorNote } from "../../ui/primitives.tsx";
import type { ChatState } from "./actions.ts";
import { cancelProposalAction, confirmProposalAction, sendMessageAction } from "./actions.ts";
import styles from "./chat.module.css";

export type ChatMessageData = {
  readonly id: string;
  readonly role: "owner" | "assistant" | "system_note";
  readonly content: string;
  readonly proposalIds: readonly string[];
};

export type ProposalData = {
  readonly id: string;
  readonly hash: string;
  readonly status: string;
  readonly title: string;
  readonly lines: readonly { label: string; value: string }[];
  readonly effects: readonly string[];
  readonly risk: "low" | "high";
  readonly expiresAt: number;
  readonly resultText: string | null;
};

const STATUS_LABEL: Record<string, { text: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  executed: { text: "Done", tone: "success" },
  cancelled: { text: "Cancelled", tone: "neutral" },
  expired: { text: "Expired", tone: "warning" },
  stale: { text: "Out of date", tone: "warning" },
  failed: { text: "Failed", tone: "danger" },
};

/** Models like to write **bold**. Render that and nothing else; never inject HTML. */
function renderText(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={index}>{part.slice(2, -2)}</strong> : part,
  );
}

function ProposalCard({ proposal, sessionId, now }: { proposal: ProposalData; sessionId: string; now: number }) {
  const [state, confirm] = useActionState<ChatState, FormData>(confirmProposalAction, {});
  const expired = proposal.status === "pending" && now > proposal.expiresAt;
  const minutesLeft = Math.max(1, Math.ceil((proposal.expiresAt - now) / 60_000));
  const status = expired ? STATUS_LABEL.expired : STATUS_LABEL[proposal.status];

  return (
    <section
      className={`${styles.proposal} ${proposal.risk === "high" ? styles.proposalHigh : ""}`}
      aria-label={`Proposed change: ${proposal.title}`}
    >
      <header className={styles.proposalHead}>
        <span>{proposal.title}</span>
        {status ? <Badge tone={status.tone}>{status.text}</Badge> : <Badge tone="primary">Needs your OK</Badge>}
      </header>
      <div className={styles.proposalBody}>
        <dl style={{ margin: 0, display: "grid", gap: "var(--space-2)" }}>
          {proposal.lines.map((line) => (
            <div className={styles.line} key={line.label}>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
        <ul className={styles.effects}>
          {proposal.effects.map((effect) => (
            <li key={effect}>{effect}</li>
          ))}
        </ul>
        {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      </div>

      {proposal.status === "pending" && !expired ? (
        <>
          <div className={styles.proposalActions}>
            <form action={cancelProposalAction}>
              <input type="hidden" name="proposalId" value={proposal.id} />
              <Button type="submit" variant="secondary">Cancel</Button>
            </form>
            <form action={confirm}>
              <input type="hidden" name="proposalId" value={proposal.id} />
              <input type="hidden" name="hash" value={proposal.hash} />
              <input type="hidden" name="sessionId" value={sessionId} />
              <SubmitButton variant={proposal.risk === "high" ? "danger" : "primary"} pendingLabel="Recording…">
                Confirm
              </SubmitButton>
            </form>
          </div>
          <p className={styles.resolved}>Nothing changes until you confirm. Expires in about {minutesLeft} min.</p>
        </>
      ) : (
        <p className={styles.resolved}>
          {expired ? "This expired before it was confirmed. Ask again for a fresh one." : (proposal.resultText ?? "")}
        </p>
      )}
    </section>
  );
}

export function Chat({
  sessionId,
  messages,
  proposals,
  suggestions,
  now,
  disabledReason,
}: {
  sessionId: string;
  messages: readonly ChatMessageData[];
  proposals: Readonly<Record<string, ProposalData>>;
  suggestions: readonly string[];
  now: number;
  disabledReason?: string | undefined;
}) {
  const [state, send, pending] = useActionState<ChatState, FormData>(sendMessageAction, {});
  const [draft, setDraft] = useState("");
  const [sentText, setSentText] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const proposalCount = Object.keys(proposals).length;

  // The owner's words appear at once; the server copy replaces them when the turn finishes.
  useEffect(() => {
    if (!pending) setSentText(null);
  }, [pending, state.nonce]);

  // Scroll the *page* to its end, not a marker above the composer: the composer is sticky, so
  // stopping short leaves it sitting on top of the newest card's last line.
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [messages.length, pending, proposalCount]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const text = draft.trim() || (submitter?.name === "suggestion" ? submitter.value : "");
    if (!text || pending) {
      event.preventDefault();
      return;
    }
    setSentText(text);
    // Clear after the browser has collected the form data for this submit.
    setTimeout(() => setDraft(""), 0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  async function stop() {
    try {
      await fetch("/api/assistant/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch {
      // The turn will still end on its own deadline.
    }
  }

  const isEmpty = messages.length === 0 && !sentText;

  return (
    <div>
      {isEmpty ? (
        <div className={styles.empty}>
          <strong>Ask about your money</strong>
          <span>
            Answers come from your ledger, not from the model&apos;s memory. It can draft a change, but only your
            Confirm button records one.
          </span>
        </div>
      ) : (
        <ol className={styles.thread} aria-live="polite" aria-label="Conversation">
          {messages.map((message) =>
            message.role === "system_note" ? (
              <li key={message.id} className={styles.note}>{message.content}</li>
            ) : (
              <li key={message.id} className={`${styles.row} ${message.role === "owner" ? styles.rowOwner : styles.rowAssistant}`}>
                <div className={`${styles.bubble} ${message.role === "owner" ? styles.owner : styles.assistant}`}>
                  <span className={styles.srOnly}>{message.role === "owner" ? "You: " : "Assistant: "}</span>
                  {renderText(message.content)}
                </div>
                {message.proposalIds.map((id) => {
                  const proposal = proposals[id];
                  return proposal ? <ProposalCard key={id} proposal={proposal} sessionId={sessionId} now={now} /> : null;
                })}
              </li>
            ),
          )}
          {sentText ? (
            <li className={`${styles.row} ${styles.rowOwner}`}>
              <div className={`${styles.bubble} ${styles.owner}`}>{sentText}</div>
            </li>
          ) : null}
          {pending ? (
            <li className={`${styles.row} ${styles.rowAssistant}`}>
              <div className={`${styles.bubble} ${styles.assistant}`} role="status" aria-label="The assistant is working">
                <span className={styles.typing}><span /><span /><span /></span>
              </div>
            </li>
          ) : null}
        </ol>
      )}

      <form ref={formRef} action={send} onSubmit={onSubmit} className={styles.composer}>
        <input type="hidden" name="sessionId" value={sessionId} />
        {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
        {isEmpty && !disabledReason ? (
          <div className={styles.chips}>
            {suggestions.map((suggestion) => (
              <button key={suggestion} type="submit" name="suggestion" value={suggestion} className={styles.chip}>
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        <div className={styles.composerBar}>
          <textarea
            name="text"
            rows={1}
            className={styles.input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={disabledReason ?? "Message"}
            aria-label="Message to the assistant"
            maxLength={2000}
            disabled={Boolean(disabledReason)}
          />
          {pending ? (
            <button type="button" className={styles.stop} onClick={stop} aria-label="Stop the assistant">■</button>
          ) : (
            <button type="submit" className={styles.send} disabled={!draft.trim() || Boolean(disabledReason)} aria-label="Send">↑</button>
          )}
        </div>
      </form>
    </div>
  );
}
