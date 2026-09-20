"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { asBoolean, asNumber, asText } from "../../core/data/driver.ts";
import { isFinanceError } from "../../core/domain/errors.ts";
import {
  generateWebhookSecret,
  isWeakSecret,
  readWebhookConfig,
  setWebhookEnabled,
  setWebhookSecret,
  WEBHOOK_CONNECTION_DEVICE,
} from "../../ingestion/sms/webhook.ts";
import { requireDb } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

/**
 * SMS capture settings.
 *
 * buildspec.md §14.2: endpoints, source access and credentials are "Never through agent |
 * Owner-only settings flow." These actions sit behind the authenticated session and no agent tool
 * maps onto them.
 */

export type SmsSettingsState = {
  readonly error?: string | undefined;
  readonly ok?: string | undefined;
  /**
   * Returned exactly once, right after it is generated, and never read back afterwards. The owner
   * copies it into the collector app; if they lose it, the answer is to rotate, not to recover it.
   */
  readonly secret?: string | undefined;
};

async function db() {
  const access = await accessState();
  if (access.kind !== "ready") {
    redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  }
  return requireDb();
}

function describe(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export async function generateSecretAction(
  _prev: SmsSettingsState,
  _formData: FormData,
): Promise<SmsSettingsState> {
  try {
    const config = generateWebhookSecret(await db(), Date.now());
    revalidatePath("/settings");
    return {
      ok: "New secret generated. Copy it into the collector app now — it is not shown again.",
      secret: config.secret,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

/** Adopts a secret the collector app already generated, instead of minting a new one. */
export async function useOwnSecretAction(
  _prev: SmsSettingsState,
  formData: FormData,
): Promise<SmsSettingsState> {
  try {
    const supplied = String(formData.get("secret") ?? "");
    setWebhookSecret(await db(), supplied, Date.now());
    revalidatePath("/settings");
    return {
      ok: isWeakSecret(supplied)
        ? "Saved, but it is short. Under about 128 bits the signature stops being worth much — " +
          "consider generating one here instead."
        : "Saved. The collector must sign with exactly this value.",
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function toggleWebhookAction(
  _prev: SmsSettingsState,
  formData: FormData,
): Promise<SmsSettingsState> {
  try {
    const enabled = String(formData.get("enabled") ?? "") === "true";
    setWebhookEnabled(await db(), enabled, Date.now());
    revalidatePath("/settings");
    return { ok: enabled ? "Capture enabled." : "Capture paused. Deliveries will be refused." };
  } catch (error) {
    return { error: describe(error) };
  }
}

/**
 * Marks a sender financial, or stops it being one.
 *
 * buildspec.md §5.4: this is the consent step. Before a sender is enabled the app stores its name
 * and how often it writes, and nothing else — turning it on is what allows message bodies to be
 * kept at all.
 */
export async function toggleSenderAction(formData: FormData): Promise<void> {
  const handle = await db();
  const senderKey = String(formData.get("senderKey") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "true";

  const connection = handle
    .prepare("SELECT id FROM source_connections WHERE device_id = ?")
    .get(WEBHOOK_CONNECTION_DEVICE) as Record<string, unknown> | undefined;
  if (!connection) return;

  handle
    // Stop is remembered as the owner's decision, so a later financial message cannot undo it.
    .prepare("UPDATE source_senders SET enabled = ?, owner_blocked = ? WHERE connection_id = ? AND sender_key = ?")
    .run(enabled ? 1 : 0, enabled ? 0 : 1, asText(connection.id, "id"), senderKey);

  revalidatePath("/settings");
}

export type SmsOverview = {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly lastDeliveryAt: number | null;
  readonly lastSender: string | null;
  readonly senders: readonly {
    senderKey: string;
    enabled: boolean;
    seenCount: number;
    lastSeenAt: number | null;
  }[];
  readonly stagedMessages: number;
};

/** Everything the settings screen shows about SMS capture. Never includes the secret. */
export async function smsOverview(): Promise<SmsOverview> {
  const handle = await db();
  const config = readWebhookConfig(handle);

  const connection = handle
    .prepare("SELECT id FROM source_connections WHERE device_id = ?")
    .get(WEBHOOK_CONNECTION_DEVICE) as Record<string, unknown> | undefined;

  const senders = connection
    ? (
        handle
          .prepare(
            `SELECT sender_key, enabled, seen_count, last_seen_at
               FROM source_senders WHERE connection_id = ?
              ORDER BY enabled DESC, seen_count DESC, sender_key`,
          )
          .all(asText(connection.id, "id")) as Record<string, unknown>[]
      ).map((row) => ({
        senderKey: asText(row.sender_key, "sender_key"),
        enabled: asBoolean(row.enabled, "enabled"),
        seenCount: asNumber(row.seen_count, "seen_count"),
        lastSeenAt: row.last_seen_at === null ? null : asNumber(row.last_seen_at, "last_seen_at"),
      }))
    : [];

  const staged = connection
    ? (handle
        .prepare("SELECT COUNT(*) AS n FROM source_messages WHERE connection_id = ?")
        .get(asText(connection.id, "id")) as Record<string, unknown>)
    : { n: 0 };

  return {
    configured: Boolean(config),
    enabled: Boolean(config?.enabled),
    lastDeliveryAt: config?.lastDeliveryAt ?? null,
    lastSender: config?.lastSender ?? null,
    senders,
    stagedMessages: Number(staged.n ?? 0),
  };
}
