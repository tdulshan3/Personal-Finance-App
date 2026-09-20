"use client";

import { useActionState, useState } from "react";

import { Badge, Card, ErrorNote, InfoNote } from "../../ui/primitives.tsx";
import { Button, Field, SubmitButton, TextInput } from "../../ui/form.tsx";
import type { SmsOverview, SmsSettingsState } from "./sms-actions.ts";
import {
  generateSecretAction,
  toggleSenderAction,
  toggleWebhookAction,
  useOwnSecretAction,
} from "./sms-actions.ts";

/**
 * SMS capture setup.
 *
 * The ledger runs on one phone and the messages arrive on another, so this screen's job is to hand
 * over a URL and a secret, then let the owner say which senders are financial.
 *
 * buildspec.md §5.4 makes that second step the consent gate: until a sender is enabled the app has
 * stored its name and how often it writes, and no message content at all.
 */
export function SmsCard({ overview, webhookUrl }: { overview: SmsOverview; webhookUrl: string }) {
  const [secretState, runGenerate] = useActionState<SmsSettingsState, FormData>(
    generateSecretAction,
    {},
  );
  const [toggleState, runToggle] = useActionState<SmsSettingsState, FormData>(
    toggleWebhookAction,
    {},
  );
  const [ownState, runOwn] = useActionState<SmsSettingsState, FormData>(useOwnSecretAction, {});
  const [copied, setCopied] = useState<string | null>(null);
  const [showOwn, setShowOwn] = useState(false);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  return (
    <Card title="SMS capture">
      <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-4)" }}>
        Your bank messages arrive on a different phone. A small app there forwards each new one here.
        It cannot read messages that arrived before it was installed.
      </p>

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        {overview.configured ? (
          overview.enabled ? <Badge tone="success">Listening</Badge> : <Badge tone="warning">Paused</Badge>
        ) : (
          <Badge>Not set up</Badge>
        )}
        {overview.lastDeliveryAt ? (
          <Badge tone="primary">
            Last message {new Date(overview.lastDeliveryAt).toLocaleString()}
          </Badge>
        ) : overview.configured ? (
          <Badge tone="warning">Nothing received yet</Badge>
        ) : null}
        {overview.stagedMessages > 0 ? <Badge>{overview.stagedMessages} stored</Badge> : null}
      </div>

      {/* Step 1 — the address the collector posts to. */}
      <div style={{ display: "grid", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
        <span style={{ fontSize: "var(--font-sm)", fontWeight: 560 }}>1. Webhook URL</span>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
          <code
            style={{
              flex: "1 1 260px",
              padding: "var(--space-3) var(--space-4)",
              background: "var(--surface-sunken)",
              borderRadius: "var(--radius-input)",
              fontSize: "var(--font-sm)",
              overflowWrap: "anywhere",
            }}
          >
            {webhookUrl}
          </code>
          <Button
            type="button"
            variant="secondary"
            onClick={() => copy("url", webhookUrl)}
            style={{ minHeight: "40px" }}
          >
            {copied === "url" ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      {/* Step 2 — the shared secret, shown exactly once. */}
      <div style={{ display: "grid", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
        <span style={{ fontSize: "var(--font-sm)", fontWeight: 560 }}>2. Signing secret</span>

        {secretState.secret ? (
          <>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
              <code
                style={{
                  flex: "1 1 260px",
                  padding: "var(--space-3) var(--space-4)",
                  background: "var(--warning-soft)",
                  color: "var(--warning)",
                  borderRadius: "var(--radius-input)",
                  fontSize: "var(--font-sm)",
                  overflowWrap: "anywhere",
                }}
              >
                {secretState.secret}
              </code>
              <Button
                type="button"
                variant="secondary"
                onClick={() => copy("secret", secretState.secret!)}
                style={{ minHeight: "40px" }}
              >
                {copied === "secret" ? "Copied" : "Copy"}
              </Button>
            </div>
            <InfoNote>
              Copy this into the collector app now. It is not shown again — if you lose it, generate
              a new one and update the app.
            </InfoNote>
          </>
        ) : (
          <form action={runGenerate}>
            <SubmitButton variant={overview.configured ? "secondary" : "primary"} pendingLabel="Generating…">
              {overview.configured ? "Generate a new secret" : "Generate secret"}
            </SubmitButton>
          </form>
        )}

        {overview.configured && !secretState.secret ? (
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
            A secret already exists. Generating a new one stops the old one working immediately.
          </span>
        ) : null}
        {secretState.error ? <ErrorNote>{secretState.error}</ErrorNote> : null}

        {/*
          The collector app can generate its own key. When it has, forcing a server-generated one
          just means retyping 64 characters into a phone for no benefit.
        */}
        {showOwn ? (
          <form action={runOwn} style={{ marginTop: "var(--space-3)" }}>
            <Field
              label="Paste the secret the collector app generated"
              hint="At least 16 characters, no spaces. Both sides must hold exactly the same value."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="secret"
                  required
                  minLength={16}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the secret shown in the app"
                  describedBy={describedBy}
                />
              )}
            </Field>
            <div style={{ marginTop: "var(--space-3)" }}>
              <SubmitButton pendingLabel="Saving…">Use this secret</SubmitButton>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowOwn(true)}
            style={{ justifySelf: "start", padding: 0, minHeight: "32px" }}
          >
            Or paste one the app already generated
          </Button>
        )}

        {ownState.error ? <ErrorNote>{ownState.error}</ErrorNote> : null}
        {ownState.ok ? (
          <p role="status" style={{ fontSize: "var(--font-sm)", color: "var(--success)" }}>
            {ownState.ok}
          </p>
        ) : null}
      </div>

      {/* Step 3 — consent, per sender. */}
      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        <span style={{ fontSize: "var(--font-sm)", fontWeight: 560 }}>3. Senders</span>

        {overview.senders.length === 0 ? (
          <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
            No messages have arrived yet. A sender switches on by itself the first time it sends
            something financial (a debit, a credit, a bill), and that message goes to Review. One-time
            codes, offers and personal texts are never stored. Press Stop on any sender to silence it
            for good.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-3)" }}>
            {overview.senders.map((sender) => (
              <li
                key={sender.senderKey}
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
                  <span style={{ fontWeight: 560, overflowWrap: "anywhere" }}>{sender.senderKey}</span>
                  <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                    {sender.seenCount} message{sender.seenCount === 1 ? "" : "s"}
                    {sender.lastSeenAt
                      ? ` · last ${new Date(sender.lastSeenAt).toLocaleDateString()}`
                      : ""}
                    {sender.enabled ? "" : " · nothing stored"}
                  </span>
                </div>
                <form action={toggleSenderAction}>
                  <input type="hidden" name="senderKey" value={sender.senderKey} />
                  <input type="hidden" name="enabled" value={sender.enabled ? "false" : "true"} />
                  <Button
                    variant={sender.enabled ? "secondary" : "primary"}
                    style={{ minHeight: "38px", padding: "0 var(--space-4)" }}
                  >
                    {sender.enabled ? "Stop" : "Keep"}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      {overview.configured ? (
        <form action={runToggle} style={{ marginTop: "var(--space-4)" }}>
          <input type="hidden" name="enabled" value={overview.enabled ? "false" : "true"} />
          <SubmitButton variant="secondary" pendingLabel="Saving…">
            {overview.enabled ? "Pause capture" : "Resume capture"}
          </SubmitButton>
        </form>
      ) : null}

      {toggleState.error ? <ErrorNote>{toggleState.error}</ErrorNote> : null}
      {toggleState.ok ? (
        <p role="status" style={{ marginTop: "var(--space-3)", fontSize: "var(--font-sm)", color: "var(--success)" }}>
          {toggleState.ok}
        </p>
      ) : null}
    </Card>
  );
}
