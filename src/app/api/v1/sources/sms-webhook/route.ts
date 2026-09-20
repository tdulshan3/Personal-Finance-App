import { isFinanceError } from "../../../../../core/domain/errors.ts";
import {
  noteWebhookDelivery,
  parseWebhookPayload,
  readWebhookConfig,
  stageWebhookMessage,
  verifySignature,
} from "../../../../../ingestion/sms/webhook.ts";
import { isUnlocked, requireDb } from "../../../../../server/runtime.ts";

export const dynamic = "force-dynamic";

/**
 * Where the other phone posts its SMS.
 *
 * buildspec.md §16's `SourceService.stageBatch`: "Trusted collector stages occurrences; returns
 * per-item status." The collector is the `android_income_sms_gateway_webhook` app on the owner's
 * personal phone; this endpoint is the only thing on the server that accepts messages from it.
 *
 * Everything it writes is a **staged source message**. buildspec.md §1.5 — "A message is evidence,
 * not a transaction" — so nothing here touches the ledger; extraction and review come later and
 * separately.
 */

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  /*
   * Locked means there is no database key, so there is nowhere to put the message.
   *
   * 503 is deliberate, not 401: the collector retries a 5xx with exponential backoff, up to ten
   * times, so a short lock resolves itself once the owner unlocks. A *long* lock outlives the
   * retries and those messages never arrive this way — which is exactly what the XML history import
   * is for, and why the setup guide says to run one after any long outage.
   */
  if (!isUnlocked()) {
    return Response.json(
      { accepted: 0, reason: "locked", detail: "The ledger is locked; unlock it to accept messages." },
      { status: 503, headers: { "retry-after": "300" } },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ accepted: 0, reason: "too_large" }, { status: 413 });
  }

  const db = requireDb();
  const config = readWebhookConfig(db);
  if (!config || !config.enabled) {
    return Response.json({ accepted: 0, reason: "not_configured" }, { status: 404 });
  }

  /*
   * Signature first, before the body is parsed or trusted in any way. An unsigned request is not a
   * malformed message, it is a stranger, and it should learn nothing about what this endpoint
   * expects (buildspec.md §4: raw sources are untrusted input).
   */
  if (!verifySignature(raw, request.headers.get("x-signature"), config.secret)) {
    return Response.json({ accepted: 0, reason: "bad_signature" }, { status: 401 });
  }

  let payload;
  try {
    payload = parseWebhookPayload(JSON.parse(raw));
  } catch (error) {
    return Response.json(
      { accepted: 0, reason: "invalid", detail: isFinanceError(error) ? error.message : "Malformed body" },
      { status: 400 },
    );
  }

  try {
    const result = stageWebhookMessage(requireDb(), config, payload, Date.now());
    noteWebhookDelivery(requireDb(), payload.from, Date.now());
    return Response.json({ accepted: 1, staged: result.staged, reason: result.reason }, { status: 200 });
  } catch (error) {
    // A 5xx tells the collector to retry; the message is still on its phone either way.
    return Response.json(
      {
        accepted: 0,
        reason: "error",
        detail: error instanceof Error ? error.message.slice(0, 160) : "failed",
      },
      { status: 500 },
    );
  }
}

/** A GET is how the owner checks the URL is right before pasting it into the collector. */
export async function GET(): Promise<Response> {
  if (!isUnlocked()) {
    return Response.json({ ok: false, reason: "locked" }, { status: 503 });
  }
  const config = readWebhookConfig(requireDb());
  return Response.json({
    ok: Boolean(config?.enabled),
    configured: Boolean(config),
    // Never the secret itself.
    lastDeliveryAt: config?.lastDeliveryAt ?? null,
    expects: "POST JSON {from, text, sentStamp, receivedStamp, sim} with an X-Signature HMAC-SHA256 header",
  });
}
