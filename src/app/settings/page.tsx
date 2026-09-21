import { redirect } from "next/navigation";

import { createModelSettingsService, EndpointRole } from "../../core/services/model-settings-service.ts";
import { requireDb } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { headers } from "next/headers";

import { Badge, Card, Columns, PageHeader, Shell, Stack } from "../../ui/primitives.tsx";
import { BackupSection } from "./backup-section.tsx";
import { EndpointCard } from "./endpoint-card.tsx";
import { smsOverview } from "./sms-actions.ts";
import { SmsCard } from "./sms-card.tsx";

export const dynamic = "force-dynamic";

/**
 * Settings.
 *
 * buildspec.md §13 lists "Two AI configurations" first among the settings this screen owns, and
 * §7.2/§14.1 require them to be genuinely independent — separate URLs, separate clients, separate
 * connection tests, and a save on one that cannot touch the other.
 */
export default async function SettingsPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const settings = createModelSettingsService(requireDb());
  const sms = await smsOverview();

  /*
   * The collector posts from another device, so the URL it needs is whatever host this page was
   * reached on -- not localhost, which would be the phone talking to itself.
   */
  const host = (await headers()).get("host") ?? "192.168.1.118:8090";
  const webhookUrl = `http://${host}/api/v1/sources/sms-webhook`;
  const extraction = settings.read(EndpointRole.EXTRACTION);
  const agent = settings.read(EndpointRole.AGENT);

  return (
    <Shell>
      <PageHeader
        title="Settings"
        subtitle="Two separate AI configurations. Saving one never changes the other."
      />

      {/*
        Desktop: capture and backups on the left, the two model endpoints on the right. On a phone
        the stacks dissolve; the wrapper's `order` keeps Backups last, where it has always been.
      */}
      <Columns layout="halves">
        <Stack>
          <SmsCard overview={sms} webhookUrl={webhookUrl} />
          <div style={{ order: 1, minWidth: 0 }}>
            <BackupSection />
          </div>
        </Stack>

        <Stack>
          <EndpointCard
            role={EndpointRole.EXTRACTION}
            title="Extraction model"
            blurb={
              "Reads financial messages into structured data. The sender templates settle almost every " +
              "message on their own, so this runs only on the few they cannot: choose the model on this " +
              "phone and capture keeps working with the PC switched off, at about 20 seconds a message."
            }
            current={serialise(extraction)}
            recentTests={settings.recentTests(EndpointRole.EXTRACTION, 3).map(serialiseTest)}
            suggestions={[
              { label: "This phone (always on)", url: "http://192.168.1.118:8081/v1" },
              { label: "Ollama on the PC (faster)", url: "http://192.168.1.84:11434" },
            ]}
          />

          <EndpointCard
            role={EndpointRole.AGENT}
            title="Assistant model"
            blurb={
              "Answers questions and proposes changes. It never writes to the ledger directly — every " +
              "change it suggests needs your confirmation first. This one has to call tools, which the " +
              "small model on this phone cannot do; use a 2B or larger model on the PC."
            }
            current={serialise(agent)}
            recentTests={settings.recentTests(EndpointRole.AGENT, 3).map(serialiseTest)}
            suggestions={[
              { label: "Ollama on the PC", url: "http://192.168.1.84:11434" },
              { label: "This phone (no tool calling)", url: "http://192.168.1.118:8081/v1" },
            ]}
          />

          <Card title="Why the endpoint has to be reachable">
            <div style={{ display: "grid", gap: "var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              <p>
                Both models run on other machines on your network, so the phone can only use them while
                it is on that network. Messages still arrive and are captured when it is not — they
                queue, and the queue drains by itself once the model host is reachable again.
              </p>
              <p>
                Ollama listens on localhost by default, which the phone cannot reach. To use it from the
                phone, start Ollama with <code>OLLAMA_HOST=0.0.0.0</code> on the PC. Keep it on your own
                network: it has no authentication of its own.
              </p>
              <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                <Badge tone="primary">Templates work offline</Badge>
                <Badge>Model work queues</Badge>
                <Badge>Nothing is lost</Badge>
              </div>
            </div>
          </Card>
        </Stack>
      </Columns>
    </Shell>
  );
}

function serialise(record: ReturnType<ReturnType<typeof createModelSettingsService>["read"]>) {
  if (!record) return undefined;
  return {
    baseUrl: record.baseUrl,
    providerKind: record.providerKind,
    modelName: record.modelName ?? null,
    modelDigest: record.modelDigest ?? null,
    quantization: record.quantization ?? null,
    parameterSize: record.parameterSize ?? null,
    contextLimit: record.contextLimit ?? null,
    modelLocked: record.modelLocked,
    lastTestAt: record.lastTestAt ?? null,
    lastTestOk: record.lastTestOk ?? null,
    lastTestDetail: record.lastTestDetail ?? null,
  };
}

function serialiseTest(test: {
  baseUrl: string;
  ok: boolean;
  detail: string;
  latencyMs?: number | undefined;
  testedAt: number;
}) {
  return {
    baseUrl: test.baseUrl,
    ok: test.ok,
    detail: test.detail,
    latencyMs: test.latencyMs ?? null,
    testedAt: test.testedAt,
  };
}
