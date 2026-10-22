"use client";

import { useState, useTransition } from "react";
import type { KeyboardEvent } from "react";

import type { ActionState } from "../actions.ts";
import { setupAction } from "../actions.ts";
import { App, List, ListRow, ListSection, NavigationBar, PopUpButton as IosPopUp, SecureField } from "../../ui/ios/ios.tsx";
import { IosFieldRow } from "../../ui/ios-parts.tsx";
import { usePhone } from "../../ui/look.tsx";
import { Button, Content, Form, FormRow, FormSection, PopUpButton, Row, Spacer, Stack, TextField, Titlebar, Window } from "../../ui/macos/macos.tsx";
import { Status, formData } from "../../ui/page.tsx";

/**
 * First launch.
 *
 * buildspec.md §19.A step 1: "Choose theme, currency/timezone, privacy mode, and app lock." The
 * passphrase chosen here is both the app lock and the database key (ADR 0003), which is why the
 * screen says plainly, before anything is written, that losing it means losing the data.
 *
 * There is nowhere to navigate to yet, so this draws its own one-screen shell: a macOS window with
 * a title bar on a desktop, an iOS app with a large title on a phone.
 */

const NO_RECOVERY =
  "There is no recovery. If you forget this passphrase, the ledger cannot be opened — not by you and not by this app. Write it down and store it somewhere separate.";

export function SetupView({ currencies, zones, defaultZone, defaultCurrency }: { currencies: readonly string[]; zones: readonly string[]; defaultZone: string; defaultCurrency: string }) {
  const phone = usePhone();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [zone, setZone] = useState(defaultZone);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = passphrase.length >= 12 && confirm === passphrase && !pending;
  const submit = () => {
    if (!ready) return;
    setError(null);
    // A successful setup redirects to Home from the server; only a refusal comes back here.
    start(async () => {
      const result: ActionState = await setupAction({}, formData({ passphrase, confirm, currency, zone }));
      if (result.error) setError(result.error);
    });
  };
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };
  const problem = error ?? (mismatch ? "The two passphrases do not match." : null);

  if (phone) {
    return (
      <App>
        <NavigationBar variant="large" title="Set Up" subtitle="Everything stays on this phone." />
        <List>
          <ListSection header="Passphrase" footer={<Status tone="warning">{NO_RECOVERY}</Status>}>
            <IosFieldRow label="Passphrase">
              <SecureField value={passphrase} onChange={setPassphrase} placeholder="Required" autoComplete="new-password" autoFocus enterKeyHint="next" />
            </IosFieldRow>
            <IosFieldRow label="Repeat">
              <SecureField value={confirm} onChange={setConfirm} placeholder="Required" autoComplete="new-password" enterKeyHint="go" onKeyDown={onEnter} />
            </IosFieldRow>
          </ListSection>
          <ListSection header="Region" footer="Each account keeps its own currency, and totals are never mixed. The timezone decides which day a transaction belongs to.">
            <ListRow title="Currency" popup={<IosPopUp label="Currency" options={currencies} value={currency} onChange={setCurrency} />} />
            <ListRow title="Timezone" popup={<IosPopUp label="Timezone" options={zones} value={zone} onChange={setZone} />} />
          </ListSection>
          <ListSection footer={problem ? <Status tone="bad">{problem}</Status> : "At least 12 characters. It unlocks the app and encrypts the database."}>
            <ListRow title={pending ? "Creating Your Ledger…" : "Create Ledger"} action disabled={!ready} onClick={submit} />
          </ListSection>
        </List>
      </App>
    );
  }

  return (
    <Window>
      <Titlebar title="Set Up Personal Finance" subtitle="Everything stays on this phone. Nothing is uploaded anywhere." />
      <Content>
        <Stack>
          <Form style={{ maxWidth: 480, marginInline: "auto", width: "100%" }} onSubmit={submit}>
            <FormSection title="Passphrase" footer={<Status tone="warning">{NO_RECOVERY}</Status>}>
              <FormRow label="Passphrase" subtitle="At least 12 characters">
                <TextField type="password" value={passphrase} onChange={setPassphrase} autoComplete="new-password" minLength={12} autoFocus style={{ width: 220 }} />
              </FormRow>
              <FormRow label="Repeat passphrase">
                <TextField type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={12} style={{ width: 220 }} />
              </FormRow>
            </FormSection>
            <FormSection title="Region" footer={problem ? <Status tone="bad">{problem}</Status> : "Each account keeps its own currency, and totals are never mixed. The timezone decides which day a transaction belongs to."}>
              <FormRow label="Currency" subtitle="For new accounts">
                <PopUpButton options={[...currencies]} value={currency} onChange={setCurrency} />
              </FormRow>
              <FormRow label="Timezone">
                <PopUpButton options={[...zones]} value={zone} onChange={setZone} />
              </FormRow>
            </FormSection>
            <Row>
              <Spacer />
              <Button variant="prominent" type="submit" disabled={!ready}>
                {pending ? "Creating Your Ledger…" : "Create Ledger"}
              </Button>
            </Row>
          </Form>
        </Stack>
      </Content>
    </Window>
  );
}
