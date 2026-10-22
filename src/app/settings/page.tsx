import { headers } from "next/headers";
import { redirect } from "next/navigation";

import packageJson from "../../../package.json";
import { currentSchemaVersion } from "../../core/data/migrations.ts";
import { createModelSettingsService, EndpointRole } from "../../core/services/model-settings-service.ts";
import { currentVault, requireDb, requireService, unlockedSince } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { listBackups } from "./backup-files.ts";
import { smsOverview } from "./sms-actions.ts";
import type { EndpointData, Pane, SettingsData } from "./settings-view.tsx";
import { SettingsView } from "./settings-view.tsx";

export const dynamic = "force-dynamic";

const PANES: readonly Pane[] = ["capture", "models", "data", "about"];
const SHOWN_BACKUPS = 10;

/**
 * Settings.
 *
 * buildspec.md §13 lists "Two AI configurations" first among the settings this screen owns, and
 * §7.2/§14.1 require them to be genuinely independent — separate URLs, separate clients, separate
 * connection tests, and a save on one that cannot touch the other. §14.2 keeps every setting here
 * out of the assistant's reach: these are owner-only flows behind the authenticated session.
 *
 * Dates and sizes are formatted here, in the owner's timezone, so the browser's own zone never
 * gets a say and the server and client render the same text.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const zone = requireService().zone;
  const settings = createModelSettingsService(requireDb());
  const params = await searchParams;
  const asked = typeof params.pane === "string" ? params.pane : "";
  const when = (instant: number) => new Date(instant).toLocaleString("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "short" });

  /*
   * The collector posts from another device, so the URL it needs is whatever host this page was
   * reached on -- not localhost, which would be the phone talking to itself.
   */
  const host = (await headers()).get("host") ?? "192.168.1.118:8090";
  const sms = await smsOverview();

  const endpoint = (role: (typeof EndpointRole)[keyof typeof EndpointRole], title: string, blurb: string, suggestions: EndpointData["suggestions"]): EndpointData => {
    const record = settings.read(role);
    return {
      role,
      title,
      blurb,
      suggestions,
      current: record
        ? {
            baseUrl: record.baseUrl,
            providerKind: record.providerKind,
            modelName: record.modelName ?? null,
            modelDigest: record.modelDigest ?? null,
            quantization: record.quantization ?? null,
            contextLimit: record.contextLimit ?? null,
            modelLocked: record.modelLocked,
            lastTestOk: record.lastTestOk ?? null,
            lastTestText: record.lastTestAt ? when(record.lastTestAt) : null,
          }
        : null,
      recentTests: settings.recentTests(role, 3).map((test) => ({
        key: `${test.testedAt}-${test.baseUrl}`,
        ok: test.ok,
        detail: test.detail.slice(0, 120),
        latencyMs: test.latencyMs ?? null,
        when: when(test.testedAt),
      })),
    };
  };

  const unlockedAt = unlockedSince();
  const data: SettingsData = {
    pane: (PANES as readonly string[]).includes(asked) ? (asked as Pane) : "capture",
    webhookUrl: `http://${host}/api/v1/sources/sms-webhook`,
    sms: {
      configured: sms.configured,
      enabled: sms.enabled,
      lastDelivery: sms.lastDeliveryAt ? when(sms.lastDeliveryAt) : null,
      stagedMessages: sms.stagedMessages,
      senders: sms.senders.map((sender) => ({
        senderKey: sender.senderKey,
        enabled: sender.enabled,
        seenCount: sender.seenCount,
        lastSeen: sender.lastSeenAt ? new Date(sender.lastSeenAt).toLocaleDateString("en-GB", { timeZone: zone, day: "numeric", month: "short", year: "numeric" }) : null,
      })),
    },
    endpoints: [
      endpoint(
        EndpointRole.EXTRACTION,
        "Extraction model",
        "Reads financial messages into structured data. The sender templates settle almost every message on their own, so this runs only on the few they cannot: choose the model on this phone and capture keeps working with the PC switched off, at about 20 seconds a message.",
        [
          { label: "This phone (always on)", url: "http://192.168.1.118:8081/v1" },
          { label: "Ollama on the PC (faster)", url: "http://192.168.1.84:11434" },
        ],
      ),
      endpoint(
        EndpointRole.AGENT,
        "Assistant model",
        "Answers questions and proposes changes. It never writes to the ledger directly — every change it suggests needs your confirmation first. This one has to call tools, which the small model on this phone cannot do; use a 2B or larger model on the PC.",
        [
          { label: "Ollama on the PC", url: "http://192.168.1.84:11434" },
          { label: "This phone (no tool calling)", url: "http://192.168.1.118:8081/v1" },
        ],
      ),
    ],
    backups: listBackups(SHOWN_BACKUPS).map((file) => ({ name: file.name, size: formatBytes(file.bytes), saved: when(file.modifiedAt) })),
    about: {
      version: packageJson.version,
      schema: currentSchemaVersion(),
      zone,
      currency: currentVault()?.currency ?? "LKR",
      unlockedAt: unlockedAt ? when(unlockedAt) : null,
    },
  };

  return <SettingsView data={data} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
