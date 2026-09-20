import { redirect } from "next/navigation";

import { createModelSettingsService, EndpointRole } from "../../core/services/model-settings-service.ts";
import { requireDb } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { Badge, Card, PageHeader, Shell } from "../../ui/primitives.tsx";
import { EndpointCard } from "./endpoint-card.tsx";

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
  const extraction = settings.read(EndpointRole.EXTRACTION);
  const agent = settings.read(EndpointRole.AGENT);

  return (
    <Shell>
      <PageHeader
        title="Settings"
        subtitle="Two separate AI configurations. Saving one never changes the other."
      />

      <EndpointCard
        role={EndpointRole.EXTRACTION}
        title="Extraction model"
        blurb={
          "Reads financial messages into structured data. Runs once per message that the " +
          "deterministic sender templates cannot handle, so speed matters more here than anywhere else."
        }
        current={serialise(extraction)}
        recentTests={settings.recentTests(EndpointRole.EXTRACTION, 3).map(serialiseTest)}
        suggestions={[
          { label: "Ollama on the PC", url: "http://192.168.1.84:11434" },
          { label: "llama.cpp host", url: "http://192.168.1.118:8081" },
        ]}
      />

      <EndpointCard
        role={EndpointRole.AGENT}
        title="Assistant model"
        blurb={
          "Answers questions and proposes changes. It never writes to the ledger directly — every " +
          "change it suggests needs your confirmation first."
        }
        current={serialise(agent)}
        recentTests={settings.recentTests(EndpointRole.AGENT, 3).map(serialiseTest)}
        suggestions={[
          { label: "Ollama on the PC", url: "http://192.168.1.84:11434" },
          { label: "llama.cpp host", url: "http://192.168.1.118:8081" },
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
