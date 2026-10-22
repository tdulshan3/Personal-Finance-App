"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import {
  BarButton,
  BarGroup,
  Button as IosButton,
  FormRow as IosFormRow,
  List as IosList,
  ListRow,
  ListSection,
  Sheet as IosSheet,
  TextView,
  Toggle,
} from "../../ui/ios/ios.tsx";
import { READABLE_MARGIN } from "../../ui/ios-parts.tsx";
import type { IconName } from "../../ui/labels.ts";
import { usePhone } from "../../ui/look.tsx";
import {
  Button,
  Checkbox,
  Column,
  Content,
  FieldGrid,
  Form,
  FormRow,
  FormSection,
  FormValue,
  GroupBox,
  Inspector,
  RadioGroup,
  Row,
  Section,
  Spacer,
  Stack,
  TextArea,
  ToolbarButton,
  WindowBody,
} from "../../ui/macos/macos.tsx";
import type { Tone } from "../../ui/page.tsx";
import { IosPage, MacPage, Secondary, Status, formData } from "../../ui/page.tsx";
import { cancelProposalAction, confirmProposalAction, newChatAction, sendMessageAction, setPermissionsAction } from "./actions.ts";

/**
 * The Assistant, in both looks (buildspec.md §14).
 *
 * What the screen must never blur is the line between the model and the ledger: the model can only
 * draft, a draft is a card, and that card's Confirm button is the only thing that records anything.
 * Typing "yes" into the conversation is just more conversation.
 */

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

export type AssistantData = {
  sessionId: string;
  messages: ChatMessageData[];
  proposals: Record<string, ProposalData>;
  suggestions: string[];
  /** The server's clock when the page was drawn, for proposal expiry. */
  now: number;
  endpoint: { model: string; host: string } | null;
  permissions: { mode: "ask" | "assist"; allowDelete: boolean };
};

const STATUS: Record<string, { text: string; tone: Tone; icon: IconName }> = {
  executed: { text: "Done", tone: "good", icon: "checkmark-circle-fill" },
  cancelled: { text: "Cancelled", tone: "neutral", icon: "xmark-circle-fill" },
  expired: { text: "Expired", tone: "warning", icon: "clock" },
  stale: { text: "Out of date", tone: "warning", icon: "exclamationmark-triangle" },
  failed: { text: "Failed", tone: "bad", icon: "exclamationmark-triangle" },
};
const NEEDS_OK = { text: "Needs your OK", tone: "neutral" as const, icon: "info-circle" as const };

const NO_MODEL =
  "Balances, spending, bills, budgets, recent transactions and “I spent 1250.00 on lunch” work right now, with no model. For freer questions, choose a tool-capable model in Settings, under Assistant model.";
const NEVER = "It can never confirm its own drafts, change settings, send anything, or read your raw messages.";
const HOW = (model: string | null) => [
  { title: "From your ledger", text: "Balances, spending, bills, budgets and recent transactions are answered straight from your ledger, instantly, with no model involved." },
  { title: "Freer questions", text: `Anything freer goes to ${model ?? "the model you choose in Settings"}, which can look things up but never does the sums itself.` },
  { title: "Drafts only", text: "It can only draft a change. Nothing is recorded until you press Confirm on the card, and typing “yes” is not confirming." },
];

/** Models like to write **bold**. Render that and nothing else; never inject HTML. */
function renderText(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={index}>{part.slice(2, -2)}</strong> : part,
  );
}

function useChat(data: AssistantData) {
  const [draft, setDraft] = useState("");
  const [sentText, setSentText] = useState<string | null>(null);
  // How many of the owner's messages the server had shown when this one was sent. A live refresh
  // can deliver the stored copy mid-turn; once it has, the optimistic bubble must step aside.
  const [ownerCountAtSend, setOwnerCountAtSend] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, startSend] = useTransition();
  const [working, startWork] = useTransition();
  const endRef = useRef<HTMLSpanElement>(null);

  const ownerCount = data.messages.filter((m) => m.role === "owner").length;
  const optimisticText = sentText !== null && ownerCount === ownerCountAtSend ? sentText : null;
  const proposalCount = Object.keys(data.proposals).length;
  const isEmpty = data.messages.length === 0 && sentText === null;
  // Mid-turn the stored transcript ends with the owner's message: the reply is still being made.
  const awaitingReply = sending || (sentText !== null && data.messages.at(-1)?.role === "owner");
  const hasOpenProposal = Object.values(data.proposals).some((p) => p.status === "pending" && data.now <= p.expiresAt);

  // The owner's words appear at once; the server copy replaces them when the turn finishes.
  useEffect(() => {
    if (!sending) setSentText(null);
  }, [sending]);

  // Keep the newest message in view. The page scrolls inside the kit's content area, not the window.
  useEffect(() => {
    const scroller = endRef.current?.closest(".ios-app__content, .mac-window__content");
    if (!scroller) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [data.messages.length, proposalCount, optimisticText, awaitingReply]);

  const send = (text?: string) => {
    const value = (text ?? draft).trim();
    if (!value || sending) return;
    setError(null);
    setSentText(value);
    setOwnerCountAtSend(ownerCount);
    setDraft("");
    startSend(async () => {
      const result = await sendMessageAction({}, formData({ sessionId: data.sessionId, text: value }));
      if (result.error) setError(result.error);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const stop = async () => {
    try {
      await fetch("/api/assistant/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: data.sessionId }),
      });
    } catch {
      // The turn will still end on its own deadline.
    }
  };

  const newChat = () =>
    startWork(async () => {
      setError(null);
      await newChatAction();
    });

  const savePermissions = (next: { mode: "ask" | "assist"; allowDelete: boolean }, done?: () => void) =>
    startWork(async () => {
      const result = await setPermissionsAction({}, formData({ mode: next.mode, allowDeletePresent: "1", allowDelete: next.allowDelete }));
      if (result.error) setError(result.error);
      else done?.();
    });

  return { draft, setDraft, send, onKeyDown, stop, newChat, savePermissions, sending, working, error, optimisticText, isEmpty, awaitingReply, hasOpenProposal, endRef };
}

type Chat = ReturnType<typeof useChat>;

/** One proposal's state and its two buttons, shared by both looks. */
function useProposal(proposal: ProposalData, sessionId: string, now: number) {
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const expired = proposal.status === "pending" && now > proposal.expiresAt;
  const open = proposal.status === "pending" && !expired;
  const status = expired ? STATUS.expired! : (STATUS[proposal.status] ?? NEEDS_OK);
  const minutesLeft = Math.max(1, Math.ceil((proposal.expiresAt - now) / 60_000));
  const confirm = () =>
    start(async () => {
      setError(null);
      const result = await confirmProposalAction({}, formData({ proposalId: proposal.id, hash: proposal.hash, sessionId }));
      if (result.error) setError(result.error);
    });
  const cancel = () =>
    start(async () => {
      setError(null);
      const result = await cancelProposalAction({}, formData({ proposalId: proposal.id }));
      if (result.error) setError(result.error);
    });
  const footer = open
    ? `Nothing changes until you confirm. Expires in about ${minutesLeft} min.`
    : expired
      ? "This expired before it was confirmed. Ask again for a fresh one."
      : (proposal.resultText ?? "");
  return { error, busy, open, status, confirm, cancel, footer, high: proposal.risk === "high" };
}

export function AssistantView({ data }: { data: AssistantData }) {
  return usePhone() ? <IosAssistant data={data} /> : <MacAssistant data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function MacAssistant({ data }: { data: AssistantData }) {
  const chat = useChat(data);
  const subtitle = data.endpoint ? `${data.endpoint.model} · ${data.endpoint.host}` : "Built-in answers only · no model chosen";

  return (
    <MacPage
      title="Assistant"
      subtitle={subtitle}
      toolbar={
        <>
          <ToolbarButton icon="square-and-pencil" label="New Chat" disabled={chat.working} onClick={chat.newChat} />
          <ToolbarButton icon="switch-2" label="Permissions" popover={<MacPermissions permissions={data.permissions} chat={chat} />} />
        </>
      }
      body={
        <WindowBody>
          <Content>
            <Stack>
              {!data.endpoint ? (
                <Section>
                  <Status tone="neutral">
                    {NO_MODEL} <a href="/settings">Open Settings</a>
                  </Status>
                </Section>
              ) : null}

              {chat.isEmpty ? (
                <Section title="Ask about your money" footer="Answers come from your ledger, not from the model’s memory. It can draft a change, but only your Confirm button records one.">
                  <Row style={{ flexWrap: "wrap" }}>
                    {data.suggestions.map((suggestion) => (
                      <Button key={suggestion} onClick={() => chat.send(suggestion)} disabled={chat.sending}>
                        {suggestion}
                      </Button>
                    ))}
                  </Row>
                </Section>
              ) : (
                <Section>
                  <ol className="pfa-chat" aria-live="polite" aria-label="Conversation">
                    {data.messages.map((message) =>
                      message.role === "system_note" ? (
                        <li key={message.id} className="pfa-chat__note">
                          <Secondary>{message.content}</Secondary>
                        </li>
                      ) : (
                        <li
                          key={message.id}
                          className="pfa-chat__row"
                          data-from={message.role === "owner" ? "owner" : "assistant"}
                          style={message.role === "owner" ? undefined : { alignItems: "flex-start" }}
                        >
                          <div className="pfa-chat__bubble">
                            <span className="visually-hidden">{message.role === "owner" ? "You: " : "Assistant: "}</span>
                            {renderText(message.content)}
                          </div>
                          {message.proposalIds.map((id) => {
                            const proposal = data.proposals[id];
                            return proposal ? <MacProposal key={id} proposal={proposal} data={data} /> : null;
                          })}
                        </li>
                      ),
                    )}
                    {chat.optimisticText ? (
                      <li className="pfa-chat__row" data-from="owner">
                        <div className="pfa-chat__bubble">{chat.optimisticText}</div>
                      </li>
                    ) : null}
                    {chat.awaitingReply ? (
                      <li className="pfa-chat__row" data-from="assistant" style={{ alignItems: "flex-start" }}>
                        <div className="pfa-chat__bubble" role="status" aria-label="The assistant is working">
                          <span className="pfa-typing">
                            <span />
                            <span />
                            <span />
                          </span>
                        </div>
                      </li>
                    ) : null}
                  </ol>
                </Section>
              )}

              <Form onSubmit={() => chat.send()}>
                <FormSection footer={chat.error ? <Status tone="bad">{chat.error}</Status> : "Return sends. Shift-Return starts a new line."}>
                  <FormRow label="Message" stacked>
                    <TextArea
                      value={chat.draft}
                      onChange={chat.setDraft}
                      onKeyDown={chat.onKeyDown}
                      rows={3}
                      maxLength={2000}
                      placeholder="Ask about your money, or say what you spent"
                      aria-label="Message to the assistant"
                    />
                  </FormRow>
                </FormSection>
                <Row>
                  <Spacer />
                  {chat.sending ? (
                    <Button onClick={chat.stop}>Stop</Button>
                  ) : (
                    // One prominent button per window: while a draft waits for Confirm, that is it.
                    <Button type="submit" variant={chat.hasOpenProposal ? "bordered" : "prominent"} disabled={!chat.draft.trim()}>
                      Send
                    </Button>
                  )}
                </Row>
              </Form>
              <span ref={chat.endRef} />
            </Stack>
          </Content>

          <Inspector label="About the assistant">
            <Form>
              <FormSection title="Model">
                <FormRow label="Answers with">
                  <FormValue>{data.endpoint?.model ?? "Built-in answers"}</FormValue>
                </FormRow>
                <FormRow label="Host">
                  <FormValue>{data.endpoint?.host ?? "None"}</FormValue>
                </FormRow>
              </FormSection>
              <FormSection title="Permissions" footer={NEVER}>
                <FormRow label="Mode">
                  <FormValue>{data.permissions.mode === "assist" ? "Can draft changes" : "Read-only"}</FormValue>
                </FormRow>
                <FormRow label="Draft deletions">
                  <FormValue>{data.permissions.allowDelete ? "Allowed" : "Off"}</FormValue>
                </FormRow>
              </FormSection>
              <FormSection title="How it works">
                {HOW(data.endpoint?.model ?? null).map((item) => (
                  <FormRow key={item.title} label={item.title} subtitle={item.text} />
                ))}
              </FormSection>
            </Form>
          </Inspector>
        </WindowBody>
      }
    />
  );
}

function MacPermissions({ permissions, chat }: { permissions: AssistantData["permissions"]; chat: Chat }) {
  const [mode, setMode] = useState(permissions.mode);
  const [allowDelete, setAllowDelete] = useState(permissions.allowDelete);
  const [saved, setSaved] = useState(false);
  const changed = mode !== permissions.mode || allowDelete !== permissions.allowDelete;
  return (
    <Column style={{ width: 320 }}>
      <RadioGroup
        label="What the assistant may do"
        options={[
          { value: "ask", label: "Ask: answers questions only. It cannot draft anything." },
          { value: "assist", label: "Assist: may also draft transactions and transfers. Each one waits for your Confirm." },
        ]}
        value={mode}
        onChange={(value) => {
          setSaved(false);
          setMode(value === "ask" ? "ask" : "assist");
        }}
      />
      <Checkbox
        label="Let it draft moving a transaction to Trash. Still needs your Confirm, and Trash can be undone."
        checked={allowDelete}
        onChange={(value) => {
          setSaved(false);
          setAllowDelete(value);
        }}
      />
      <Secondary>{NEVER}</Secondary>
      <Row>
        {saved && !changed ? <Status tone="good">Saved</Status> : null}
        <Spacer />
        <Button variant="prominent" disabled={!changed || chat.working} onClick={() => chat.savePermissions({ mode, allowDelete }, () => setSaved(true))}>
          Save
        </Button>
      </Row>
    </Column>
  );
}

function MacProposal({ proposal, data }: { proposal: ProposalData; data: AssistantData }) {
  const card = useProposal(proposal, data.sessionId, data.now);
  return (
    <div style={{ alignSelf: "stretch" }} aria-label={`Proposed change: ${proposal.title}`}>
      <GroupBox title={proposal.title}>
        <Column>
          <Status tone={card.status.tone} icon={card.status.icon}>
            {card.status.text}
          </Status>
          <FieldGrid rows={proposal.lines.map((line) => ({ label: `${line.label}:`, control: <span>{line.value}</span> }))} />
          {proposal.effects.map((effect) => (
            <Secondary key={effect}>{effect}</Secondary>
          ))}
          {card.error ? <Status tone="bad">{card.error}</Status> : null}
          {card.open ? (
            <Row>
              <Secondary>{card.footer}</Secondary>
              <Spacer />
              <Button onClick={card.cancel} disabled={card.busy}>Cancel</Button>
              <Button variant={card.high ? "prominent-destructive" : "prominent"} onClick={card.confirm} disabled={card.busy}>
                {card.busy ? "Recording…" : "Confirm"}
              </Button>
            </Row>
          ) : card.footer ? (
            <Secondary>{card.footer}</Secondary>
          ) : null}
        </Column>
      </GroupBox>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

function IosAssistant({ data }: { data: AssistantData }) {
  const chat = useChat(data);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const subtitle = data.endpoint ? `${data.endpoint.model} · ${data.endpoint.host}` : "Built-in answers only";

  /*
   * The thread is bubbles, broken wherever the assistant drafted something: each draft is an inset
   * grouped section of its own, with Confirm and Cancel as action rows.
   */
  const blocks: ReactNode[] = [];
  let bubbles: ReactNode[] = [];
  const flush = () => {
    if (bubbles.length === 0) return;
    blocks.push(
      <ol key={`thread-${blocks.length}`} className="pfa-chat" aria-live="polite" aria-label="Conversation" style={{ padding: `8px ${READABLE_MARGIN}` }}>
        {bubbles}
      </ol>,
    );
    bubbles = [];
  };
  for (const message of data.messages) {
    bubbles.push(
      message.role === "system_note" ? (
        <li key={message.id} className="pfa-chat__note ios-footnote ios-label-secondary">
          {message.content}
        </li>
      ) : (
        <li
          key={message.id}
          className="pfa-chat__row"
          data-from={message.role === "owner" ? "owner" : "assistant"}
          style={message.role === "owner" ? undefined : { alignItems: "flex-start" }}
        >
          <div className="pfa-chat__bubble">
            <span className="visually-hidden">{message.role === "owner" ? "You: " : "Assistant: "}</span>
            {renderText(message.content)}
          </div>
        </li>
      ),
    );
    const proposals = message.proposalIds.map((id) => data.proposals[id]).filter((p): p is ProposalData => p !== undefined);
    if (proposals.length > 0) {
      flush();
      blocks.push(
        <IosList key={`drafts-${message.id}`}>
          {proposals.map((proposal) => (
            <IosProposal key={proposal.id} proposal={proposal} data={data} />
          ))}
        </IosList>,
      );
    }
  }
  if (chat.optimisticText) {
    bubbles.push(
      <li key="optimistic" className="pfa-chat__row" data-from="owner">
        <div className="pfa-chat__bubble">{chat.optimisticText}</div>
      </li>,
    );
  }
  if (chat.awaitingReply) {
    bubbles.push(
      <li key="typing" className="pfa-chat__row" data-from="assistant" style={{ alignItems: "flex-start" }}>
        <div className="pfa-chat__bubble" role="status" aria-label="The assistant is working">
          <span className="pfa-typing">
            <span />
            <span />
            <span />
          </span>
        </div>
      </li>,
    );
  }
  flush();

  return (
    <IosPage
      title="Assistant"
      subtitle={subtitle}
      trailing={
        <BarGroup label="Chat">
          <BarButton icon="square-and-pencil" label="New Chat" disabled={chat.working} onClick={chat.newChat} />
          <BarButton icon="switch-2" label="Permissions" onClick={() => setPermissionsOpen(true)} />
        </BarGroup>
      }
    >
      {!data.endpoint ? (
        <IosList>
          <ListSection footer={NO_MODEL}>
            <ListRow title="Choose a Model" icon="cpu" iconColor="gray" href="/settings" />
          </ListSection>
        </IosList>
      ) : null}

      {chat.isEmpty ? (
        <IosList>
          <ListSection header="Try Asking" footer="Answers come from your ledger, not from the model’s memory. It can draft a change, but only your Confirm button records one.">
            {data.suggestions.map((suggestion) => (
              <ListRow key={suggestion} title={suggestion} leadingSymbol="bubble-left" disabled={chat.sending} onClick={() => chat.send(suggestion)} />
            ))}
          </ListSection>
        </IosList>
      ) : (
        blocks
      )}

      <IosList>
        <ListSection footer={chat.error ? <Status tone="bad">{chat.error}</Status> : undefined}>
          <ListRow
            control={
              <TextView
                value={chat.draft}
                onChange={chat.setDraft}
                onKeyDown={chat.onKeyDown}
                rows={2}
                maxLength={2000}
                placeholder="Message"
                label="Message to the assistant"
              />
            }
          />
          {chat.sending ? (
            <ListRow title="Stop" action destructive center onClick={chat.stop} />
          ) : (
            <ListRow title="Send" action center disabled={!chat.draft.trim()} onClick={() => chat.send()} />
          )}
        </ListSection>
      </IosList>
      <span ref={chat.endRef} />

      <IosPermissions open={permissionsOpen} onOpenChange={setPermissionsOpen} data={data} chat={chat} />
    </IosPage>
  );
}

function IosProposal({ proposal, data }: { proposal: ProposalData; data: AssistantData }) {
  const card = useProposal(proposal, data.sessionId, data.now);
  return (
    <ListSection header={proposal.title} footer={card.footer || undefined} aria-label={`Proposed change: ${proposal.title}`}>
      <ListRow
        title="Status"
        detail={
          <Status tone={card.status.tone} icon={card.status.icon}>
            {card.status.text}
          </Status>
        }
      />
      {proposal.lines.map((line) => (
        <ListRow key={line.label} title={line.label} detail={line.value} />
      ))}
      {proposal.effects.map((effect) => (
        <ListRow key={effect} title={<span className="ios-subheadline ios-label-secondary">{effect}</span>} />
      ))}
      {card.error ? <ListRow title={<Status tone="bad">{card.error}</Status>} /> : null}
      {card.open ? (
        <>
          <ListRow title={card.busy ? "Recording…" : "Confirm"} action destructive={card.high} disabled={card.busy} onClick={card.confirm} />
          <ListRow title="Cancel" action disabled={card.busy} onClick={card.cancel} />
        </>
      ) : null}
    </ListSection>
  );
}

function IosPermissions({ open, onOpenChange, data, chat }: { open: boolean; onOpenChange: (open: boolean) => void; data: AssistantData; chat: Chat }) {
  // Shown at once, saved at once: a setting applies the moment it changes.
  const [shown, setShown] = useState(data.permissions);
  useEffect(() => setShown(data.permissions), [data.permissions]);
  const apply = (change: Partial<AssistantData["permissions"]>) => {
    const next = { ...shown, ...change };
    setShown(next);
    chat.savePermissions(next);
  };
  return (
    <IosSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Permissions"
      trailing={
        <IosButton variant="glass-prominent" onClick={() => onOpenChange(false)}>
          Done
        </IosButton>
      }
    >
      <IosList>
        <ListSection header="The Assistant May" footer={NEVER}>
          <ListRow title="Ask" subtitle="Answers questions only. It cannot draft anything." checked={shown.mode === "ask"} onClick={() => apply({ mode: "ask" })} />
          <ListRow
            title="Assist"
            subtitle="May also draft transactions and transfers. Each one waits for your Confirm."
            checked={shown.mode === "assist"}
            onClick={() => apply({ mode: "assist" })}
          />
        </ListSection>
        <ListSection footer="Still needs your Confirm, and Trash can be undone.">
          <IosFormRow label="Draft Moves to Trash">
            <Toggle checked={shown.allowDelete} onChange={(allowDelete) => apply({ allowDelete })} />
          </IosFormRow>
        </ListSection>
        <ListSection header="How It Works">
          {HOW(data.endpoint?.model ?? null).map((item) => (
            <ListRow key={item.title} title={item.title} subtitle={item.text} />
          ))}
        </ListSection>
      </IosList>
    </IosSheet>
  );
}
