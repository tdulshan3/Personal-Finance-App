"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useSyncExternalStore, useTransition } from "react";

import { lockAction } from "../actions.ts";
import {
  ActionSheet,
  Button as IosButton,
  FormRow as IosFormRow,
  List,
  ListRow,
  ListSection,
  PopUpButton as IosPopUp,
  SecureField,
  Sheet as IosSheet,
  Spinner as IosSpinner,
  TextField as IosTextField,
  Toggle,
} from "../../ui/ios/ios.tsx";
import { IosFieldRow } from "../../ui/ios-parts.tsx";
import { liveStore } from "../../ui/live-store.ts";
import { usePhone } from "../../ui/look.tsx";
import {
  Alert,
  Button,
  Column,
  Disclosure,
  FieldGrid,
  Form,
  FormRow,
  FormSection,
  FormValue,
  PopUpButton,
  PullDownButton,
  MenuItem,
  Row,
  SegmentedControl,
  Sheet,
  Spinner,
  Switch,
  TextField,
} from "../../ui/macos/macos.tsx";
import { IosPage, MacPage, Secondary, Status, formData } from "../../ui/page.tsx";
import type { EndpointFormState } from "./actions.ts";
import { saveEndpointAction, testEndpointAction } from "./actions.ts";
import type { BackupState } from "./backup-actions.ts";
import { createBackupAction } from "./backup-actions.ts";
import { IosImportHistory, MacImportSection, MacImportSheet, useImportHistory } from "./import-history.tsx";
import type { SmsSettingsState } from "./sms-actions.ts";
import { generateSecretAction, toggleSenderAction, toggleWebhookAction, useOwnSecretAction } from "./sms-actions.ts";

/**
 * Settings, in both looks.
 *
 * Every write goes through the actions beside this file, which re-check the session; nothing here
 * holds a secret longer than the moment it is shown. Changes apply at once — the kits' settings
 * pattern — except the few that are tasks (a new signing secret, a backup) and say so on a button.
 */

export type Pane = "capture" | "models" | "data" | "about";

export type EndpointData = {
  role: string;
  title: string;
  blurb: string;
  suggestions: { label: string; url: string }[];
  current: {
    baseUrl: string;
    providerKind: string;
    modelName: string | null;
    modelDigest: string | null;
    quantization: string | null;
    contextLimit: number | null;
    modelLocked: boolean;
    lastTestOk: boolean | null;
    lastTestText: string | null;
  } | null;
  recentTests: { key: string; ok: boolean; detail: string; latencyMs: number | null; when: string }[];
};

export type SettingsData = {
  pane: Pane;
  webhookUrl: string;
  sms: {
    configured: boolean;
    enabled: boolean;
    lastDelivery: string | null;
    stagedMessages: number;
    senders: { senderKey: string; enabled: boolean; seenCount: number; lastSeen: string | null }[];
  };
  endpoints: EndpointData[];
  backups: { name: string; size: string; saved: string }[];
  about: { version: string; schema: number; zone: string; currency: string; unlockedAt: string | null };
};

const PANES: { value: Pane; label: string }[] = [
  { value: "capture", label: "Capture" },
  { value: "models", label: "Models" },
  { value: "data", label: "Backup & Data" },
  { value: "about", label: "About" },
];

const EXPORT_HREF = "/api/export/transactions";
const downloadHref = (name: string) => `/api/backup/download?file=${encodeURIComponent(name)}`;

/**
 * The page is served over plain HTTP on the LAN, where `navigator.clipboard` does not exist. The
 * old select-and-copy route still works there, so it is the fallback.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection copy.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
    }
  };
  return { copied, copy };
}

/* ------------------------------------------------------------------------------------------ */
/* State shared by both looks                                                                   */
/* ------------------------------------------------------------------------------------------ */

function useCapture(sms: SettingsData["sms"]) {
  const [pending, start] = useTransition();
  const [secret, setSecret] = useState<SmsSettingsState>({});
  const [toggle, setToggle] = useState<SmsSettingsState>({});
  const [own, setOwn] = useState<SmsSettingsState>({});
  const [ownDraft, setOwnDraft] = useState("");
  const generate = () => start(async () => setSecret(await generateSecretAction({}, new FormData())));
  const setCapture = (enabled: boolean) => start(async () => setToggle(await toggleWebhookAction({}, formData({ enabled: String(enabled) }))));
  const setSender = (senderKey: string, enabled: boolean) => start(() => toggleSenderAction(formData({ senderKey, enabled: String(enabled) })));
  const adoptOwn = (done: () => void) =>
    start(async () => {
      const result = await useOwnSecretAction({}, formData({ secret: ownDraft.trim() }));
      setOwn(result);
      if (!result.error) {
        setOwnDraft("");
        done();
      }
    });
  const status = !sms.configured ? { tone: "neutral" as const, text: "Not set up" } : sms.enabled ? { tone: "good" as const, text: "Listening" } : { tone: "warning" as const, text: "Paused" };
  return { pending, secret, toggle, own, ownDraft, setOwnDraft, generate, setCapture, setSender, adoptOwn, status };
}

function useEndpoint(endpoint: EndpointData) {
  const [baseUrl, setBaseUrl] = useState(endpoint.current?.baseUrl ?? "");
  const [model, setModel] = useState(endpoint.current?.modelName ?? "");
  const [tested, setTested] = useState<EndpointFormState>({});
  const [saved, setSaved] = useState<EndpointFormState>({});
  const [testing, startTest] = useTransition();
  const [saving, startSave] = useTransition();
  const test = () => {
    if (!baseUrl.trim()) return;
    setSaved({});
    startTest(async () => setTested(await testEndpointAction({}, formData({ role: endpoint.role, baseUrl: baseUrl.trim() }))));
  };
  const save = () => {
    if (!model) return;
    startSave(async () => setSaved(await saveEndpointAction({}, formData({ role: endpoint.role, baseUrl: baseUrl.trim(), modelName: model }))));
  };
  const models = tested.models ?? [];
  const options = models.map((m) => ({
    value: m.id,
    label: `${m.id}${m.parameterCount ? ` — ${(m.parameterCount / 1e9).toFixed(1)}B` : ""}${m.quantization ? ` ${m.quantization}` : ""}${m.digest ? "" : " (no digest)"}`,
  }));
  const testedText = tested.ok
    ? [tested.ok, tested.providerKind ? `speaks ${tested.providerKind}` : null, tested.serverHeader ?? null, tested.resolvedBaseUrl && tested.resolvedBaseUrl !== baseUrl.trim() ? `using ${tested.resolvedBaseUrl}` : null]
        .filter(Boolean)
        .join(" · ")
    : null;
  return { baseUrl, setBaseUrl, model, setModel, tested, saved, testing, saving, test, save, models, options, testedText };
}

function endpointStatus(current: EndpointData["current"]) {
  if (!current) return { tone: "neutral" as const, text: "Not configured" };
  if (current.modelLocked) return { tone: "warning" as const, text: "Locked" };
  if (current.lastTestOk === true) return { tone: "good" as const, text: "Reachable" };
  if (current.lastTestOk === false) return { tone: "bad" as const, text: "Unreachable" };
  return { tone: "neutral" as const, text: "Not tested" };
}

/** §7.2 requires the digest to be stored with every extraction; say so when it is absent. */
function endpointDetails(current: NonNullable<EndpointData["current"]>) {
  return [
    current.modelDigest ? `digest ${current.modelDigest.slice(0, 12)}…` : "this host reports no digest, so extractions cannot record one",
    current.quantization,
    current.contextLimit ? `ctx ${current.contextLimit.toLocaleString("en-GB")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function useBackup() {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<BackupState>({});
  const [pending, start] = useTransition();
  const ready = passphrase.length >= 12 && confirm.length >= 12 && !pending;
  const create = () => {
    if (!ready) return;
    start(async () => {
      const outcome = await createBackupAction({}, formData({ backupPassphrase: passphrase, confirm }));
      setResult(outcome);
      if (!outcome.error) {
        setPassphrase("");
        setConfirm("");
      }
    });
  };
  return { passphrase, setPassphrase, confirm, setConfirm, result, pending, ready, create };
}

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

const LIVE_LABELS = { live: "Live", connecting: "Connecting…", offline: "Offline", off: "Paused" } as const;

function useLiveLabel() {
  const state = useSyncExternalStore(liveStore.subscribe, liveStore.get, liveStore.getServer);
  return { text: LIVE_LABELS[state], tone: state === "live" ? ("good" as const) : state === "offline" ? ("bad" as const) : ("neutral" as const) };
}

function useLock() {
  const [pending, start] = useTransition();
  return { pending, lock: () => start(() => lockAction()) };
}

export function SettingsView({ data }: { data: SettingsData }) {
  return usePhone() ? <IosSettings data={data} /> : <MacSettings data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function MacSettings({ data }: { data: SettingsData }) {
  const [pane, setPane] = useState<Pane>(data.pane);
  // Held here, above the panes: a new signing secret is shown once and must survive a pane switch.
  const capture = useCapture(data.sms);
  const label = PANES.find((p) => p.value === pane)?.label ?? "Settings";
  return (
    <MacPage
      title="Settings"
      subtitle={label}
      toolbar={<SegmentedControl label="Settings section" options={PANES} value={pane} onChange={(value) => setPane(value as Pane)} />}
    >
      {pane === "capture" ? <MacCapture data={data} capture={capture} /> : null}
      {pane === "models" ? <MacModels data={data} /> : null}
      {pane === "data" ? <MacData data={data} /> : null}
      {pane === "about" ? <MacAbout data={data} /> : null}
    </MacPage>
  );
}

function MacCapture({ data, capture }: { data: SettingsData; capture: ReturnType<typeof useCapture> }) {
  const history = useImportHistory();
  const { copied, copy } = useCopy();
  const [confirmNew, setConfirmNew] = useState(false);
  const [pasting, setPasting] = useState(false);
  const { sms } = data;

  return (
    <>
      <Form style={{ maxWidth: 640 }}>
        <FormSection
          title="SMS capture"
          footer={
            capture.toggle.error ? (
              <Status tone="bad">{capture.toggle.error}</Status>
            ) : (
              "Your bank messages arrive on a different phone. A small app there forwards each new one here; while capture is paused it is refused, so the app tries again later and nothing is lost."
            )
          }
        >
          <FormRow label="Status">
            <FormValue>
              <Status tone={capture.status.tone}>{capture.status.text}</Status>
            </FormValue>
          </FormRow>
          <FormRow label="Last message">
            <FormValue>{sms.lastDelivery ?? (sms.configured ? "Nothing received yet" : "--")}</FormValue>
          </FormRow>
          <FormRow label="Messages stored">
            <FormValue>{sms.stagedMessages}</FormValue>
          </FormRow>
          <FormRow label="Accept messages" subtitle={sms.configured ? undefined : "Set a signing secret first"}>
            <Switch checked={sms.enabled} disabled={!sms.configured || capture.pending} onChange={capture.setCapture} />
          </FormRow>
        </FormSection>

        <FormSection title="1. Webhook URL" footer="Paste this into the collector app on the phone your bank messages arrive on.">
          <FormRow label="Address">
            <Row>
              <TextField readOnly value={data.webhookUrl} style={{ width: 340 }} aria-label="Webhook URL" />
              <Button size="small" onClick={() => void copy("url", data.webhookUrl)}>{copied === "url" ? "Copied" : "Copy"}</Button>
            </Row>
          </FormRow>
        </FormSection>

        <FormSection
          title="2. Signing secret"
          footer={
            capture.secret.secret ? (
              <Status tone="warning">Copy this into the collector app now. It is not shown again — if you lose it, generate a new one and update the app.</Status>
            ) : capture.secret.error ? (
              <Status tone="bad">{capture.secret.error}</Status>
            ) : capture.own.ok ? (
              <Status tone={capture.own.ok.startsWith("Saved, but") ? "warning" : "good"}>{capture.own.ok}</Status>
            ) : sms.configured ? (
              "A secret already exists. Generating a new one stops the old one working immediately."
            ) : (
              "The collector signs every message with this secret, so nothing else on the network can post to the ledger."
            )
          }
        >
          {capture.secret.secret ? (
            <FormRow label="New secret">
              <Row>
                <TextField readOnly value={capture.secret.secret} style={{ width: 340 }} aria-label="New signing secret" />
                <Button size="small" onClick={() => void copy("secret", capture.secret.secret!)}>{copied === "secret" ? "Copied" : "Copy"}</Button>
              </Row>
            </FormRow>
          ) : null}
          <FormRow label={sms.configured ? "Replace the secret" : "Make a secret here"}>
            <Button size="small" disabled={capture.pending} onClick={() => (sms.configured ? setConfirmNew(true) : capture.generate())}>
              {sms.configured ? "Generate New Secret…" : "Generate Secret"}
            </Button>
          </FormRow>
          <FormRow label="Or use the app's own" subtitle="The collector app can generate one itself">
            <Button size="small" onClick={() => setPasting(true)}>Paste Secret…</Button>
          </FormRow>
        </FormSection>

        <FormSection
          title="3. Senders"
          footer="A sender switches on by itself the first time it sends something financial — a debit, a credit, a bill — and that message goes to Review. One-time codes, offers and personal texts are never stored. Turn a sender off to silence it for good."
        >
          {sms.senders.length === 0 ? (
            <FormRow label="No messages yet">
              <FormValue>Senders appear here as messages arrive</FormValue>
            </FormRow>
          ) : (
            sms.senders.map((sender) => (
              <FormRow
                key={sender.senderKey}
                label={sender.senderKey}
                subtitle={`${sender.seenCount} message${sender.seenCount === 1 ? "" : "s"}${sender.lastSeen ? ` · last ${sender.lastSeen}` : ""}${sender.enabled ? "" : " · nothing stored"}`}
              >
                <Switch checked={sender.enabled} disabled={capture.pending} onChange={(on) => capture.setSender(sender.senderKey, on)} aria-label={`Keep messages from ${sender.senderKey}`} />
              </FormRow>
            ))
          )}
        </FormSection>

        <MacImportSection flow={history} />
      </Form>
      <MacImportSheet flow={history} />

      <Alert
        open={confirmNew}
        onClose={() => setConfirmNew(false)}
        title="Generate a new signing secret?"
        message="The current secret stops working at once. Messages are refused until you put the new one into the collector app."
        buttons={[
          { label: "Generate", role: "destructive", onClick: capture.generate },
          { label: "Cancel", role: "cancel" },
        ]}
      />
      <Sheet
        open={pasting}
        onClose={(button) => (button === "Cancel" || button === undefined ? setPasting(false) : undefined)}
        title="Use the Collector App's Secret"
        top={60}
        buttons={[
          { label: "Cancel", role: "cancel" },
          { label: capture.pending ? "Saving…" : "Use This Secret", role: "default", disabled: capture.ownDraft.trim().length < 16 || capture.pending, onClick: () => capture.adoptOwn(() => setPasting(false)) },
        ]}
      >
        <FieldGrid
          rows={[
            {
              label: "Secret:",
              control: <TextField value={capture.ownDraft} onChange={capture.setOwnDraft} autoComplete="off" spellCheck={false} placeholder="Paste the secret shown in the app" style={{ width: 320 }} autoFocus />,
              note: capture.own.error ?? "At least 16 characters, no spaces. Both sides must hold exactly the same value.",
              error: Boolean(capture.own.error),
            },
          ]}
        />
      </Sheet>
    </>
  );
}

function MacModels({ data }: { data: SettingsData }) {
  return (
    <>
      {data.endpoints.map((endpoint) => (
        <MacEndpoint key={endpoint.role} endpoint={endpoint} />
      ))}
      <Form style={{ maxWidth: 640 }}>
        <FormSection
          title="Why the endpoint has to be reachable"
          footer={
            <>
              Both models run on other machines on your network, so the phone can only use them while it is on that network. Ollama listens on localhost by default, which the phone
              cannot reach: start it with <code>OLLAMA_HOST=0.0.0.0</code> on the PC, and keep it on your own network — it has no authentication of its own.
            </>
          }
        >
          <FormRow label="Sender templates">
            <FormValue><Status tone="good">Work offline</Status></FormValue>
          </FormRow>
          <FormRow label="Model work">
            <FormValue>Queues until the host is back</FormValue>
          </FormRow>
          <FormRow label="Messages">
            <FormValue>Captured either way; nothing is lost</FormValue>
          </FormRow>
        </FormSection>
      </Form>
    </>
  );
}

function MacEndpoint({ endpoint }: { endpoint: EndpointData }) {
  const state = useEndpoint(endpoint);
  const status = endpointStatus(endpoint.current);
  const current = endpoint.current;
  return (
    <Form style={{ maxWidth: 640 }} onSubmit={state.test}>
      <FormSection title={endpoint.title} footer={endpoint.blurb}>
        <FormRow label="Model" subtitle={current ? current.baseUrl : undefined}>
          <FormValue>
            {current?.modelName ?? "No model chosen"} · <Status tone={status.tone}>{status.text}</Status>
          </FormValue>
        </FormRow>
        {current ? (
          <FormRow label="Provider" subtitle={endpointDetails(current)}>
            <FormValue>{current.providerKind}</FormValue>
          </FormRow>
        ) : null}
        <FormRow label="Base URL" subtitle="A trailing /v1 is added or removed automatically">
          <TextField value={state.baseUrl} onChange={state.setBaseUrl} placeholder="http://192.168.1.84:11434" inputMode="url" autoComplete="off" spellCheck={false} style={{ width: 260 }} />
        </FormRow>
        <FormRow label="Known hosts">
          <PullDownButton label="Use a Known Host" size="small">
            {endpoint.suggestions.map((s) => (
              <MenuItem key={s.url} onSelect={() => state.setBaseUrl(s.url)}>
                {s.label} — {s.url}
              </MenuItem>
            ))}
          </PullDownButton>
        </FormRow>
        <FormRow
          label="Connection"
          subtitle={state.tested.error ? <Status tone="bad">{state.tested.error}</Status> : state.testedText ? <Status tone="good">{state.testedText}</Status> : "Lists the models installed on that host"}
        >
          {state.testing ? <Spinner label="Checking" /> : <Button size="small" type="submit" disabled={!state.baseUrl.trim()}>Test Connection</Button>}
        </FormRow>
        {state.models.length > 0 ? (
          <>
            <FormRow label="Installed model" subtitle="Only models actually installed on that host are listed">
              <PopUpButton options={[{ value: "", label: "Choose a model…", disabled: true }, ...state.options]} value={state.model} onChange={state.setModel} size="small" />
            </FormRow>
            <FormRow
              label="Use it"
              subtitle={state.saved.error ? <Status tone="bad">{state.saved.error}</Status> : state.saved.ok ? <Status tone="good">{state.saved.ok}.</Status> : undefined}
            >
              {state.saving ? <Spinner label="Saving" /> : <Button size="small" disabled={!state.model} onClick={state.save}>Save {endpoint.title}</Button>}
            </FormRow>
          </>
        ) : null}
      </FormSection>
      {endpoint.recentTests.length > 0 ? (
        <Disclosure title="Recent connection checks">
          <Column>
            {endpoint.recentTests.map((test) => (
              <span key={test.key}>
                <Status tone={test.ok ? "good" : "bad"}>{test.ok ? "OK" : "Failed"}</Status>{" "}
                <Secondary>
                  {test.when} · {test.detail}
                  {test.latencyMs !== null ? ` · ${test.latencyMs} ms` : ""}
                </Secondary>
              </span>
            ))}
          </Column>
        </Disclosure>
      ) : null}
    </Form>
  );
}

function MacData({ data }: { data: SettingsData }) {
  const backup = useBackup();
  const lock = useLock();
  const go = (href: string) => window.location.assign(href);
  return (
    <>
      <Form style={{ maxWidth: 640 }} onSubmit={backup.create}>
        <FormSection
          title="Backup"
          footer={
            backup.result.error ? (
              <Status tone="bad">{backup.result.error}</Status>
            ) : (
              <Status tone="warning">This password is separate from your unlock passphrase and is the only way to open the backup. There is no recovery.</Status>
            )
          }
        >
          <FormRow label="Backup password" subtitle="At least 12 characters">
            <TextField type="password" value={backup.passphrase} onChange={backup.setPassphrase} autoComplete="new-password" minLength={12} style={{ width: 240 }} />
          </FormRow>
          <FormRow label="Repeat password">
            <TextField type="password" value={backup.confirm} onChange={backup.setConfirm} autoComplete="new-password" minLength={12} style={{ width: 240 }} />
          </FormRow>
          <FormRow label="Make an encrypted copy" subtitle="Download it and keep it somewhere else — a backup that only lives on the phone is lost with the phone">
            {backup.pending ? <Spinner label="Creating backup" /> : <Button variant="prominent" size="small" type="submit" disabled={!backup.ready}>Create Backup</Button>}
          </FormRow>
        </FormSection>
        {backup.result.ok && backup.result.fileName ? (
          <FormSection title="Backup created" footer={<a href={downloadHref(backup.result.fileName)}>Download this backup</a>}>
            <FormRow label="File">
              <FormValue>{backup.result.fileName}</FormValue>
            </FormRow>
            {Object.entries(backup.result.counts ?? {}).map(([table, count]) => (
              <FormRow key={table} label={COUNT_LABELS[table] ?? table}>
                <FormValue>{count}</FormValue>
              </FormRow>
            ))}
          </FormSection>
        ) : null}
      </Form>

      <Form style={{ maxWidth: 640 }}>
        <FormSection title="Backups on this device" footer="Restoring a backup isn't available in the app yet.">
          {data.backups.length === 0 ? (
            <FormRow label="None yet">
              <FormValue>--</FormValue>
            </FormRow>
          ) : (
            data.backups.map((file) => (
              <FormRow key={file.name} label={file.name} subtitle={`${file.saved} · ${file.size}`}>
                <Button size="small" onClick={() => go(downloadHref(file.name))}>Download</Button>
              </FormRow>
            ))
          )}
        </FormSection>

        <FormSection title="Your data" footer="Locking drops the key from memory and closes the database. Message capture pauses until you unlock again.">
          <FormRow label="Export transactions" subtitle="Every recorded transaction as a CSV file, for a spreadsheet">
            <Button size="small" onClick={() => go(EXPORT_HREF)}>Export CSV</Button>
          </FormRow>
          <FormRow label="Lock now">
            <Button size="small" disabled={lock.pending} onClick={lock.lock}>Lock</Button>
          </FormRow>
        </FormSection>
      </Form>
    </>
  );
}

function MacAbout({ data }: { data: SettingsData }) {
  const live = useLiveLabel();
  return (
    <Form style={{ maxWidth: 640 }}>
      <FormSection title="About" footer="The whole ledger lives on this phone, encrypted with your passphrase. Nothing syncs to a cloud service, and the models only ever see the text of a message being read.">
        <FormRow label="Version">
          <FormValue>{data.about.version}</FormValue>
        </FormRow>
        <FormRow label="Database schema">
          <FormValue>Version {data.about.schema}</FormValue>
        </FormRow>
        <FormRow label="Currency">
          <FormValue>{data.about.currency}</FormValue>
        </FormRow>
        <FormRow label="Timezone">
          <FormValue>{data.about.zone}</FormValue>
        </FormRow>
        <FormRow label="Unlocked">
          <FormValue>{data.about.unlockedAt ?? "--"}</FormValue>
        </FormRow>
        <FormRow label="Live updates" subtitle="Changes from your other devices and new messages appear within a second">
          <FormValue>
            <Status tone={live.tone}>{live.text}</Status>
          </FormValue>
        </FormRow>
      </FormSection>
    </Form>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

type Screen = "capture" | "import" | "extraction" | "agent" | "backup";

function IosSettings({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen | null>(null);
  const capture = useCapture(data.sms);
  const lock = useLock();
  const live = useLiveLabel();
  const back = () => setScreen(null);

  if (screen === "capture") return <IosCapture key="capture" data={data} capture={capture} onBack={back} onImport={() => setScreen("import")} />;
  if (screen === "import") return <IosImportHistory key="import" onBack={() => setScreen("capture")} />;
  if (screen === "extraction" || screen === "agent") {
    const endpoint = data.endpoints.find((e) => e.role === screen);
    if (endpoint) return <IosEndpoint key={screen} endpoint={endpoint} onBack={back} />;
  }
  if (screen === "backup") return <IosBackup key="backup" data={data} onBack={back} />;

  const extraction = data.endpoints.find((e) => e.role === "extraction");
  const agent = data.endpoints.find((e) => e.role === "agent");
  return (
    <IosPage title="Settings" back={{ label: "Home", href: "/" }}>
      <List>
        <ListSection header="Messages">
          <ListRow title="Message Capture" icon="envelope" iconColor="green" detail={capture.status.text} onClick={() => setScreen("capture")} />
          <ListRow title="Import History" icon="tray-and-arrow-down" iconColor="blue" onClick={() => setScreen("import")} />
        </ListSection>
        <ListSection header="Models" footer="Two separate configurations. Saving one never changes the other.">
          <ListRow title="Extraction Model" icon="cpu" iconColor="indigo" detail={extraction?.current?.modelName ?? "Not set"} onClick={() => setScreen("extraction")} />
          <ListRow title="Assistant Model" icon="bubble-left" iconColor="purple" detail={agent?.current?.modelName ?? "Not set"} onClick={() => setScreen("agent")} />
        </ListSection>
        <ListSection header="Data">
          <ListRow title="Backup" icon="archivebox" iconColor="orange" detail={data.backups.length > 0 ? String(data.backups.length) : undefined} onClick={() => setScreen("backup")} />
          <ListRow title="Export Transactions (CSV)" icon="square-and-arrow-up" iconColor="teal" chevron={false} onClick={() => window.location.assign(EXPORT_HREF)} />
        </ListSection>
        <ListSection header="About" footer="The whole ledger lives on this phone, encrypted with your passphrase. Nothing syncs to a cloud service.">
          <ListRow title="Version" detail={data.about.version} />
          <ListRow title="Currency" detail={data.about.currency} />
          <ListRow title="Timezone" detail={data.about.zone} />
          <ListRow title="Unlocked" detail={data.about.unlockedAt ?? "--"} />
          <ListRow title="Live Updates" detail={<Status tone={live.tone}>{live.text}</Status>} />
        </ListSection>
        <ListSection footer="Drops the key from memory. Message capture pauses until you unlock again.">
          <ListRow title={lock.pending ? "Locking…" : "Lock Now"} action disabled={lock.pending} onClick={lock.lock} />
        </ListSection>
        <ListSection>
          <ListRow title="Review Messages" icon="tray" iconColor="gray" onClick={() => router.push("/review")} />
        </ListSection>
      </List>
    </IosPage>
  );
}

function IosCapture({ data, capture, onBack, onImport }: { data: SettingsData; capture: ReturnType<typeof useCapture>; onBack: () => void; onImport: () => void }) {
  const { copied, copy } = useCopy();
  const [confirmNew, setConfirmNew] = useState(false);
  const [pasting, setPasting] = useState(false);
  const { sms } = data;

  return (
    <IosPage title="Message Capture" back={{ label: "Settings", onBack }}>
      <List>
        <ListSection footer={capture.toggle.error ? <Status tone="bad">{capture.toggle.error}</Status> : "Your bank messages arrive on a different phone. A small app there forwards each new one here; while capture is paused it is refused, so the app tries again later."}>
          <ListRow title="Status" detail={<Status tone={capture.status.tone}>{capture.status.text}</Status>} />
          <ListRow title="Last Message" detail={sms.lastDelivery ?? (sms.configured ? "None yet" : "--")} />
          <ListRow title="Stored" detail={String(sms.stagedMessages)} />
          <IosFormRow label="Accept Messages" disabled={!sms.configured}>
            <Toggle checked={sms.enabled} disabled={!sms.configured || capture.pending} onChange={capture.setCapture} />
          </IosFormRow>
        </ListSection>

        <ListSection header="1. Webhook URL" footer="Paste this into the collector app.">
          <ListRow title={<span className="pfa-quote">{data.webhookUrl}</span>} buttonLabel={copied === "url" ? "Copied" : "Copy"} onButtonClick={() => void copy("url", data.webhookUrl)} />
        </ListSection>

        <ListSection
          header="2. Signing Secret"
          footer={
            capture.secret.secret ? (
              <Status tone="warning">Copy this into the collector app now. It is not shown again.</Status>
            ) : capture.secret.error ? (
              <Status tone="bad">{capture.secret.error}</Status>
            ) : capture.own.ok ? (
              <Status tone={capture.own.ok.startsWith("Saved, but") ? "warning" : "good"}>{capture.own.ok}</Status>
            ) : sms.configured ? (
              "A secret already exists. Generating a new one stops the old one working immediately."
            ) : (
              "The collector signs every message with this, so nothing else on the network can post to the ledger."
            )
          }
        >
          {capture.secret.secret ? (
            <ListRow title={<span className="ios-mono pfa-quote">{capture.secret.secret}</span>} buttonLabel={copied === "secret" ? "Copied" : "Copy"} onButtonClick={() => void copy("secret", capture.secret.secret!)} />
          ) : null}
          <ListRow title={sms.configured ? "Generate New Secret" : "Generate Secret"} action disabled={capture.pending} onClick={() => (sms.configured ? setConfirmNew(true) : capture.generate())} />
          <ListRow title="Paste the App's Own Secret" action onClick={() => setPasting(true)} />
        </ListSection>

        <ListSection
          header="3. Senders"
          footer="A sender switches on by itself the first time it sends something financial, and that message goes to Review. One-time codes, offers and personal texts are never stored. Turn a sender off to silence it for good."
        >
          {sms.senders.length === 0 ? (
            <ListRow title="No messages yet" subtitle="Senders appear here as messages arrive." />
          ) : (
            sms.senders.map((sender) => (
              <IosFormRow
                key={sender.senderKey}
                label={sender.senderKey}
                subtitle={`${sender.seenCount} message${sender.seenCount === 1 ? "" : "s"}${sender.lastSeen ? ` · last ${sender.lastSeen}` : ""}${sender.enabled ? "" : " · nothing stored"}`}
              >
                <Toggle checked={sender.enabled} disabled={capture.pending} onChange={(on) => capture.setSender(sender.senderKey, on)} />
              </IosFormRow>
            ))
          )}
        </ListSection>

        <ListSection footer="The collector cannot see messages from before it was installed. Bring those in from a backup file.">
          <ListRow title="Import History" icon="tray-and-arrow-down" iconColor="blue" onClick={onImport} />
        </ListSection>
      </List>

      <ActionSheet
        open={confirmNew}
        onOpenChange={(open) => !open && setConfirmNew(false)}
        title="Generate a new signing secret?"
        message="The current secret stops working at once. Messages are refused until you put the new one into the collector app."
        actions={[
          { label: "Generate New Secret", role: "destructive", onPress: capture.generate },
          { label: "Cancel", role: "cancel" },
        ]}
      />
      <IosSheet
        open={pasting}
        onOpenChange={(open) => !open && setPasting(false)}
        title="App's Secret"
        dismissible={capture.ownDraft === ""}
        leading={<IosButton variant="glass" onClick={() => setPasting(false)}>Cancel</IosButton>}
        trailing={
          <IosButton variant="glass-prominent" disabled={capture.ownDraft.trim().length < 16 || capture.pending} onClick={() => capture.adoptOwn(() => setPasting(false))}>
            Save
          </IosButton>
        }
      >
        <List>
          <ListSection footer={capture.own.error ? <Status tone="bad">{capture.own.error}</Status> : "At least 16 characters, no spaces. Both sides must hold exactly the same value."}>
            <ListRow control={<IosTextField value={capture.ownDraft} onChange={capture.setOwnDraft} placeholder="Paste the secret shown in the app" autoComplete="off" spellCheck={false} label="Secret" />} />
          </ListSection>
        </List>
      </IosSheet>
    </IosPage>
  );
}

function IosEndpoint({ endpoint, onBack }: { endpoint: EndpointData; onBack: () => void }) {
  const state = useEndpoint(endpoint);
  const status = endpointStatus(endpoint.current);
  const current = endpoint.current;
  const title = endpoint.title.replace(/ model$/, " Model");
  return (
    <IosPage title={title} back={{ label: "Settings", onBack }}>
      <List>
        <ListSection header="Current" footer={endpoint.blurb}>
          <ListRow title="Model" detail={current?.modelName ?? "None chosen"} />
          <ListRow title="Status" detail={<Status tone={status.tone}>{status.text}</Status>} />
          {current ? <ListRow title="Provider" subtitle={endpointDetails(current)} detail={current.providerKind} /> : null}
          {current ? <ListRow title="Address" subtitle={current.baseUrl} /> : null}
        </ListSection>

        <ListSection header="Base URL" footer="The address of the machine running the model. A trailing /v1 is added or removed automatically.">
          <ListRow control={<IosTextField value={state.baseUrl} onChange={state.setBaseUrl} placeholder="http://192.168.1.84:11434" inputMode="url" autoComplete="off" spellCheck={false} label="Base URL" />} />
          {endpoint.suggestions.map((s) => (
            <ListRow key={s.url} title={s.label} subtitle={s.url} checked={state.baseUrl.trim() === s.url} onClick={() => state.setBaseUrl(s.url)} />
          ))}
        </ListSection>

        <ListSection footer={state.tested.error ? <Status tone="bad">{state.tested.error}</Status> : state.testedText ? <Status tone="good">{state.testedText}</Status> : "Lists the models installed on that host."}>
          <ListRow
            title={state.testing ? "Checking…" : "Test Connection"}
            action
            disabled={state.testing || !state.baseUrl.trim()}
            onClick={state.test}
            detail={state.testing ? <IosSpinner size="small" label="Checking" /> : undefined}
          />
        </ListSection>

        {state.models.length > 0 ? (
          <ListSection header="Model" footer={state.saved.error ? <Status tone="bad">{state.saved.error}</Status> : state.saved.ok ? <Status tone="good">{state.saved.ok}.</Status> : "Only models actually installed on that host are listed."}>
            <ListRow title="Installed" popup={<IosPopUp label="Model" options={[{ value: "", label: "Choose…", disabled: true }, ...state.options]} value={state.model} onChange={state.setModel} />} />
            <ListRow title={state.saving ? "Saving…" : `Use for ${endpoint.role === "agent" ? "the Assistant" : "Extraction"}`} action disabled={!state.model || state.saving} onClick={state.save} />
          </ListSection>
        ) : null}

        {endpoint.recentTests.length > 0 ? (
          <ListSection header="Recent Checks" collapsible defaultExpanded={false}>
            {endpoint.recentTests.map((test) => (
              <ListRow key={test.key} title={<Status tone={test.ok ? "good" : "bad"}>{test.ok ? "OK" : "Failed"}</Status>} subtitle={`${test.when}${test.latencyMs !== null ? ` · ${test.latencyMs} ms` : ""} · ${test.detail}`} />
            ))}
          </ListSection>
        ) : null}

        <ListSection header="Reachability" footer="Ollama listens on localhost by default, which the phone cannot reach: start it with OLLAMA_HOST=0.0.0.0 on the PC, and keep it on your own network.">
          <ListRow title="Sender templates" detail={<Status tone="good">Work offline</Status>} />
          <ListRow title="Model work" detail="Queues" />
          <ListRow title="Messages" detail="Never lost" />
        </ListSection>
      </List>
    </IosPage>
  );
}

function IosBackup({ data, onBack }: { data: SettingsData; onBack: () => void }) {
  const backup = useBackup();
  const id = useId();
  return (
    <IosPage title="Backup" back={{ label: "Settings", onBack }}>
      <List>
        <ListSection header="New Backup" footer={<Status tone="warning">This password is separate from your unlock passphrase and is the only way to open the backup. There is no recovery.</Status>}>
          <IosFieldRow label="Password">
            <SecureField id={`${id}-p`} value={backup.passphrase} onChange={backup.setPassphrase} placeholder="12 characters or more" autoComplete="new-password" />
          </IosFieldRow>
          <IosFieldRow label="Repeat">
            <SecureField id={`${id}-c`} value={backup.confirm} onChange={backup.setConfirm} placeholder="Required" autoComplete="new-password" />
          </IosFieldRow>
        </ListSection>
        <ListSection footer={backup.result.error ? <Status tone="bad">{backup.result.error}</Status> : "Makes an encrypted copy of the whole ledger on this phone. Download it and keep it somewhere else."}>
          <ListRow
            title={backup.pending ? "Creating Backup…" : "Create Backup"}
            action
            disabled={!backup.ready}
            onClick={backup.create}
            detail={backup.pending ? <IosSpinner size="small" label="Creating backup" /> : undefined}
          />
        </ListSection>

        {backup.result.ok && backup.result.fileName ? (
          <ListSection header="Backup Created" footer={backup.result.fileName}>
            {Object.entries(backup.result.counts ?? {}).map(([table, count]) => (
              <ListRow key={table} title={COUNT_LABELS[table] ?? table} detail={String(count)} />
            ))}
            <ListRow title="Download This Backup" action onClick={() => window.location.assign(downloadHref(backup.result.fileName!))} />
          </ListSection>
        ) : null}

        <ListSection header="On This Phone" footer="Restoring a backup isn't available in the app yet.">
          {data.backups.length === 0 ? (
            <ListRow title="None yet" />
          ) : (
            data.backups.map((file) => (
              <ListRow key={file.name} title={file.name} subtitle={`${file.saved} · ${file.size}`} buttonLabel="Download" onButtonClick={() => window.location.assign(downloadHref(file.name))} />
            ))
          )}
        </ListSection>
        <ListSection>
          <ListRow title="Export Transactions (CSV)" action onClick={() => window.location.assign(EXPORT_HREF)} />
        </ListSection>
      </List>
    </IosPage>
  );
}
