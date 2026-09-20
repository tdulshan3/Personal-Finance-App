import { createHmac, randomUUID } from "node:crypto";

import { XMLParser } from "fast-xml-parser";

import type { Db } from "../../core/data/driver.ts";
import { asText } from "../../core/data/driver.ts";
import { validationError } from "../../core/domain/errors.ts";

/**
 * Importing message history from an SMS backup file.
 *
 * buildspec.md §5.3: "A practical example is a local XML backup from a tool such as SMS Backup &
 * Restore. Support its actual schema using fixture files and an adapter, and verify the exported
 * dates and message count. Exporting and restoring are different actions: this app imports a file
 * without restoring messages into the phone."
 *
 * This exists because the live collector holds only `RECEIVE_SMS` — it sees new messages and
 * nothing that arrived before it was installed. Without this, a fresh ledger can never know its
 * own history.
 *
 * The file is untrusted input from outside the app, so §20's rule applies in full: "Backup XML has
 * entities or huge nested content | Disable external entities/DTD; bound sizes/depth; reject
 * safely."
 */

export const XML_GENERATION = "xml-import";

/** A hard ceiling before parsing. A 10,000-message export is around 10 MB. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export type ImportedSms = {
  readonly sender: string;
  readonly body: string;
  /** Epoch milliseconds, from the backup's `date` attribute. */
  readonly receivedAt: number;
  readonly sentAt: number | null;
  readonly sim: string | null;
};

export type ImportPreview = {
  readonly totalInFile: number;
  readonly inbox: number;
  readonly skippedNonInbox: number;
  readonly skippedUnusable: number;
  readonly senders: readonly { senderKey: string; count: number; firstAt: number; lastAt: number }[];
  readonly earliest: number | null;
  readonly latest: number | null;
  readonly backupDate: number | null;
};

export type ImportResult = {
  readonly staged: number;
  readonly duplicates: number;
  readonly filtered: number;
  readonly considered: number;
};

/* -------------------------------------------------------------------------------------------- */
/* Parsing                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Rejects the shapes §20 calls out before the parser ever sees them.
 *
 * `fast-xml-parser` does not resolve external entities, but a `<!DOCTYPE>` with an internal subset
 * is still how a billion-laughs expansion is written, and refusing the declaration outright is
 * cheaper and clearer than trusting the parser to shrug it off.
 */
function assertSafeXml(text: string): void {
  const head = text.slice(0, 8192);
  if (/<!DOCTYPE/i.test(head)) {
    throw validationError(
      "This file declares a DOCTYPE. Backups from SMS Backup & Restore do not, and a DOCTYPE is " +
        "how entity-expansion attacks are written, so it is refused rather than parsed.",
    );
  }
  if (/<!ENTITY/i.test(head)) {
    throw validationError("This file declares XML entities, which are not accepted.");
  }
}

function toEpochMs(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Backups write milliseconds; tolerate seconds rather than storing 1970.
  const ms = n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  // Reject anything implausible: before 2000, or more than a day in the future.
  if (ms < 946_684_800_000 || ms > Date.now() + 86_400_000) return null;
  return ms;
}

/**
 * Reads the `<sms>` rows out of an SMS Backup & Restore export.
 *
 * Only inbox messages are taken. buildspec.md §5.4: "Import inbox messages by default; outgoing
 * payment instructions are not proof of payment." `type="1"` is the provider's inbox constant.
 */
export function parseBackupXml(text: string): {
  messages: ImportedSms[];
  totalInFile: number;
  skippedNonInbox: number;
  skippedUnusable: number;
  backupDate: number | null;
} {
  if (text.length === 0) throw validationError("The file is empty");
  assertSafeXml(text);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    // Entity processing off: the file is untrusted and nothing in this format needs it (§20).
    processEntities: false,
    htmlEntities: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => name === "sms",
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(text);
  } catch (error) {
    throw validationError(
      `That file could not be read as XML: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
    );
  }

  const root = (parsed as Record<string, unknown>)?.smses as Record<string, unknown> | undefined;
  if (!root) {
    throw validationError(
      "This does not look like an SMS Backup & Restore export — it has no <smses> element.",
    );
  }

  const rows = Array.isArray(root.sms) ? (root.sms as Record<string, unknown>[]) : [];
  const backupDate = toEpochMs(root["@backup_date"]);

  const messages: ImportedSms[] = [];
  let skippedNonInbox = 0;
  let skippedUnusable = 0;

  for (const row of rows) {
    // type 1 = inbox. 2 = sent, which §5.4 excludes.
    if (String(row["@type"] ?? "") !== "1") {
      skippedNonInbox += 1;
      continue;
    }
    const sender = String(row["@address"] ?? "").trim();
    const body = typeof row["@body"] === "string" ? row["@body"] : String(row["@body"] ?? "");
    const receivedAt = toEpochMs(row["@date"]);

    if (sender.length === 0 || body.length === 0 || receivedAt === null) {
      skippedUnusable += 1;
      continue;
    }
    if (sender.length > 128 || body.length > 20_000) {
      skippedUnusable += 1;
      continue;
    }

    const subId = String(row["@sub_id"] ?? "").trim();
    messages.push({
      sender,
      body,
      receivedAt,
      sentAt: toEpochMs(row["@date_sent"]),
      sim: subId.length > 0 && subId !== "-1" ? subId : null,
    });
  }

  return { messages, totalInFile: rows.length, skippedNonInbox, skippedUnusable, backupDate };
}

/**
 * Summarises a file without storing anything.
 *
 * buildspec.md §5.4: "Preview counts before processing." This is what lets the owner see which
 * senders are in the file, and how far back it reaches, before deciding to import.
 */
export function previewBackup(text: string): ImportPreview {
  const { messages, totalInFile, skippedNonInbox, skippedUnusable, backupDate } =
    parseBackupXml(text);

  const bySender = new Map<string, { count: number; firstAt: number; lastAt: number }>();
  let earliest: number | null = null;
  let latest: number | null = null;

  for (const message of messages) {
    const existing = bySender.get(message.sender);
    if (existing) {
      existing.count += 1;
      existing.firstAt = Math.min(existing.firstAt, message.receivedAt);
      existing.lastAt = Math.max(existing.lastAt, message.receivedAt);
    } else {
      bySender.set(message.sender, {
        count: 1,
        firstAt: message.receivedAt,
        lastAt: message.receivedAt,
      });
    }
    earliest = earliest === null ? message.receivedAt : Math.min(earliest, message.receivedAt);
    latest = latest === null ? message.receivedAt : Math.max(latest, message.receivedAt);
  }

  return {
    totalInFile,
    inbox: messages.length,
    skippedNonInbox,
    skippedUnusable,
    senders: [...bySender.entries()]
      .map(([senderKey, v]) => ({ senderKey, ...v }))
      .sort((a, b) => b.count - a.count),
    earliest,
    latest,
    backupDate,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Staging                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * The *content* fingerprint: sender plus body, and deliberately nothing else.
 *
 * buildspec.md §8 uses this to match the same message across sources, so two identical texts are
 * meant to produce the same value. That is exactly why it cannot also serve as the occurrence id.
 */
function contentFingerprint(secret: string, sender: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`${sender}\u0000${body.normalize("NFKC")}`)
    .digest("hex");
}

/**
 * The *occurrence* id: unique per message, including its arrival time.
 *
 * These were briefly the same value, and a test caught what that costs: §8's "two real payments can
 * produce identical text" then collide on the unique occurrence key, and the second payment is
 * rejected as a duplicate of the first. Content matching and occurrence identity are different
 * questions and need different keys.
 */
function occurrenceKey(secret: string, sender: string, body: string, receivedAt: number): string {
  return createHmac("sha256", secret)
    .update(`${sender}\u0000${body.normalize("NFKC")}\u0000${receivedAt}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Stages the messages whose sender the owner has enabled.
 *
 * Deduplication has to work across sources, because a message can arrive twice: once live through
 * the webhook, and again in a backup taken later. The backup carries no provider row id, so there
 * is no shared key to match on — the check is therefore content plus arrival second.
 *
 * buildspec.md §8 warns that "two real payments can produce identical text", which is why the
 * timestamp is part of the check rather than the body alone. Two genuinely distinct messages would
 * have to share a sender, identical text *and* the same second to be wrongly collapsed. The
 * alternative — importing a duplicate of every message already captured live — is worse and far
 * more likely.
 */
export function importBackup(
  db: Db,
  input: {
    text: string;
    connectionId: string;
    fingerprintSecret: string;
    now: number;
    /** Only these senders are stored. Others are counted and discarded (§18). */
    allowedSenders: ReadonlySet<string>;
  },
): ImportResult {
  const { messages } = parseBackupXml(input.text);

  const findDuplicate = db.prepare(
    `SELECT 1 AS ok FROM source_messages
      WHERE connection_id = ? AND sender = ? AND body_hmac = ?
        AND received_at BETWEEN ? AND ?
      LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO source_messages
       (id, connection_id, provider_generation, external_id, source_kind, sender, received_at,
        source_sent_at, body, body_hmac, metadata_json, processing_status, created_at)
     VALUES (?,?,?,?,'sms_xml_import',?,?,?,?,?,?,'staged',?)`,
  );

  let staged = 0;
  let duplicates = 0;
  let filtered = 0;

  db.transaction(() => {
    for (const message of messages) {
      if (!input.allowedSenders.has(message.sender)) {
        filtered += 1;
        continue;
      }
      const hmac = contentFingerprint(input.fingerprintSecret, message.sender, message.body);
      // Same second, either side, to absorb sub-second differences between sources.
      const found = findDuplicate.get(
        input.connectionId,
        message.sender,
        hmac,
        message.receivedAt - 999,
        message.receivedAt + 999,
      );
      if (found) {
        duplicates += 1;
        continue;
      }
      insert.run(
        `src_${randomUUID().replace(/-/g, "").slice(0, 22)}`,
        input.connectionId,
        XML_GENERATION,
        occurrenceKey(input.fingerprintSecret, message.sender, message.body, message.receivedAt),
        message.sender,
        message.receivedAt,
        message.sentAt,
        message.body,
        hmac,
        JSON.stringify({ sim: message.sim, via: "xml-import" }),
        input.now,
      );
      staged += 1;
    }
  });

  return { staged, duplicates, filtered, considered: messages.length };
}

/** Records the senders a file contains, so the owner can choose from them before importing. */
export function recordSendersFromPreview(
  db: Db,
  connectionId: string,
  preview: ImportPreview,
): number {
  let added = 0;
  const upsert = db.prepare(
    `INSERT INTO source_senders
       (connection_id, sender_key, display_name, enabled, first_seen_at, last_seen_at, seen_count)
     VALUES (?,?,?,0,?,?,?)
     ON CONFLICT(connection_id, sender_key) DO UPDATE SET
       first_seen_at = MIN(COALESCE(source_senders.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
       last_seen_at  = MAX(COALESCE(source_senders.last_seen_at, 0), excluded.last_seen_at)`,
  );
  db.transaction(() => {
    for (const sender of preview.senders) {
      const existed = db
        .prepare("SELECT 1 AS ok FROM source_senders WHERE connection_id = ? AND sender_key = ?")
        .get(connectionId, sender.senderKey);
      upsert.run(
        connectionId,
        sender.senderKey,
        sender.senderKey,
        sender.firstAt,
        sender.lastAt,
        sender.count,
      );
      if (!existed) added += 1;
    }
  });
  return added;
}

export function ensureImportConnection(db: Db, now: number): string {
  const existing = db
    .prepare("SELECT id FROM source_connections WHERE kind = ? AND device_id = ?")
    .get("sms_file", "backup-xml") as Record<string, unknown> | undefined;
  if (existing) return asText(existing.id, "id");

  const id = `conn_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
  db.prepare(
    `INSERT INTO source_connections
       (id, kind, label, device_id, provider_generation, enabled, consent_at, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?,?)`,
  ).run(id, "sms_file", "Message backup file", "backup-xml", XML_GENERATION, now, now, now);
  return id;
}
