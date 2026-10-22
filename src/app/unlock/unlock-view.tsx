"use client";

import { useState, useTransition } from "react";
import type { KeyboardEvent } from "react";

import type { ActionState } from "../actions.ts";
import { unlockAction } from "../actions.ts";
import { App, List, ListRow, ListSection, NavigationBar, SecureField } from "../../ui/ios/ios.tsx";
import { IosFieldRow } from "../../ui/ios-parts.tsx";
import { usePhone } from "../../ui/look.tsx";
import { Button, Content, Form, FormRow, FormSection, Row, Spacer, Stack, TextField, Titlebar, Window } from "../../ui/macos/macos.tsx";
import { Status, formData } from "../../ui/page.tsx";

/**
 * buildspec.md §18 strict lock mode: the key is only in memory, so a restart means a fresh unlock.
 * The copy says plainly that message capture is paused while locked rather than implying the app
 * keeps working (§18: do not "promise both mandatory biometric authentication for every key use
 * and fully unattended processing").
 *
 * `needsSessionOnly` is the other way to land here: the ledger is open, but this browser has no
 * session yet — another device unlocked it. The passphrase confirms this browser too.
 */
export function UnlockView({ needsSessionOnly }: { needsSessionOnly: boolean }) {
  const phone = usePhone();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const explanation = needsSessionOnly
    ? "The ledger is open, but this browser has not been confirmed. Enter your passphrase to continue."
    : "Enter your passphrase to decrypt the ledger. Message capture is paused until you do.";
  const ready = passphrase.length > 0 && !pending;
  const submit = () => {
    if (!ready) return;
    setError(null);
    // Success redirects to Home from the server; only a refusal comes back here.
    start(async () => {
      const result: ActionState = await unlockAction({}, formData({ passphrase }));
      if (result.error) setError(result.error);
    });
  };
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };

  if (phone) {
    return (
      <App>
        <NavigationBar variant="large" title="Locked" />
        <List>
          <ListSection footer={error ? <Status tone="bad">{error}</Status> : explanation}>
            <IosFieldRow label="Passphrase">
              <SecureField value={passphrase} onChange={setPassphrase} placeholder="Required" autoComplete="current-password" autoFocus enterKeyHint="go" onKeyDown={onEnter} />
            </IosFieldRow>
          </ListSection>
          <ListSection>
            <ListRow title={pending ? "Unlocking…" : "Unlock"} action disabled={!ready} onClick={submit} />
          </ListSection>
        </List>
      </App>
    );
  }

  return (
    <Window>
      <Titlebar title="Personal Finance is Locked" subtitle={needsSessionOnly ? "This browser has not been confirmed" : "Message capture is paused"} />
      <Content>
        <Stack>
          <Form style={{ maxWidth: 480, marginInline: "auto", width: "100%" }} onSubmit={submit}>
            <FormSection footer={error ? <Status tone="bad">{error}</Status> : explanation}>
              <FormRow label="Passphrase">
                <TextField type="password" value={passphrase} onChange={setPassphrase} autoComplete="current-password" autoFocus style={{ width: 240 }} />
              </FormRow>
            </FormSection>
            <Row>
              <Spacer />
              <Button variant="prominent" type="submit" disabled={!ready}>
                {pending ? "Unlocking…" : "Unlock"}
              </Button>
            </Row>
          </Form>
        </Stack>
      </Content>
    </Window>
  );
}
