/**
 * Probes the owner's extraction endpoint and reports what it actually does.
 *
 * This is buildspec.md §21's M0 gate: "Prove an endpoint can list models and return valid bounded
 * extraction JSON using synthetic text." It also produces the first of the figures buildspec.md §22
 * asks to be benchmarked on the real fixed endpoint — model/digest, context, prompt/output sizes
 * and p50 latency — so the numbers in any report come from a measurement rather than an estimate.
 *
 * Usage:
 *   node scripts/probe-extraction-endpoint.ts
 *   node scripts/probe-extraction-endpoint.ts --base-url http://192.168.1.118:8081/v1 --calls 3
 *
 * It sends one invented fixture message. It never reads a real SMS, a mailbox or the database.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isFinanceError } from "../src/core/domain/errors.ts";
import { fixedClock, requireZone, SUGGESTED_DEFAULT_ZONE } from "../src/core/domain/time.ts";
import { rejectionReasonOf } from "../src/extraction/endpoint-policy.ts";
import {
  createExtractionClient,
  EXTRACTION_DEFAULTS,
  type ExtractionRoleConfig,
} from "../src/extraction/extraction-client.ts";
import { detectProvider, createProvider, type ModelInfo } from "../src/extraction/provider.ts";
import { validateExtraction } from "../src/extraction/validate-evidence.ts";

const DEFAULT_BASE_URL = "http://192.168.1.118:8081/v1";
const DEFAULT_MODEL = "qwen3.5-0.8b";
const DEFAULT_FIXTURE = "sms_posted_purchase_keells";

type Options = {
  readonly baseUrl: string;
  readonly model: string;
  readonly fixture: string;
  readonly calls: number;
};

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      values.set(arg.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  const calls = Number(values.get("calls") ?? process.env["PFA_PROBE_CALLS"] ?? 3);
  return {
    baseUrl: values.get("base-url") ?? process.env["PFA_EXTRACTION_BASE_URL"] ?? DEFAULT_BASE_URL,
    model: values.get("model") ?? process.env["PFA_EXTRACTION_MODEL"] ?? DEFAULT_MODEL,
    fixture: values.get("fixture") ?? DEFAULT_FIXTURE,
    calls: Number.isInteger(calls) && calls > 0 && calls <= 20 ? calls : 3,
  };
}

type Fixture = {
  readonly id: string;
  readonly as_of: string;
  readonly source_text: string;
  readonly expected: { readonly source_id: string };
};

function loadFixture(id: string): Fixture {
  const path = fileURLToPath(new URL(`../fixtures/messages/${id}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

function describeModel(model: ModelInfo): string {
  const parts = [model.id];
  if (model.contextTokens !== null) parts.push(`n_ctx=${model.contextTokens.toLocaleString("en-US")}`);
  if (model.parameterCount !== null) parts.push(`params=${model.parameterCount.toLocaleString("en-US")}`);
  if (model.quantization) parts.push(`quant=${model.quantization}`);
  parts.push(`digest=${model.digest && model.digest.length > 0 ? model.digest : "(not reported)"}`);
  return parts.join("  ");
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

function describeError(error: unknown): string {
  if (isFinanceError(error)) {
    const reason = rejectionReasonOf(error);
    return `${error.code}${reason ? ` (${reason})` : ""}: ${error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)}${value}\n`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const fixture = loadFixture(options.fixture);

  process.stdout.write("\n=== Extraction endpoint probe (buildspec M0 gate) ===\n\n");
  line("configured base URL", options.baseUrl);
  line("locked model", options.model);
  line("synthetic fixture", `${fixture.id} (invented data, buildspec §22)`);
  line("calls", String(options.calls));

  /*
   * A plain-HTTP LAN host is only legitimate because the owner configured this exact address
   * (buildspec.md §18). Both flags are set from that decision, not from a default.
   */
  const ownerApproval = {
    allowPlaintextHttp: new URL(options.baseUrl).protocol === "http:",
    allowPrivateNetwork: true,
    configLabel: "probe-script-development",
  };

  process.stdout.write("\n[1] Provider detection\n");
  let detection;
  try {
    detection = await detectProvider(options.baseUrl, { ...ownerApproval, timeoutMs: 8_000 });
  } catch (error) {
    process.stdout.write(`  UNREACHABLE: ${describeError(error)}\n\n`);
    process.stdout.write("=== M0 gate: FAIL (endpoint not reachable) ===\n\n");
    return 1;
  }
  line("detected provider", detection.kind);
  line("working base URL", detection.baseUrl);
  line("Server header", detection.serverHeader ?? "(none)");
  for (const probe of detection.probes) {
    line("probe", `${probe.path} -> ${probe.note}`);
  }

  process.stdout.write("\n[2] Models\n");
  const provider = createProvider({ kind: detection.kind, baseUrl: detection.baseUrl, ...ownerApproval });
  const models = await provider.listModels();
  for (const model of models) line("-", describeModel(model));
  const listedOk = models.length > 0;

  process.stdout.write("\n[3] Health\n");
  try {
    const health = await provider.health();
    line("status", `${health.ok ? "ok" : "not ok"} (HTTP ${health.status ?? "?"}) in ${health.latencyMs} ms`);
    line("detail", health.detail);
  } catch (error) {
    line("status", `unavailable: ${describeError(error)}`);
  }

  process.stdout.write("\n[4] Bounded extraction on synthetic text\n");
  const config: ExtractionRoleConfig = {
    provider: detection.kind,
    baseUrl: detection.baseUrl,
    model: options.model,
    ...EXTRACTION_DEFAULTS,
    ...ownerApproval,
  };

  const extractor = createExtractionClient(config);
  try {
    const identity = await extractor.verifyModel();
    line("verified model", identity.id);
    line("digest", identity.digest && identity.digest.length > 0 ? identity.digest : "(not reported by host)");
    line("server context", identity.serverContextTokens?.toLocaleString("en-US") ?? "(unknown)");
    line("configured num_ctx", config.numCtx.toLocaleString("en-US"));
  } catch (error) {
    process.stdout.write(`  MODEL CHECK FAILED: ${describeError(error)}\n\n`);
    process.stdout.write("=== M0 gate: FAIL (locked model not served) ===\n\n");
    return 1;
  }

  const clock = fixedClock(Date.parse(fixture.as_of), requireZone(SUGGESTED_DEFAULT_ZONE));
  const latencies: number[] = [];
  let schemaValidCount = 0;
  let evidenceValidCount = 0;

  for (let attempt = 1; attempt <= options.calls; attempt += 1) {
    const started = Date.now();
    const outcome = await extractor.extract({
      sourceId: fixture.expected.source_id,
      text: fixture.source_text,
    });
    const wallMs = Date.now() - started;
    latencies.push(wallMs);

    if (outcome.status !== "ok") {
      process.stdout.write(
        `  call ${attempt}: ${wallMs} ms  schema=INVALID (${outcome.reason}) ${outcome.detail}\n`,
      );
      continue;
    }
    schemaValidCount += 1;

    const validation = validateExtraction({
      sourceId: fixture.expected.source_id,
      sourceText: fixture.source_text,
      payload: outcome.payload,
      clock,
    });
    if (validation.ok) evidenceValidCount += 1;

    const tokens = outcome.call.completionTokens;
    const rate = tokens !== null && outcome.call.latencyMs > 0
      ? ` ${(tokens / (outcome.call.latencyMs / 1000)).toFixed(1)} tok/s`
      : "";
    process.stdout.write(
      `  call ${attempt}: ${wallMs} ms  schema=valid  evidence=${validation.ok ? "valid" : "rejected"}` +
        `  events=${outcome.payload.events.length}` +
        `  prompt=${outcome.call.promptTokens ?? "?"} out=${tokens ?? "?"}${rate}` +
        `  finish=${outcome.call.finishReason ?? "?"}\n`,
    );
    if (!validation.ok) {
      for (const problem of validation.problems) {
        process.stdout.write(`      rejected ${problem.field}: ${problem.reason} - ${problem.detail}\n`);
      }
    }
    for (const event of outcome.payload.events) {
      process.stdout.write(
        `      returned ${event.event_type} amount=${event.amount_text ?? "null"} ` +
          `currency=${event.currency ?? "null"} merchant=${event.merchant_text ?? "null"}\n`,
      );
    }
  }

  process.stdout.write("\n[5] Latency\n");
  line("samples (ms)", latencies.join(", "));
  line("p50 (ms)", String(percentile(latencies, 0.5)));
  line("min / max (ms)", `${Math.min(...latencies)} / ${Math.max(...latencies)}`);

  const gateOk = listedOk && schemaValidCount > 0;
  process.stdout.write("\n=== M0 gate ===\n");
  line("list models", listedOk ? `PASS (${models.length})` : "FAIL");
  line("bounded extraction JSON", `${schemaValidCount}/${options.calls} calls returned valid schema`);
  line("evidence validation", `${evidenceValidCount}/${options.calls} calls passed evidence checks`);
  process.stdout.write(`\n${gateOk ? "M0 GATE: PASS" : "M0 GATE: FAIL"}\n`);
  process.stdout.write(
    "Note: schema validity is the M0 gate. Evidence validity measures extraction *quality*,\n" +
      "which buildspec §22 requires to be tracked separately over a labelled corpus.\n\n",
  );
  return gateOk ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`probe failed: ${describeError(error)}\n`);
    process.exitCode = 1;
  },
);
