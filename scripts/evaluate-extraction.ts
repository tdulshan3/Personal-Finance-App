/**
 * Scores the labelled fixture corpus against the live extraction endpoint.
 *
 * buildspec.md §22: "Evaluate by sender/template and message type, not only one aggregate score.
 * Track event-type accuracy, exact money/currency accuracy, date accuracy, account-resolution
 * accuracy, category accuracy, schema validity, unsupported-value rate, review rate, and latency."
 *
 * §7.2 additionally requires this to be re-run before accepting any change to the model, the
 * prompt or the schema. Results belong in `docs/extraction-eval.md`.
 *
 *     node scripts/evaluate-extraction.ts [--json] [--base <url>] [--repeat <n>]
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseMajorUnits, requireCurrency } from "../src/core/domain/money.ts";
import { createProvider, detectProvider } from "../src/extraction/provider.ts";
import type { InferenceProvider } from "../src/extraction/provider.ts";
import { buildExtractionMessages } from "../src/extraction/prompt.ts";
import { EXTRACTION_PROMPT_VERSION } from "../src/extraction/prompt.ts";
import { EXTRACTION_JSON_SCHEMA, EXTRACTION_SCHEMA_VERSION } from "../src/extraction/schema.ts";

type Fixture = {
  id: string;
  source_text: string;
  expected?: { events?: Record<string, unknown>[] };
};

type FieldScore = { correct: number; total: number };

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const BASE = flag("base", process.env.PFA_EXTRACTION_BASE_URL ?? "http://192.168.1.118:8081/v1");
const MODEL = flag("model", process.env.PFA_EXTRACTION_MODEL ?? "qwen3.5-0.8b");
const REPEAT = Math.max(1, Number(flag("repeat", "1")));
const MAX_TOKENS = Math.max(128, Number(flag("max-tokens", "512")));
const AS_JSON = args.includes("--json");

/*
 * Resolved once, because the two hosts need different request shapes: llama.cpp honours
 * `chat_template_kwargs`, while Ollama's OpenAI shim silently ignores it and the model spends its
 * whole budget on hidden reasoning. Only Ollama's native /api/chat accepts `think: false`.
 */
let provider: InferenceProvider | undefined;
async function resolveProvider(): Promise<InferenceProvider> {
  if (provider) return provider;
  const detected = await detectProvider(BASE, { allowPlaintextHttp: true, allowPrivateNetwork: true });
  const resolved = createProvider({
    kind: detected.kind,
    baseUrl: detected.baseUrl,
    allowPlaintextHttp: true,
    allowPrivateNetwork: true,
  });
  console.log(`  provider        ${detected.kind} at ${detected.baseUrl}` +
    (detected.serverHeader ? ` (Server: ${detected.serverHeader})` : ""));
  provider = resolved;
  return resolved;
}

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/messages", import.meta.url));

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}`, "utf8")) as Fixture)
    .filter((f) => Array.isArray(f.expected?.events) && f.expected.events.length > 0);
}

async function extract(fixture: Fixture): Promise<{ payload: unknown; ms: number; error?: string }> {
  const sourceId = fixture.id.slice(0, 60).replace(/[^A-Za-z0-9_.:-]/g, "_");
  const messages = buildExtractionMessages(sourceId, fixture.source_text);
  const started = Date.now();
  try {
    const active = await resolveProvider();
    const result = await active.chatJson({
      model: MODEL,
      messages,
      schema: EXTRACTION_JSON_SCHEMA,
      schemaName: "extraction",
      temperature: 0,
      maxOutputTokens: MAX_TOKENS,
      disableThinking: true,
      timeoutMs: 180_000,
    });
    return {
      payload: result.json,
      ms: Date.now() - started,
      ...(result.jsonParseError
        ? { error: `${result.jsonParseError}${result.truncated ? " (truncated)" : ""}` }
        : {}),
    };
  } catch (error) {
    return {
      payload: null,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** An amount is "correct" only if the application could actually turn it into minor units. */
function amountParses(text: unknown, currencyCode: unknown): boolean {
  if (typeof text !== "string" || text.trim().length === 0) return false;
  try {
    const currency = requireCurrency(typeof currencyCode === "string" ? currencyCode : "LKR");
    parseMajorUnits(currency, text);
    return true;
  } catch {
    return false;
  }
}

function bump(score: FieldScore, ok: boolean): void {
  score.total += 1;
  if (ok) score.correct += 1;
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  const latencies: number[] = [];
  const rows: Record<string, unknown>[] = [];

  const eventType: FieldScore = { correct: 0, total: 0 };
  const amount: FieldScore = { correct: 0, total: 0 };
  const currency: FieldScore = { correct: 0, total: 0 };
  const occurredAt: FieldScore = { correct: 0, total: 0 };
  const accountSuffix: FieldScore = { correct: 0, total: 0 };
  const schemaValid: FieldScore = { correct: 0, total: 0 };

  const byType = new Map<string, FieldScore>();

  for (const fixture of fixtures) {
    const want = fixture.expected!.events![0] as Record<string, unknown>;
    const wantType = String(want.event_type);

    for (let run = 0; run < REPEAT; run += 1) {
      const { payload, ms, error } = await extract(fixture);
      latencies.push(ms);

      const events = (payload as { events?: Record<string, unknown>[] } | null)?.events;
      const got = Array.isArray(events) ? (events[0] ?? {}) : {};
      const parsed = payload !== null && Array.isArray(events);
      bump(schemaValid, parsed);

      const typeOk = got.event_type === wantType;
      bump(eventType, typeOk);

      const perType = byType.get(wantType) ?? { correct: 0, total: 0 };
      bump(perType, typeOk);
      byType.set(wantType, perType);

      // Fields are only scored where the label states one, so a null label is not counted as a win.
      if (want.amount_text != null) bump(amount, amountParses(got.amount_text, got.currency));
      if (want.currency != null) bump(currency, got.currency === want.currency);
      if (want.occurred_at_text != null) bump(occurredAt, got.occurred_at_text === want.occurred_at_text);
      if (want.account_suffix != null) bump(accountSuffix, got.account_suffix === want.account_suffix);

      rows.push({
        fixture: fixture.id,
        run: run + 1,
        expected_type: wantType,
        returned_type: got.event_type ?? null,
        type_ok: typeOk,
        amount_text: got.amount_text ?? null,
        amount_ok: want.amount_text == null ? null : amountParses(got.amount_text, got.currency),
        ms,
        ...(error ? { error } : {}),
      });
    }
  }

  const percent = (s: FieldScore): string =>
    s.total === 0 ? "n/a" : `${s.correct}/${s.total} (${Math.round((s.correct / s.total) * 100)}%)`;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          base: BASE,
          model: MODEL,
          promptVersion: EXTRACTION_PROMPT_VERSION,
          schemaVersion: EXTRACTION_SCHEMA_VERSION,
          repeat: REPEAT,
          scores: { eventType, amount, currency, occurredAt, accountSuffix, schemaValid },
          latency: { p50: p(0.5), p95: p(0.95), min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 },
          rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nExtraction evaluation`);
  console.log(`  endpoint        ${BASE}`);
  console.log(`  model           ${MODEL}`);
  console.log(`  prompt version  ${EXTRACTION_PROMPT_VERSION}  schema v${EXTRACTION_SCHEMA_VERSION}`);
  console.log(`  fixtures        ${fixtures.length} x ${REPEAT} run(s)   max_tokens ${MAX_TOKENS}\n`);

  for (const row of rows) {
    const typeOk = row.type_ok ? "OK " : "BAD";
    const amountOk = row.amount_ok === null ? "  -" : row.amount_ok ? "OK " : "BAD";
    console.log(
      `  ${typeOk}type ${amountOk}amt  ${String(row.fixture).slice(0, 32).padEnd(32)}` +
        ` want=${String(row.expected_type).padEnd(15)} got=${String(row.returned_type).padEnd(15)}` +
        ` ${String(row.ms).padStart(6)}ms`,
    );
  }

  console.log(`\n  schema valid       ${percent(schemaValid)}`);
  console.log(`  event_type         ${percent(eventType)}`);
  console.log(`  amount parses      ${percent(amount)}`);
  console.log(`  currency           ${percent(currency)}`);
  console.log(`  occurred_at_text   ${percent(occurredAt)}`);
  console.log(`  account_suffix     ${percent(accountSuffix)}`);

  console.log(`\n  by expected event_type:`);
  for (const [type, score] of [...byType.entries()].sort()) {
    console.log(`    ${type.padEnd(18)} ${percent(score)}`);
  }

  console.log(
    `\n  latency  p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  min ${sorted[0] ?? 0}ms  max ${sorted.at(-1) ?? 0}ms`,
  );
  console.log(
    `\n  buildspec §7.4: model-derived entries require review in version 1. These numbers\n` +
      `  describe how useful the review queue is, not whether review happens.\n`,
  );
}

await main();
