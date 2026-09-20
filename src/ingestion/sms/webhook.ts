import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Db } from "../../core/data/driver.ts";
import { asText } from "../../core/data/driver.ts";
import { FinanceError, FinanceErrorCode, validationError } from "../../core/domain/errors.ts";

/**
 * Receiving SMS from a *different* phone.
 *
 * The ledger runs on the S20; the bank messages arrive on the owner's personal phone. buildspec.md
 * §16 already names this shape — `SourceService.stageBatch` → `POST /v1/sources/batches`, "Trusted
 * collector stages occurrences; returns per-item status" — so the collector is an app on the other
 * phone and this is the endpoint it posts to.
 *
 * The collector is the open-source `android_income_sms_gateway_webhook`, chosen over writing an APK
 * because it already does the parts that are easy to get wrong: HMAC-SHA256 request signing, sender
 * filtering, and retry with exponential backoff. Its payload is fixed, so this parser matches it
 * rather than the other way round:
 *
 *     { "from": "BankName", "text": "...", "sentStamp": 1758..., "receivedStamp": 1758..., "sim": "" }
 *
 * buildspec.md §4 still applies in full: this is untrusted input arriving over the network. A
 * sender name can be spoofed, and nothing posted here can grant permissions, change endpoints or
 * bypass review. Everything it produces is a *staged source message*, never a ledger entry.
 */

export const WEBHOOK_SETTING_KEY = "sms.webhook";
export const WEBHOOK_CONNECTION_DEVICE = "webhook";

export type WebhookConfig = {
  readonly enabled: boolean;
  /** Shared secret for HMAC-SHA256 over the raw request body. Hex. */
  readonly secret: string;
  readonly createdAt: number;
  /** Set on the first accepted delivery, so the setup screen can confirm it works. */
  readonly lastDeliveryAt?: number | undefined;
  readonly lastSender?: string | undefined;
};

export type WebhookPayload = {
  readonly from: string;
  readonly text: string;
  readonly sentStamp: number | null;
  readonly receivedStamp: number | null;
  readonly sim: string | null;
};

/* -------------------------------------------------------------------------------------------- */
/* Configuration                                                                                  */
/* -------------------------------------------------------------------------------------------- */

export function readWebhookConfig(db: Db): WebhookConfig | undefined {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(WEBHOOK_SETTING_KEY) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(asText(row.value_json, "value_json")) as Record<string, unknown>;
    /*
     * Absent optional fields are omitted rather than set to `undefined`, so a config read back
     * from disk compares equal to the one that was written. With `exactOptionalPropertyTypes`
     * those are different shapes, and the difference is invisible until something compares them.
     */
    return {
      enabled: parsed.enabled === true,
      secret: String(parsed.secret ?? ""),
      createdAt: Number(parsed.createdAt ?? 0),
      ...(typeof parsed.lastDeliveryAt === "number" ? { lastDeliveryAt: parsed.lastDeliveryAt } : {}),
      ...(typeof parsed.lastSender === "string" ? { lastSender: parsed.lastSender } : {}),
    };
  } catch {
    return undefined;
  }
}

function writeWebhookConfig(db: Db, config: WebhookConfig, now: number): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, revision, updated_at) VALUES (?,?,1,?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                    revision = settings.revision + 1,
                                    updated_at = excluded.updated_at`,
  ).run(WEBHOOK_SETTING_KEY, JSON.stringify(config), now);
}

/**
 * Creates or rotates the shared secret.
 *
 * Rotating invalidates the old one immediately, which is the point: if the secret was ever shown on
 * a screen someone else could see, a new one is the only fix. The collector app has to be updated
 * with the new value or its deliveries start failing — loudly, with 401, not silently.
 */
export function generateWebhookSecret(db: Db, now: number): WebhookConfig {
  const existing = readWebhookConfig(db);
  const config: WebhookConfig = {
    enabled: true,
    secret: randomBytes(32).toString("hex"),
    createdAt: now,
    ...(existing?.lastDeliveryAt === undefined ? {} : { lastDeliveryAt: existing.lastDeliveryAt }),
    ...(existing?.lastSender === undefined ? {} : { lastSender: existing.lastSender }),
  };
  writeWebhookConfig(db, config, now);
  return config;
}

/**
 * Adopts a secret the owner already has.
 *
 * The collector app can generate its own signing key, and when it has, forcing a server-generated
 * one just means retyping a long string into a phone for no benefit. The key is only ever used as
 * HMAC input, so any bytes work; what matters is that both sides hold the same value and that it
 * has enough entropy to be worth signing with.
 *
 * 16 characters is the floor. Below that an attacker on the LAN could search the space faster than
 * they could read the traffic, which would make the signature decorative.
 */
export function setWebhookSecret(db: Db, secret: string, now: number): WebhookConfig {
  const trimmed = secret.trim();
  if (trimmed.length < 16) {
    throw validationError(
      `A signing secret needs at least 16 characters; that one has ${trimmed.length}. ` +
        `Use the one the collector app generated, or generate a new one here.`,
    );
  }
  if (trimmed.length > 512) throw validationError("That secret is implausibly long");
  if (/\s/.test(trimmed)) {
    // A pasted value with a stray space signs differently on each side, and the only symptom is
    // a 401 that looks like the wrong secret entirely.
    throw validationError("A signing secret must not contain spaces or line breaks");
  }

  const existing = readWebhookConfig(db);
  const config: WebhookConfig = {
    enabled: true,
    secret: trimmed,
    createdAt: now,
    ...(existing?.lastDeliveryAt === undefined ? {} : { lastDeliveryAt: existing.lastDeliveryAt }),
    ...(existing?.lastSender === undefined ? {} : { lastSender: existing.lastSender }),
  };
  writeWebhookConfig(db, config, now);
  return config;
}

/**
 * True when a secret is short enough to be worth a warning, while still being usable.
 *
 * The threshold is 32 characters because that is roughly 128 bits for a hex value — the point below
 * which searching the key space starts to compete with simply reading the unencrypted traffic. The
 * collector app's own 32-character default sits exactly on it and is fine; this is not a nudge to
 * replace it.
 */
export function isWeakSecret(secret: string): boolean {
  return secret.trim().length < 32;
}

export function setWebhookEnabled(db: Db, enabled: boolean, now: number): WebhookConfig {
  const existing = readWebhookConfig(db);
  if (!existing) throw validationError("Generate a webhook secret first");
  const config: WebhookConfig = { ...existing, enabled };
  writeWebhookConfig(db, config, now);
  return config;
}

/* -------------------------------------------------------------------------------------------- */
/* Verification                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Checks the `X-Signature` header against the raw body.
 *
 * The comparison is constant-time. The signature covers the **raw bytes**, not a re-serialised
 * object, because re-encoding JSON can change key order or number formatting and would make a valid
 * signature fail — or, worse, make an invalid one pass if the re-encoding normalised away a
 * difference the signer included.
 */
export function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || secret.length === 0) return false;
  // The collector sends lowercase hex; tolerate an algorithm prefix from other senders.
  const provided = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parses and bounds the collector's payload. Rejects anything that is not a usable message. */
export function parseWebhookPayload(raw: unknown): WebhookPayload {
  if (typeof raw !== "object" || raw === null) {
    throw validationError("The webhook body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const from = typeof body.from === "string" ? body.from.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (from.length === 0) throw validationError("The webhook payload has no sender");
  if (text.length === 0) throw validationError("The webhook payload has no message text");

  // buildspec.md §20 bounds sizes so an oversized body cannot be used to fill the disk.
  if (from.length > 128) throw validationError("Sender is implausibly long");
  if (text.length > 20_000) throw validationError("Message text is implausibly long");

  const stamp = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    // The collector sends epoch milliseconds; accept seconds too rather than storing 1970.
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  };

  return {
    from,
    text,
    sentStamp: stamp(body.sentStamp),
    receivedStamp: stamp(body.receivedStamp),
    sim: typeof body.sim === "string" && body.sim.length > 0 ? body.sim.slice(0, 64) : null,
  };
}

/**
 * The occurrence identity for a webhook delivery.
 *
 * buildspec.md §8 wants a provider row id, and this collector does not send one — the payload is
 * only sender, text and timestamps. So the id is derived from exactly those, which is the right
 * trade here rather than a weakness:
 *
 *   - The collector retries a failed delivery up to ten times. Every retry produces an identical
 *     payload and therefore an identical id, so the unique occurrence key absorbs them. That is the
 *     duplicate this endpoint will actually see, and it is handled exactly.
 *   - §8 warns that "two real payments can produce identical text". They would also need an
 *     identical millisecond timestamp to collide here. When `sentStamp` is missing the risk rises,
 *     so `receivedStamp` is folded in as well.
 *
 * The id is an HMAC rather than a plain hash so it cannot be computed by anyone without the secret,
 * which keeps it from being used to probe whether a given message was received (§8's reason for
 * fingerprinting with an installation secret).
 */
export function occurrenceId(payload: WebhookPayload, secret: string): string {
  const material = [
    payload.from,
    payload.text.normalize("NFKC"),
    String(payload.sentStamp ?? ""),
    String(payload.receivedStamp ?? ""),
    payload.sim ?? "",
  ].join("\u0000");
  return createHmac("sha256", secret).update(material).digest("hex").slice(0, 32);
}

export function webhookUnauthorised(): FinanceError {
  return new FinanceError(
    FinanceErrorCode.PERMISSION_DENIED,
    "The request signature did not match.",
  );
}


/* -------------------------------------------------------------------------------------------- */
/* Staging                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export type StageOutcome = {
  readonly staged: boolean;
  readonly reason: "staged" | "duplicate" | "sender_not_enabled";
  readonly connectionId: string;
};

/**
 * Writes one delivered message into the source store, or explains why it was not written.
 *
 * This lives here rather than in the route handler so it can be tested without an HTTP server, and
 * so the same staging path can serve a future file import. The whole thing runs in one transaction:
 * a delivery either records the sender, the message and nothing else, or records nothing.
 */
export function stageWebhookMessage(
  db: Db,
  config: WebhookConfig,
  payload: WebhookPayload,
  now: number,
): StageOutcome {
  const receivedAt = payload.receivedStamp ?? payload.sentStamp ?? now;
  const externalId = occurrenceId(payload, config.secret);

  return db.transaction((): StageOutcome => {
    let connectionId: string;
    const existing = db
      .prepare("SELECT id FROM source_connections WHERE kind = ? AND device_id = ?")
      .get("sms_termux", WEBHOOK_CONNECTION_DEVICE) as Record<string, unknown> | undefined;
    if (existing) {
      connectionId = asText(existing.id, "id");
    } else {
      connectionId = `conn_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
      db.prepare(
        `INSERT INTO source_connections
           (id, kind, label, device_id, provider_generation, enabled, consent_at, created_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
      ).run(connectionId, "sms_termux", "Personal phone (webhook)", WEBHOOK_CONNECTION_DEVICE,
            "webhook", now, now, now);
    }

    // The sender is always recorded; the body is not. buildspec.md §5.4 lets the owner choose from
    // a real list of senders and counts, having stored no message content to build it.
    db.prepare(
      `INSERT INTO source_senders
         (connection_id, sender_key, display_name, enabled, first_seen_at, last_seen_at, seen_count)
       VALUES (?,?,?,0,?,?,1)
       ON CONFLICT(connection_id, sender_key) DO UPDATE SET
         seen_count   = source_senders.seen_count + 1,
         last_seen_at = MAX(COALESCE(source_senders.last_seen_at, 0), excluded.last_seen_at)`,
    ).run(connectionId, payload.from, payload.from, receivedAt, receivedAt);

    const enabled = db
      .prepare("SELECT 1 AS ok FROM source_senders WHERE connection_id = ? AND sender_key = ? AND enabled = 1")
      .get(connectionId, payload.from);
    if (!enabled) return { staged: false, reason: "sender_not_enabled", connectionId };

    const already = db
      .prepare(
        `SELECT 1 AS ok FROM source_messages
          WHERE connection_id = ? AND provider_generation = 'webhook' AND external_id = ?`,
      )
      .get(connectionId, externalId);
    // A retried delivery. buildspec.md §20: one durable source record, one effect.
    if (already) return { staged: false, reason: "duplicate", connectionId };

    db.prepare(
      `INSERT INTO source_messages
         (id, connection_id, provider_generation, external_id, source_kind, sender, received_at,
          source_sent_at, body, body_hmac, metadata_json, processing_status, created_at)
       VALUES (?,?,'webhook',?,?,?,?,?,?,?,?,'staged',?)`,
    ).run(
      `src_${randomUUID().replace(/-/g, "").slice(0, 22)}`,
      connectionId,
      externalId,
      "sms_webhook",
      payload.from,
      receivedAt,
      payload.sentStamp ?? null,
      payload.text,
      externalId,
      JSON.stringify({ sim: payload.sim, via: "webhook" }),
      now,
    );
    return { staged: true, reason: "staged", connectionId };
  });
}

/** Records that a delivery arrived, for the setup screen to confirm the collector is working. */
export function noteWebhookDelivery(db: Db, sender: string, now: number): void {
  const existing = readWebhookConfig(db);
  if (!existing) return;
  writeWebhookConfig(db, { ...existing, lastDeliveryAt: now, lastSender: sender }, now);
}
