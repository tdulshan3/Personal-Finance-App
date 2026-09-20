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

  return Response.json(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      // termox is same-origin-less; it fetches server-side, so no CORS is granted here.
      "x-robots-tag": "noindex",
    },
  });
}
