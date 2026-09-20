import { createHmac, randomUUID } from "node:crypto";

import type { Db } from "../../core/data/driver.ts";
import { asBoolean, asNumber, asOptionalNumber, asOptionalText, asText } from "../../core/data/driver.ts";
import { validationError } from "../../core/domain/errors.ts";
import type { Clock } from "../../core/domain/time.ts";
import type { RawSms, SmsCollector } from "./termux-collector.ts";

/**
 * Staging SMS into the ledger's source store.
 *
 * ADR 0004 replaces §5.5's broadcast receiver with polling, so the gap-filling logic §5.4 describes
 * has to do all the work:
 *
 *   "Before history import begins, save a cutoff timestamp and enable ongoing capture... After
 *    import, scan an overlap around the cutoff and process both streams idempotently. A scan
 *    watermark records what was durably staged, not what the model has finished."
 *
 * The property that makes this safe is that **Android keeps the messages**. Being offline, locked
 * or killed loses nothing: the next scan walks back from the newest message until it passes the
 * watermark, so a gap of an hour and a gap of a month are the same operation. Nothing needs the app
 * to have been running.
 */

export const SMS_CONNECTION_KIND = "sms_termux";

/**
 * How far back past the watermark each scan reaches.
 *
 * Two messages can share a timestamp, and a scan can be interrupted between staging and advancing
 * the watermark. Re-reading a window that is already staged costs nothing — the unique occurrence
 * key rejects the duplicates — while missing one loses a transaction permanently.
 */
const OVERLAP_MS = 10 * 60 * 1000;

const PAGE_SIZE = 100;
/** A hard ceiling so one scan cannot walk the entire history and block the event loop. */
const MAX_PAGES_PER_SCAN = 200;

export type SyncTrigger = "unlock" | "interval" | "manual" | "history_import";

export type SyncReport = {
  readonly runId: string;
  readonly trigger: SyncTrigger;
  readonly scanned: number;
  readonly staged: number;
  /** Already present from an earlier scan. Expected, not an error. */
  readonly duplicates: number;
  /** Skipped because the sender is not one the owner enabled. */
  readonly filtered: number;
  readonly newSenders: number;
  readonly watermarkBefore: number | null;
  readonly watermarkAfter: number | null;
  readonly gapMs: number | null;
  readonly reachedEnd: boolean;
};

export type SenderSummary = {
  readonly senderKey: string;
  readonly enabled: boolean;
  readonly seenCount: number;
  readonly firstSeenAt: number | null;
  readonly lastSeenAt: number | null;
};

type Cursor = {
  /** The newest `received` value durably staged. Null before the first scan. */
  readonly watermark: number | null;
  readonly lastScanAt: number | null;
};

function readCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      watermark: typeof parsed.watermark === "number" ? parsed.watermark : null,
      lastScanAt: typeof parsed.lastScanAt === "number" ? parsed.lastScanAt : null,
    };
  } catch {
    return { watermark: null, lastScanAt: null };
  }
}

export function createSmsSyncService(deps: {
  db: Db;
  collector: SmsCollector;
  clock: Clock;
  /** buildspec.md §8: an installation secret, so fingerprints are not guessable across devices. */
  fingerprintSecret: Buffer;
}) {
  const { db, collector, clock, fingerprintSecret } = deps;

  const fingerprint = (sender: string, body: string): string =>
    createHmac("sha256", fingerprintSecret)
      .update(`${sender}\u0000${body.normalize("NFKC")}`)
      .digest("hex");

  const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

  /** Creates the SMS connection row on first use. One per device generation. */
  function ensureConnection(deviceId = "local"): string {
    const existing = db
      .prepare("SELECT id FROM source_connections WHERE kind = ? AND device_id = ?")
      .get(SMS_CONNECTION_KIND, deviceId) as Record<string, unknown> | undefined;
    if (existing) return asText(existing.id, "id");

    const id = newId("conn");
    const now = clock.now();
    db.prepare(
      `INSERT INTO source_connections
         (id, kind, label, device_id, provider_generation, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,0,?,?)`,
    ).run(id, SMS_CONNECTION_KIND, "Phone SMS", deviceId, "g1", now, now);
    return id;
  }

  function connection(connectionId: string) {
    const row = db.prepare("SELECT * FROM source_connections WHERE id = ?").get(connectionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw validationError(`Unknown source connection '${connectionId}'`);
    return {
      id: asText(row.id, "id"),
      generation: asText(row.provider_generation, "provider_generation"),
      enabled: asBoolean(row.enabled, "enabled"),
      cursor: readCursor(asText(row.cursor_json, "cursor_json")),
    };
  }

  function enabledSenders(connectionId: string): Set<string> {
    const rows = db
      .prepare("SELECT sender_key FROM source_senders WHERE connection_id = ? AND enabled = 1")
      .all(connectionId) as Record<string, unknown>[];
    return new Set(rows.map((row) => asText(row.sender_key, "sender_key")));
  }

  /**
   * Records that a sender exists, without storing any message body.
   *
   * buildspec.md §5.4: "Preview counts before processing", and §18's data minimisation. This is how
   * the owner chooses which senders are financial — they see names and counts, never content, until
   * they enable one.
   */
  function noteSender(connectionId: string, sender: string, receivedAt: number): boolean {
    const existing = db
      .prepare("SELECT seen_count FROM source_senders WHERE connection_id = ? AND sender_key = ?")
      .get(connectionId, sender) as Record<string, unknown> | undefined;

    if (existing) {
      db.prepare(
        `UPDATE source_senders
            SET seen_count = seen_count + 1,
                last_seen_at = MAX(COALESCE(last_seen_at, 0), ?),
                first_seen_at = MIN(COALESCE(first_seen_at, ?), ?)
          WHERE connection_id = ? AND sender_key = ?`,
      ).run(receivedAt, receivedAt, receivedAt, connectionId, sender);
      return false;
    }

    db.prepare(
      `INSERT INTO source_senders
         (connection_id, sender_key, display_name, enabled, first_seen_at, last_seen_at, seen_count)
       VALUES (?,?,?,0,?,?,1)`,
    ).run(connectionId, sender, sender, receivedAt, receivedAt);
    return true;
  }

  function listSenders(connectionId: string): SenderSummary[] {
    return (
      db
        .prepare(
          `SELECT sender_key, enabled, seen_count, first_seen_at, last_seen_at
             FROM source_senders WHERE connection_id = ?
            ORDER BY seen_count DESC, sender_key`,
        )
        .all(connectionId) as Record<string, unknown>[]
    ).map((row) => ({
      senderKey: asText(row.sender_key, "sender_key"),
      enabled: asBoolean(row.enabled, "enabled"),
      seenCount: asNumber(row.seen_count, "seen_count"),
      firstSeenAt: asOptionalNumber(row.first_seen_at, "first_seen_at") ?? null,
      lastSeenAt: asOptionalNumber(row.last_seen_at, "last_seen_at") ?? null,
    }));
  }

  /**
   * Turns a sender on or off, and resets the watermark when one is turned on.
   *
   * The reset matters. The watermark means "everything at or after this point is staged **for the
   * senders enabled at the time**". Enabling a new sender makes that false for all of its history,
   * so without the reset the owner would tick their bank and silently capture only messages from
   * that moment onward — every earlier statement lost, with nothing to indicate it. Rescanning is
   * cheap and safe: the unique occurrence key turns the re-read into duplicates.
   */
  function setSenderEnabled(connectionId: string, senderKey: string, enabled: boolean): void {
    const changed = db
      .prepare(
        "UPDATE source_senders SET enabled = ? WHERE connection_id = ? AND sender_key = ?",
      )
      .run(enabled ? 1 : 0, connectionId, senderKey);
    if (Number(changed.changes) === 0) {
      throw validationError(`Sender '${senderKey}' has not been seen on this connection yet`);
    }

    const now = clock.now();
    if (enabled) {
      db.prepare(
        `UPDATE source_connections
            SET enabled = 1, cursor_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(JSON.stringify({ watermark: null, lastScanAt: null }), now, connectionId);
    } else {
      db.prepare("UPDATE source_connections SET updated_at = ? WHERE id = ?").run(now, connectionId);
    }
  }

  /**
   * Stages one message, or reports that it was already there.
   *
   * buildspec.md §8: the occurrence identity is device + provider generation + row id. §20 adds
   * "Same source imported while a worker is already processing it | One durable source record and
   * one active job/effect", which the unique index provides directly.
   */
  function stage(
    connectionId: string,
    generation: string,
    message: RawSms,
  ): "staged" | "duplicate" {
    const externalId = String(message.providerId);
    const existing = db
      .prepare(
        `SELECT id FROM source_messages
          WHERE connection_id = ? AND provider_generation = ? AND external_id = ?`,
      )
      .get(connectionId, generation, externalId);
    if (existing) return "duplicate";

    const now = clock.now();
    db.prepare(
      `INSERT INTO source_messages
         (id, connection_id, provider_generation, external_id, source_kind, sender, received_at,
          body, body_hmac, metadata_json, processing_status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'staged',?)`,
    ).run(
      newId("src"),
      connectionId,
      generation,
      externalId,
      SMS_CONNECTION_KIND,
      message.address,
      message.received,
      message.body,
      fingerprint(message.address, message.body),
      JSON.stringify({ threadId: message.threadId, type: message.type }),
      now,
    );
    return "staged";
  }

  /**
   * Walks backwards from the newest message until the watermark is passed, staging as it goes.
   *
   * The gap fills itself: whether the app was down for a minute or a month, the scan stops at the
   * same place — the last message it already has, minus the overlap.
   */
  async function scan(options: { trigger: SyncTrigger; connectionId?: string } = { trigger: "manual" }) {
    const connectionId = options.connectionId ?? ensureConnection();
    const conn = connection(connectionId);
    const runId = newId("run");
    const startedAt = clock.now();
    const stopAt = conn.cursor.watermark === null ? null : conn.cursor.watermark - OVERLAP_MS;

    db.prepare(
      `INSERT INTO import_runs (id, connection_id, trigger, status, started_at)
       VALUES (?,?,?,'running',?)`,
    ).run(runId, connectionId, options.trigger, startedAt);

    const allowed = enabledSenders(connectionId);
    let scanned = 0;
    let staged = 0;
    let duplicates = 0;
    let filtered = 0;
    let newSenders = 0;
    let newestSeen: number | null = null;
    let reachedEnd = false;

    try {
      for (let page = 0; page < MAX_PAGES_PER_SCAN; page += 1) {
        const rows = await collector.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
        if (rows.length === 0) {
          reachedEnd = true;
          break;
        }

        let crossedWatermark = false;

        // One transaction per page: a crash mid-scan leaves whole pages staged, never half a row.
        db.transaction(() => {
          for (const message of rows) {
            scanned += 1;
            if (newestSeen === null || message.received > newestSeen) newestSeen = message.received;

            if (stopAt !== null && message.received < stopAt) {
              crossedWatermark = true;
              continue;
            }
            if (noteSender(connectionId, message.address, message.received)) newSenders += 1;

            // Bodies are stored only for senders the owner marked financial (§18, §5.4).
            if (!allowed.has(message.address)) {
              filtered += 1;
              continue;
            }
            if (stage(connectionId, conn.generation, message) === "staged") staged += 1;
            else duplicates += 1;
          }
        });

        if (crossedWatermark) break;
        if (rows.length < PAGE_SIZE) {
          reachedEnd = true;
          break;
        }
      }

      /*
       * The watermark advances only after the rows are committed. §5.4: "A scan watermark records
       * what was durably staged, not what the model has finished." Extraction happens later and
       * cannot move it.
       */
      /*
       * A scan with no enabled senders is pure discovery: it reads names and counts and stores no
       * bodies. Letting it move the watermark would mark history as "covered" that was never
       * staged, so discovery leaves the watermark exactly where it was.
       */
      const watermarkAfter =
        allowed.size === 0 || newestSeen === null
          ? conn.cursor.watermark
          : Math.max(newestSeen, conn.cursor.watermark ?? 0);

      db.prepare(
        `UPDATE source_connections
            SET cursor_json = ?, last_success_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(
        JSON.stringify({ watermark: watermarkAfter, lastScanAt: clock.now() }),
        clock.now(),
        clock.now(),
        connectionId,
      );

      db.prepare(
        `UPDATE import_runs
            SET status = 'complete', scanned_count = ?, staged_count = ?, skipped_count = ?,
                coverage_json = ?, finished_at = ?
          WHERE id = ?`,
      ).run(
        scanned,
        staged,
        filtered + duplicates,
        JSON.stringify({ reachedEnd, watermarkBefore: conn.cursor.watermark, watermarkAfter }),
        clock.now(),
        runId,
      );

      return Object.freeze({
        runId,
        trigger: options.trigger,
        scanned,
        staged,
        duplicates,
        filtered,
        newSenders,
        watermarkBefore: conn.cursor.watermark,
        watermarkAfter,
        gapMs:
          conn.cursor.lastScanAt === null ? null : Math.max(0, startedAt - conn.cursor.lastScanAt),
        reachedEnd,
      }) satisfies SyncReport;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      db.prepare(
        `UPDATE import_runs SET status='failed', error=?, scanned_count=?, staged_count=?, finished_at=?
          WHERE id = ?`,
      ).run(detail.slice(0, 500), scanned, staged, clock.now(), runId);
      db.prepare("UPDATE source_connections SET last_error = ?, updated_at = ? WHERE id = ?").run(
        detail.slice(0, 500),
        clock.now(),
        connectionId,
      );
      throw error;
    }
  }

  /** What the Home screen needs to say honestly how complete the record is (§13, §23). */
  function coverage(connectionId?: string) {
    const id = connectionId ?? ensureConnection();
    const conn = connection(id);
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS staged,
                SUM(CASE WHEN processing_status = 'staged' THEN 1 ELSE 0 END) AS pending
           FROM source_messages WHERE connection_id = ?`,
      )
      .get(id) as Record<string, unknown>;
    const lastRun = db
      .prepare(
        "SELECT status, started_at, finished_at, error FROM import_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(id) as Record<string, unknown> | undefined;

    return {
      connectionId: id,
      enabled: conn.enabled,
      watermark: conn.cursor.watermark,
      lastScanAt: conn.cursor.lastScanAt,
      stagedMessages: asNumber(counts.staged, "staged"),
      pendingMessages: asNumber(counts.pending ?? 0, "pending"),
      enabledSenderCount: enabledSenders(id).size,
      lastRunStatus: lastRun ? asText(lastRun.status, "status") : null,
      lastRunError: lastRun ? asOptionalText(lastRun.error, "error") ?? null : null,
    };
  }

  return {
    ensureConnection,
    listSenders,
    setSenderEnabled,
    scan,
    coverage,
    checkCapability: () => collector.checkCapability(),
  };
}

export type SmsSyncService = ReturnType<typeof createSmsSyncService>;
