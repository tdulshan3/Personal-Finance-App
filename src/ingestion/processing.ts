import { createHmac, randomUUID } from "node:crypto";

import type { Db } from "../core/data/driver.ts";
import { asNumber, asOptionalText, asText } from "../core/data/driver.ts";
import { CURRENCIES, parseMajorUnits } from "../core/domain/money.ts";
import type { Clock } from "../core/domain/time.ts";
import { startOfLocalDay } from "../core/domain/time.ts";
import { EXTRACTION_DEFAULTS, createExtractionClient } from "../extraction/extraction-client.ts";
import { EXTRACTION_PROMPT_VERSION } from "../extraction/prompt.ts";
import type { ProviderKind } from "../extraction/provider.ts";
import { EventType } from "../extraction/schema.ts";
import { TEMPLATE_ENGINE_VERSION, applyTemplates, needsModel } from "../extraction/templates.ts";
import { DateOrder, parseOccurredAtText, validateExtraction } from "../extraction/validate-evidence.ts";

/**
 * Staged message -> reviewable event.
 *
 * buildspec.md §7's pipeline, in the order the spec draws it: deterministic rules first, the fixed
 * extraction model only for what the rules cannot settle, and everything that might touch money
 * lands in the review inbox. §7.4: "model-derived financial entries require review" — and until the
 * owner enables a per-sender auto-post rule (not built), rule-derived ones do too. Nothing in this
 * file writes to the ledger.
 *
 * §19.F shapes the failure path: when the model host is unreachable the message waits as
 * `needs_model` and is retried later. Capture and the rules path never depend on the network.
 */

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

export type ProcessReport = {
  readonly considered: number;
  readonly toReview: number;
  readonly ignored: number;
  readonly waitingForModel: number;
  readonly failed: number;
};

type Candidate = {
  readonly kind: string;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
  readonly accountHint: string | null;
  readonly merchantText: string | null;
  readonly occurredOn: string | null;
  readonly dateAmbiguous: boolean;
  readonly referenceText: string | null;
  readonly balanceText: string | null;
  readonly flags: readonly string[];
  readonly evidence: Readonly<Record<string, string | null>>;
};

/** Event kinds the review inbox can turn into a ledger entry today. */
export const POSTABLE_KINDS: readonly string[] = Object.freeze([
  EventType.POSTED_EXPENSE,
  EventType.POSTED_INCOME,
  EventType.REFUND,
]);

function parseDate(text: string | null): { date: string | null; ambiguous: boolean } {
  if (!text) return { date: null, ambiguous: false };
  const strict = parseOccurredAtText(text);
  if (strict && !strict.ambiguous) return { date: strict.date, ambiguous: false };
  /*
   * buildspec.md §7.1: "ambiguous `03/04/26` goes to review." Everything here goes to review
   * anyway, so the day-first reading (the Sri Lankan convention) is offered as a prefill and the
   * card says it was a guess, rather than leaving the field empty.
   */
  const dayFirst = parseOccurredAtText(text, DateOrder.DMY);
  return { date: dayFirst?.date ?? null, ambiguous: true };
}

function candidateFromRules(body: string): { candidate: Candidate | null; settledKind: string | null } {
  const result = applyTemplates(body);
  if (result.eventType === null) return { candidate: null, settledKind: null };
  if (needsModel(result)) return { candidate: null, settledKind: null };

  const { date, ambiguous } = parseDate(result.occurredAtText.value);
  let amountMinor: bigint | null = null;
  const currencyCode = result.currency.value;
  if (result.amountText.value && currencyCode && CURRENCIES[currencyCode]) {
    try {
      amountMinor = parseMajorUnits(CURRENCIES[currencyCode], result.amountText.value).minor;
    } catch {
      amountMinor = null;
    }
  }

  const flags: string[] = [];
  if (ambiguous) flags.push("date_ambiguous");
  if (!date) flags.push("date_missing");

  return {
    settledKind: result.eventType,
    candidate: {
      kind: result.eventType,
      amountMinor,
      currency: currencyCode,
      accountHint: result.accountSuffix.value,
      merchantText: result.merchantText.value,
      occurredOn: date,
      dateAmbiguous: ambiguous,
      referenceText: result.referenceText.value,
      balanceText: result.balanceText.value,
      flags,
      evidence: {
        amount: result.amountText.evidence,
        merchant: result.merchantText.evidence,
        account: result.accountSuffix.evidence,
        date: result.occurredAtText.evidence,
      },
    },
  };
}

type ExtractionEndpoint = {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  digest: string | null;
};

function readExtractionEndpoint(db: Db): ExtractionEndpoint | null {
  const row = db
    .prepare("SELECT provider_kind, base_url, model_name, model_digest FROM ai_endpoints WHERE role = 'extraction'")
    .get() as Record<string, unknown> | undefined;
  if (!row || row.model_name === null) return null;
  return {
    provider: asText(row.provider_kind, "provider_kind") as ProviderKind,
    baseUrl: asText(row.base_url, "base_url"),
    model: asText(row.model_name, "model_name"),
    digest: asOptionalText(row.model_digest, "model_digest") ?? null,
  };
}

export function createMessageProcessor(deps: { db: Db; clock: Clock; zone: string }) {
  const { db, clock, zone } = deps;

  function recordRun(input: {
    sourceId: string;
    engine: "rules" | "model";
    body: string;
    status: "ok" | "invalid" | "rejected" | "error";
    endpoint?: ExtractionEndpoint | null;
    errorCode?: string | null;
    timings?: Record<string, unknown>;
  }): string {
    const id = newId("xrun");
    db.prepare(
      `INSERT INTO extraction_runs
         (id, source_id, engine, parser_version, prompt_version, model_name, model_digest,
          endpoint_origin, input_hmac, status, attempts, error_code, timings_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    ).run(
      id,
      input.sourceId,
      input.engine,
      input.engine === "rules" ? TEMPLATE_ENGINE_VERSION : EXTRACTION_PROMPT_VERSION,
      input.engine === "model" ? EXTRACTION_PROMPT_VERSION : null,
      input.endpoint?.model ?? null,
      input.endpoint?.digest ?? null,
      input.endpoint ? new URL(input.endpoint.baseUrl).origin : null,
      // A cache key, not a secret: it only needs to be stable for identical input.
      createHmac("sha256", "pfa/extraction-input").update(input.body).digest("hex"),
      input.status,
      input.errorCode ?? null,
      JSON.stringify(input.timings ?? {}),
      clock.now(),
    );
    return id;
  }

  function insertEvent(sourceId: string, runId: string, index: number, receivedAt: number, c: Candidate) {
    const eventId = newId("evt");
    const occurredAt = c.occurredOn ? startOfLocalDay(c.occurredOn, zone) : receivedAt;
    db.prepare(
      `INSERT INTO source_events
         (id, source_id, extraction_run_id, event_index, kind, amount_minor, currency, account_hint,
          merchant_text, occurred_at, occurred_precision, reference_value, candidate_json,
          evidence_json, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'needs_review',?)`,
    ).run(
      eventId,
      sourceId,
      runId,
      index,
      c.kind,
      c.amountMinor,
      c.currency,
      c.accountHint,
      c.merchantText,
      occurredAt,
      // §7.1: arrival time is not transaction time; say so when that is all we have.
      c.occurredOn ? "date_only" : "inferred",
      c.referenceText,
      JSON.stringify({
        occurredOn: c.occurredOn,
        dateAmbiguous: c.dateAmbiguous,
        balanceText: c.balanceText,
        flags: c.flags,
      }),
      JSON.stringify(c.evidence),
      clock.now(),
    );
    db.prepare(
      `INSERT INTO review_items
         (id, kind, target_type, target_id, reason_codes, suggestion_json, status, created_at, updated_at)
       VALUES (?, 'extraction', 'source_event', ?, ?, '{}', 'open', ?, ?)`,
    ).run(newId("rev"), eventId, JSON.stringify(c.flags), clock.now(), clock.now());
  }

  function setStatus(sourceId: string, status: string, purgeBody = false): void {
    if (purgeBody) {
      /*
       * buildspec.md §18: "Filter unrelated conversations and OTPs locally before persistence/model
       * use." A one-time code has no ledger value and real security value to anyone reading the
       * database, so its text is dropped the moment it is recognised.
       */
      db.prepare(
        "UPDATE source_messages SET processing_status = ?, body = NULL, purged_at = ? WHERE id = ?",
      ).run(status, clock.now(), sourceId);
    } else {
      db.prepare("UPDATE source_messages SET processing_status = ? WHERE id = ?").run(status, sourceId);
    }
  }

  /** Runs the rules over one message. Returns true when the message is settled without a model. */
  function processWithRules(row: { id: string; body: string; receivedAt: number }): "review" | "ignored" | "model" {
    const { candidate, settledKind } = candidateFromRules(row.body);
    if (!candidate || !settledKind) return "model";

    if (settledKind === EventType.OTP || settledKind === EventType.PROMOTION) {
      db.transaction(() => {
        recordRun({ sourceId: row.id, engine: "rules", body: row.body, status: "ok" });
        setStatus(row.id, "ignored", true);
      });
      return "ignored";
    }
    if (settledKind === EventType.FAILED || settledKind === EventType.BALANCE_NOTICE) {
      // No money moved. Kept (not purged) because a balance notice feeds reconciliation later.
      db.transaction(() => {
        recordRun({ sourceId: row.id, engine: "rules", body: row.body, status: "ok" });
        setStatus(row.id, "ignored");
      });
      return "ignored";
    }

    db.transaction(() => {
      const runId = recordRun({ sourceId: row.id, engine: "rules", body: row.body, status: "ok" });
      insertEvent(row.id, runId, 0, row.receivedAt, candidate);
      setStatus(row.id, "parsed");
    });
    return "review";
  }

  async function processWithModel(
    row: { id: string; body: string; receivedAt: number },
    endpoint: ExtractionEndpoint,
  ): Promise<"review" | "ignored" | "waiting" | "failed"> {
    let outcome;
    const started = Date.now();
    try {
      const client = createExtractionClient({
        ...EXTRACTION_DEFAULTS,
        provider: endpoint.provider,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        // The owner typed this host into Settings; that is what makes a LAN address legitimate (§18).
        allowPlaintextHttp: true,
        allowPrivateNetwork: true,
        configLabel: "extraction endpoint",
      });
      outcome = await client.extract({ sourceId: row.id, text: row.body });
    } catch (error) {
      // Unreachable, timed out, model missing: leave it queued and try again later (§19.F).
      db.transaction(() => {
        recordRun({
          sourceId: row.id,
          engine: "model",
          body: row.body,
          status: "error",
          endpoint,
          errorCode: error instanceof Error ? error.message.slice(0, 120) : "unavailable",
        });
        setStatus(row.id, "needs_model");
      });
      return "waiting";
    }

    const timings = { latencyMs: Date.now() - started };

    if (outcome.status !== "ok") {
      // Malformed or truncated after the client's own bounded retry: hand the raw text to review.
      db.transaction(() => {
        const runId = recordRun({
          sourceId: row.id, engine: "model", body: row.body, status: "invalid", endpoint,
          errorCode: outcome.reason, timings,
        });
        insertEvent(row.id, runId, 0, row.receivedAt, manualCandidate(["model_output_invalid"]));
        setStatus(row.id, "parsed");
      });
      return "review";
    }

    const validated = validateExtraction({
      sourceId: row.id,
      sourceText: row.body,
      payload: outcome.payload,
      clock,
      dateOrder: DateOrder.DMY,
    });

    const usable = validated.events.filter(
      (e) => e.eventType !== EventType.OTP && e.eventType !== EventType.PROMOTION,
    );

    db.transaction(() => {
      const runId = recordRun({
        sourceId: row.id, engine: "model", body: row.body,
        status: validated.ok ? "ok" : "rejected", endpoint, timings,
      });

      if (!validated.ok || usable.length === 0) {
        if (validated.ok) {
          setStatus(row.id, "ignored");
          return;
        }
        // Evidence failed: the model said something the message does not. Never trust it; show the
        // owner the raw text and let them key it in (§7.3 "Reject invented IDs or evidence").
        insertEvent(row.id, runId, 0, row.receivedAt, manualCandidate(["evidence_rejected"]));
        setStatus(row.id, "parsed");
        return;
      }

      usable.forEach((event, index) => {
        insertEvent(row.id, runId, index, row.receivedAt, {
          kind: event.eventType,
          amountMinor: event.amount?.minor ?? null,
          currency: event.currency?.code ?? null,
          accountHint: event.accountSuffix,
          merchantText: event.merchantText,
          occurredOn: event.occurredOn,
          dateAmbiguous: false,
          referenceText: event.referenceText,
          balanceText: null,
          flags: ["from_model"],
          evidence: { ...event.evidence } as Record<string, string | null>,
        });
      });
      setStatus(row.id, "parsed");
    });

    if (!validated.ok || usable.length > 0) return "review";
    return "ignored";
  }

  function manualCandidate(flags: string[]): Candidate {
    return {
      kind: "unknown", amountMinor: null, currency: null, accountHint: null, merchantText: null,
      occurredOn: null, dateAmbiguous: false, referenceText: null, balanceText: null,
      flags, evidence: {},
    };
  }

  /**
   * Processes everything waiting. Safe to call at any time and from anywhere: each message moves
   * forward at most one state per call and every write is its own transaction, so a crash mid-run
   * leaves whole messages either done or untouched (§20 "crash mid-write").
   */
  async function processPending(options: { limit?: number; useModel?: boolean } = {}): Promise<ProcessReport> {
    const limit = options.limit ?? 50;
    const rows = (
      db
        .prepare(
          `SELECT id, body, received_at, processing_status FROM source_messages
            WHERE processing_status IN ('staged','needs_model') AND body IS NOT NULL
            ORDER BY received_at ASC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map((r) => ({
      id: asText(r.id, "id"),
      body: asText(r.body, "body"),
      receivedAt: asNumber(r.received_at, "received_at"),
      status: asText(r.processing_status, "processing_status"),
    }));

    let toReview = 0, ignored = 0, waiting = 0, failed = 0;
    const endpoint = options.useModel === false ? null : readExtractionEndpoint(db);

    for (const row of rows) {
      try {
        let result: string = row.status === "needs_model" ? "model" : processWithRules(row);
        if (result === "model") {
          if (!endpoint) {
            setStatus(row.id, "needs_model");
            result = "waiting";
          } else {
            result = await processWithModel(row, endpoint);
          }
        }
        if (result === "review") toReview += 1;
        else if (result === "ignored") ignored += 1;
        else if (result === "waiting") waiting += 1;
        else failed += 1;
      } catch {
        failed += 1;
        try { setStatus(row.id, "failed"); } catch { /* keep going */ }
      }
    }
    return { considered: rows.length, toReview, ignored, waitingForModel: waiting, failed };
  }

  function counts() {
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN processing_status='staged' THEN 1 ELSE 0 END) AS staged,
           SUM(CASE WHEN processing_status='needs_model' THEN 1 ELSE 0 END) AS waiting
         FROM source_messages`,
      )
      .get() as Record<string, unknown>;
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM review_items WHERE status='open'")
      .get() as Record<string, unknown>;
    return {
      staged: Number(row.staged ?? 0),
      waitingForModel: Number(row.waiting ?? 0),
      openReviews: Number(open.n ?? 0),
    };
  }

  return { processPending, counts };
}

export type MessageProcessor = ReturnType<typeof createMessageProcessor>;
