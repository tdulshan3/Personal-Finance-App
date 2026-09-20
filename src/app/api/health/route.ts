import { currentSchemaVersion } from "../../../core/data/migrations.ts";
import { createSmsSyncService } from "../../../ingestion/sms/sync-service.ts";
import { createTermuxSmsCollector } from "../../../ingestion/sms/termux-collector.ts";
import { isInitialised, isUnlocked, requireDb, unlockedSince } from "../../../server/runtime.ts";
import { systemClock } from "../../../core/domain/time.ts";

export const dynamic = "force-dynamic";

/**
 * Operational health, for the termox dashboard on this phone.
 *
 * **This endpoint returns no financial data.** termox binds `0.0.0.0` with no authentication of its
 * own, so anything here is visible to the whole LAN. It therefore reports only facts about the
 * *service*: whether it is locked, whether capture is configured, how many messages are waiting,
 * and when it last scanned. No amounts, no balances, no merchant names, no sender names, and no
 * message content — buildspec.md §18's data minimisation applied to monitoring.
 *
 * It is deliberately reachable while locked. "Locked" is the single most useful thing for a
 * dashboard to show, because it is the state in which capture is paused (ADR 0003) and the owner
 * needs to do something about it.
 */

const STARTED_AT = Date.now();

type SmsHealth = {
  configured: boolean;
  enabledSenders: number;
  stagedMessages: number;
  pendingMessages: number;
  lastScanAt: string | null;
  capability: string | null;
};

export async function GET(): Promise<Response> {
  const locked = !isUnlocked();
  const status = !isInitialised() ? "needs-setup" : locked ? "locked" : "ready";

  const body: Record<string, unknown> = {
    service: "personal-finance",
    status,
    // A dashboard needs to know the ledger is sealed, not what is in it.
    locked,
    schemaVersion: currentSchemaVersion(),
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    unlockedSince: unlockedSince() ? new Date(unlockedSince()!).toISOString() : null,
  };

  if (!locked && isInitialised()) {
    try {
      const sync = createSmsSyncService({
        db: requireDb(),
        collector: createTermuxSmsCollector(),
        clock: systemClock(() => "UTC"),
        // Only counts are read here, so the fingerprint secret is never needed.
        fingerprintSecret: Buffer.alloc(32),
      });
      const coverage = sync.coverage();
      const sms: SmsHealth = {
        configured: coverage.enabled,
        enabledSenders: coverage.enabledSenderCount,
        stagedMessages: coverage.stagedMessages,
        pendingMessages: coverage.pendingMessages,
        lastScanAt: coverage.lastScanAt ? new Date(coverage.lastScanAt).toISOString() : null,
        capability: coverage.lastRunError ? "error" : coverage.enabled ? "ok" : "not_configured",
      };
      body.sms = sms;
    } catch (error) {
      // A health check must never fail the way the thing it is checking failed.
      body.sms = { error: error instanceof Error ? error.message.slice(0, 120) : "unavailable" };
    }
  }

  if (!locked && isInitialised()) {
    /*
     * The capture pipeline, as counts. This is what answers "why did nothing arrive?" without
     * anyone reading a message: did deliveries come in, were their senders on, did the rules or the
     * model get through them, is anything waiting. Still no amounts, sender names or text.
     */
    try {
      const db = requireDb();
      const one = (sql: string) => Number((db.prepare(sql).get() as Record<string, unknown> | undefined)?.n ?? 0);
      const byStatus: Record<string, number> = {};
      for (const row of db.prepare("SELECT processing_status AS s, COUNT(*) AS n FROM source_messages GROUP BY processing_status").all() as Record<string, unknown>[]) {
        byStatus[String(row.s)] = Number(row.n);
      }
      const webhook = db.prepare("SELECT value_json FROM settings WHERE key LIKE '%webhook%' LIMIT 1").get() as Record<string, unknown> | undefined;
      let lastDeliveryAt: string | null = null;
      let enabled: boolean | null = null;
      if (webhook) {
        const parsed = JSON.parse(String(webhook.value_json)) as { lastDeliveryAt?: number; enabled?: boolean };
        lastDeliveryAt = parsed.lastDeliveryAt ? new Date(parsed.lastDeliveryAt).toISOString() : null;
        enabled = parsed.enabled ?? null;
      }
      const model = db.prepare("SELECT model_name, last_test_ok FROM ai_endpoints WHERE role = 'extraction'").get() as Record<string, unknown> | undefined;
      body.pipeline = {
        webhookConfigured: webhook !== undefined,
        webhookEnabled: enabled,
        lastDeliveryAt,
        sendersSeen: one("SELECT COUNT(*) AS n FROM source_senders"),
        sendersOn: one("SELECT COUNT(*) AS n FROM source_senders WHERE enabled = 1"),
        sendersStoppedByOwner: one("SELECT COUNT(*) AS n FROM source_senders WHERE owner_blocked = 1"),
        deliveriesSeen: one("SELECT COALESCE(SUM(seen_count), 0) AS n FROM source_senders"),
        messagesKept: one("SELECT COUNT(*) AS n FROM source_messages"),
        messagesByStatus: byStatus,
        waitingForReview: one("SELECT COUNT(*) AS n FROM source_events WHERE status = 'needs_review'"),
        extractionModelSet: Boolean(model && model.model_name !== null),
        extractionModelLastTestOk: model ? (model.last_test_ok === null ? null : Number(model.last_test_ok) === 1) : null,
      };
    } catch (error) {
      body.pipeline = { error: error instanceof Error ? error.message.slice(0, 120) : "unavailable" };
    }
  }

  return Response.json(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      // termox is same-origin-less; it fetches server-side, so no CORS is granted here.
      "x-robots-tag": "noindex",
    },
  });
}
