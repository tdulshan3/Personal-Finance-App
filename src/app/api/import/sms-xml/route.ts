import { randomBytes } from "node:crypto";

import { asBoolean, asText } from "../../../../core/data/driver.ts";
import type { Db } from "../../../../core/data/driver.ts";
import { isFinanceError } from "../../../../core/domain/errors.ts";
import { WEBHOOK_CONNECTION_DEVICE, looksFinancial } from "../../../../ingestion/sms/webhook.ts";
import {
  MAX_IMPORT_BYTES,
  ensureImportConnection,
  importBackup,
  parseBackupXml,
  previewBackup,
  recordSendersFromPreview,
} from "../../../../ingestion/sms/xml-import.ts";
import { kickProcessing } from "../../../../server/background.ts";
import { requireDb } from "../../../../server/runtime.ts";
import { accessState } from "../../../../server/session.ts";

export const dynamic = "force-dynamic";

/**
 * Message history from an SMS Backup & Restore file (buildspec.md §5.3).
 *
 * The live collector holds only `RECEIVE_SMS`, so it never sees anything that arrived before it was
 * installed; this is the other way in. Two steps, both with the file as the raw request body:
 *
 *   `?step=preview`  parses it and stores nothing — counts, the date range, and each sender with how
 *                    many of its messages the deterministic rules read as money moving;
 *   `?step=import`   stages the messages of the senders the owner ticked (`sender=…`, repeated, or
 *                    `senders=a,b`), then wakes the processor. Nothing becomes a transaction until
 *                    it is accepted on Review, and OTPs and promotions are discarded by the rules.
 *
 * Like the backup download, this is behind the unlocked vault *and* this browser's session cookie
 * (`SameSite=Strict`, so another site cannot post a file on the owner's behalf). The file is
 * untrusted: its size is capped before it is read in full, and the parser refuses DTDs (§20).
 */

const NO_STORE = { "cache-control": "no-store" } as const;
const FINGERPRINT_KEY = "ingestion.fingerprint_secret";

export async function POST(request: Request): Promise<Response> {
  const access = await accessState();
  if (access.kind !== "ready") {
    return Response.json({ error: "unauthorized", detail: "Unlock the app in this browser first." }, { status: 401, headers: NO_STORE });
  }

  const url = new URL(request.url);
  const step = url.searchParams.get("step");
  if (step !== "preview" && step !== "import") {
    return Response.json({ error: "bad_step", detail: "Use step=preview or step=import." }, { status: 400, headers: NO_STORE });
  }

  const text = await readCapped(request);
  if (text === null) {
    return Response.json({ error: "too_large", detail: `The file is over ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.` }, { status: 413, headers: NO_STORE });
  }

  const db = requireDb();
  try {
    if (step === "preview") {
      const preview = previewBackup(text);
      const live = liveSenders(db);
      const financial = new Map<string, number>();
      for (const message of parseBackupXml(text).messages) {
        if (looksFinancial(message.body)) financial.set(message.sender, (financial.get(message.sender) ?? 0) + 1);
      }
      return Response.json(
        {
          ...preview,
          senders: preview.senders
            .map((sender) => ({
              ...sender,
              financial: financial.get(sender.senderKey) ?? 0,
              known: live.has(sender.senderKey),
              enabled: live.get(sender.senderKey) ?? false,
            }))
            .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.financial - a.financial || b.count - a.count),
        },
        { headers: NO_STORE },
      );
    }

    const chosen = new Set([
      ...url.searchParams.getAll("sender"),
      ...(url.searchParams.get("senders") ?? "").split(","),
    ].map((sender) => sender.trim()).filter(Boolean));
    if (chosen.size === 0) {
      return Response.json({ error: "no_senders", detail: "Choose at least one sender to import." }, { status: 400, headers: NO_STORE });
    }

    const now = Date.now();
    const connectionId = ensureImportConnection(db, now);
    const preview = previewBackup(text);
    recordSendersFromPreview(db, connectionId, preview);
    // Ticking a sender here is the owner's consent to keep its messages (§5.4), recorded as such.
    const enable = db.prepare("UPDATE source_senders SET enabled = 1 WHERE connection_id = ? AND sender_key = ?");
    for (const sender of chosen) enable.run(connectionId, sender);

    const result = importBackup(db, { text, connectionId, fingerprintSecret: fingerprintSecret(db, now), now, allowedSenders: chosen });
    if (result.staged > 0) kickProcessing();
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    // A FinanceError's message is written for the owner; anything else may quote the file.
    const detail = isFinanceError(error) ? error.message : "The file could not be read as an SMS backup.";
    return Response.json({ error: "unreadable", detail }, { status: 422, headers: NO_STORE });
  }
}

/** Reads the body as text, giving up (null) as soon as it passes the import limit. */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_IMPORT_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMPORT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/** Senders the live collector already knows, and whether the owner keeps their messages. */
function liveSenders(db: Db): Map<string, boolean> {
  const connection = db.prepare("SELECT id FROM source_connections WHERE device_id = ?").get(WEBHOOK_CONNECTION_DEVICE) as Record<string, unknown> | undefined;
  if (!connection) return new Map();
  return new Map(
    (db.prepare("SELECT sender_key, enabled FROM source_senders WHERE connection_id = ?").all(asText(connection.id, "id")) as Record<string, unknown>[]).map((row) => [
      asText(row.sender_key, "sender_key"),
      asBoolean(row.enabled, "enabled"),
    ]),
  );
}

/**
 * buildspec.md §8: content fingerprints use an installation secret, so they cannot be computed — or
 * compared across devices — by anyone without it. Made once, kept inside the encrypted database.
 */
function fingerprintSecret(db: Db, now: number): string {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(FINGERPRINT_KEY) as Record<string, unknown> | undefined;
  if (row) {
    const stored = JSON.parse(asText(row.value_json, "value_json")) as unknown;
    if (typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored)) return stored;
  }
  const secret = randomBytes(32).toString("hex");
  db.prepare(
    `INSERT INTO settings (key, value_json, revision, updated_at) VALUES (?,?,1,?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, revision = settings.revision + 1, updated_at = excluded.updated_at`,
  ).run(FINGERPRINT_KEY, JSON.stringify(secret), now);
  return secret;
}
