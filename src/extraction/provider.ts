/**
 * Inference provider abstraction.
 *
 * buildspec.md §7.2 specifies Ollama's native API (`/api/chat`, `/api/tags`, base URL stored
 * without `/v1`). The host this repository actually targets is llama.cpp, which speaks the
 * OpenAI-compatible API under `/v1` and answers 404 on `/api/tags` and `/api/chat`. Rather than
 * rewriting the spec's integration away, both dialects are implemented behind one interface and
 * `detectProvider` reports which one a host really speaks — so a base URL configured for the wrong
 * dialect produces a named diagnostic instead of an unexplained 404.
 *
 * The two dialects differ in exactly three places:
 *   - model listing: `GET /v1/models` (`data[]`) vs `GET /api/tags` (`models[]`)
 *   - chat: `POST /v1/chat/completions` vs `POST /api/chat`
 *   - structured output: `response_format.json_schema.schema` vs a bare `format` object
 */

import { FinanceError, FinanceErrorCode } from "../core/domain/errors.ts";
import type { ChatMessage } from "./prompt.ts";
import type { JsonSchema } from "./schema.ts";
import {
  createEndpointPolicy,
  joinPath,
  requestJson,
  type EndpointPolicy,
  type FetchLike,
} from "./endpoint-policy.ts";

export const ProviderKind = {
  /** llama.cpp, vLLM, LM Studio, or Ollama's `/v1` compatibility shim. */
  OPENAI_COMPATIBLE: "openai-compatible",
  /** Ollama's own API, as described by buildspec.md §7.2. */
  OLLAMA_NATIVE: "ollama-native",
} as const;

export type ProviderKind = (typeof ProviderKind)[keyof typeof ProviderKind];

export const PROVIDER_KINDS: readonly ProviderKind[] = Object.freeze(Object.values(ProviderKind));

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

/* --------------------------------------------------------------------------------------------- */
/* Interface                                                                                       */
/* --------------------------------------------------------------------------------------------- */

export type ModelInfo = {
  readonly id: string;
  /** buildspec.md §7.2: "Save its digest ... with each extraction." Null when the host omits it. */
  readonly digest: string | null;
  readonly quantization: string | null;
  readonly parameterCount: number | null;
  readonly contextTokens: number | null;
  readonly sizeBytes: number | null;
  readonly aliases: readonly string[];
};

export type ChatJsonRequest = {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly schema: JsonSchema;
  readonly schemaName: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly contextTokens?: number | undefined;
  /** buildspec.md §7.3: "Disable thinking when supported and verified for the model/server". */
  readonly disableThinking?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type ChatJsonResult = {
  readonly content: string;
  readonly json: unknown;
  readonly jsonParseError: string | null;
  /** The model the *server* says produced this answer. Compared against the locked model id. */
  readonly modelReported: string | null;
  readonly finishReason: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly serverFingerprint: string | null;
  readonly latencyMs: number;
  /** Generation stopped on the token budget: the JSON is incomplete by definition. */
  readonly truncated: boolean;
  /** The host returned hidden reasoning, which was discarded rather than stored. */
  readonly reasoningDropped: boolean;
};

export type HealthResult = {
  readonly ok: boolean;
  readonly status: number | null;
  readonly detail: string;
  readonly latencyMs: number;
  readonly serverHeader: string | null;
};

export type InferenceProvider = {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly policy: EndpointPolicy;
  listModels(signal?: AbortSignal): Promise<readonly ModelInfo[]>;
  chatJson(request: ChatJsonRequest): Promise<ChatJsonResult>;
  health(signal?: AbortSignal): Promise<HealthResult>;
};

export type ProviderConfig = {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer`. Never placed in the URL (buildspec.md §18). */
  readonly apiKey?: string | undefined;
  readonly allowPlaintextHttp?: boolean | undefined;
  readonly allowPrivateNetwork?: boolean | undefined;
  readonly configLabel?: string | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly readTimeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
};

export function modelUnavailable(
  message: string,
  details: Readonly<Record<string, string>> = {},
): FinanceError {
  return new FinanceError(FinanceErrorCode.MODEL_UNAVAILABLE, message, details);
}

/* --------------------------------------------------------------------------------------------- */
/* Paths                                                                                           */
/* --------------------------------------------------------------------------------------------- */

export type ProviderPaths = {
  readonly models: string;
  readonly chat: string;
  readonly health: string;
  readonly props: string | null;
};

/**
 * Derives the exact API paths a provider may touch. This list becomes the endpoint allowlist, so
 * the client physically cannot request anything else on the host.
 */
export function providerPaths(kind: ProviderKind, basePath: string): ProviderPaths {
  const base = basePath.replace(/\/+$/, "");
  if (kind === ProviderKind.OLLAMA_NATIVE) {
    return {
      models: joinPath(base, "/api/tags"),
      chat: joinPath(base, "/api/chat"),
      health: joinPath(base, "/api/version"),
      props: null,
    };
  }
  // llama.cpp and vLLM serve `/health` and `/props` at the root, not under `/v1`.
  const root = base.replace(/\/v1$/, "");
  return {
    models: joinPath(base, "/models"),
    chat: joinPath(base, "/chat/completions"),
    health: joinPath(root, "/health"),
    props: joinPath(root, "/props"),
  };
}

/* --------------------------------------------------------------------------------------------- */
/* Safe readers for untrusted JSON                                                                 */
/* --------------------------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* --------------------------------------------------------------------------------------------- */
/* Shared construction                                                                             */
/* --------------------------------------------------------------------------------------------- */

type ProviderInternals = {
  readonly policy: EndpointPolicy;
  readonly paths: ProviderPaths;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchImpl: FetchLike | undefined;
};

function prepare(config: ProviderConfig): ProviderInternals {
  const basePath = new URL(config.baseUrl).pathname.replace(/\/+$/, "");
  const paths = providerPaths(config.kind, basePath);
  const allowedPaths = [paths.models, paths.chat, paths.health, ...(paths.props ? [paths.props] : [])];
  const policy = createEndpointPolicy({
    baseUrl: config.baseUrl,
    allowedPaths,
    ...(config.allowPlaintextHttp === undefined ? {} : { allowPlaintextHttp: config.allowPlaintextHttp }),
    ...(config.allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork: config.allowPrivateNetwork }),
    ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
    ...(config.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: config.connectTimeoutMs }),
    ...(config.readTimeoutMs === undefined ? {} : { readTimeoutMs: config.readTimeoutMs }),
    ...(config.configLabel === undefined ? {} : { configLabel: config.configLabel }),
  });
  return {
    policy,
    paths,
    headers: Object.freeze(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    fetchImpl: config.fetchImpl,
  };
}

function requireOkJson(
  response: { status: number; ok: boolean; json: unknown; parseError: string | null; text: string },
  what: string,
  path: string,
): Record<string, unknown> {
  if (!response.ok) {
    throw modelUnavailable(
      `${what} failed: ${path} answered HTTP ${response.status}`,
      { status: String(response.status), path },
    );
  }
  const record = asRecord(response.json);
  if (!record) {
    throw modelUnavailable(
      `${what} failed: ${path} did not return a JSON object` +
        (response.parseError ? ` (${response.parseError})` : ""),
      { path },
    );
  }
  return record;
}

/* --------------------------------------------------------------------------------------------- */
/* OpenAI-compatible (llama.cpp / vLLM / LM Studio / Ollama's /v1 shim)                            */
/* --------------------------------------------------------------------------------------------- */

/**
 * llama.cpp answers `/v1/models` with both an OpenAI `data[]` array and an Ollama-shaped
 * `models[]` array. The `data[]` entries carry `meta` (n_ctx, n_params, ftype) and the `models[]`
 * entries carry `digest`, so both are merged into one `ModelInfo`.
 */
export function parseOpenAiModels(body: Record<string, unknown>): readonly ModelInfo[] {
  const ollamaShaped = new Map<string, Record<string, unknown>>();
  for (const entry of asArray(body["models"])) {
    const record = asRecord(entry);
    const name = record ? asString(record["name"]) ?? asString(record["model"]) : null;
    if (record && name) ollamaShaped.set(name, record);
  }

  const out: ModelInfo[] = [];
  for (const entry of asArray(body["data"])) {
    const record = asRecord(entry);
    const id = record ? asString(record["id"]) : null;
    if (!record || !id) continue;
    const meta = asRecord(record["meta"]) ?? {};
    const twin = ollamaShaped.get(id) ?? {};
    const details = asRecord(twin["details"]) ?? {};
    out.push({
      id,
      digest: asString(twin["digest"]),
      quantization: asString(meta["ftype"]) ?? asString(details["quantization_level"]),
      parameterCount: asFiniteNumber(meta["n_params"]),
      contextTokens: asFiniteNumber(meta["n_ctx"]),
      sizeBytes: asFiniteNumber(meta["size"]),
      aliases: Object.freeze(
        asArray(record["aliases"]).filter((a): a is string => typeof a === "string"),
      ),
    });
  }
  return Object.freeze(out);
}

export function buildOpenAiChatBody(request: ChatJsonRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    stream: false,
    response_format: {
      type: "json_schema",
      json_schema: { name: request.schemaName, strict: true, schema: request.schema },
    },
    /*
     * buildspec.md §7.3: "Disable thinking when supported and verified for the model/server; never
     * save hidden reasoning as a financial record." Verified against this host: without it the
     * Qwen 3.5 chat template emits a `<think>` block that consumes the entire `max_tokens` budget
     * and returns empty content with finish_reason "length".
     */
    ...(request.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };
}

export function parseOpenAiChatResponse(
  body: Record<string, unknown>,
  latencyMs: number,
): ChatJsonResult {
  const choice = asRecord(asArray(body["choices"])[0]) ?? {};
  const message = asRecord(choice["message"]) ?? {};
  const content = asString(message["content"]) ?? "";
  const usage = asRecord(body["usage"]) ?? {};
  const finishReason = asString(choice["finish_reason"]);

  let json: unknown = null;
  let jsonParseError: string | null = null;
  try {
    json = content.length === 0 ? null : JSON.parse(content);
  } catch (error) {
    jsonParseError = error instanceof Error ? error.message : String(error);
  }

  return {
    content,
    json,
    jsonParseError,
    modelReported: asString(body["model"]),
    finishReason,
    promptTokens: asFiniteNumber(usage["prompt_tokens"]),
    completionTokens: asFiniteNumber(usage["completion_tokens"]),
    serverFingerprint: asString(body["system_fingerprint"]),
    latencyMs,
    truncated: finishReason === "length",
    // Read only to note that it happened; the text itself is never returned or stored.
    reasoningDropped: asString(message["reasoning_content"]) !== null,
  };
}

export function createOpenAiCompatibleProvider(
  config: Omit<ProviderConfig, "kind">,
): InferenceProvider {
  const internals = prepare({ ...config, kind: ProviderKind.OPENAI_COMPATIBLE });
  const { policy, paths, headers, fetchImpl } = internals;

  return Object.freeze({
    kind: ProviderKind.OPENAI_COMPATIBLE,
    baseUrl: config.baseUrl,
    policy,

    async listModels(signal?: AbortSignal): Promise<readonly ModelInfo[]> {
      const response = await requestJson(policy, {
        path: paths.models,
        headers,
        timeoutMs: policy.connectTimeoutMs,
        ...(signal ? { signal } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      return parseOpenAiModels(requireOkJson(response, "Listing models", paths.models));
    },

    async chatJson(request: ChatJsonRequest): Promise<ChatJsonResult> {
      const response = await requestJson(policy, {
        path: paths.chat,
        method: "POST",
        headers,
        body: buildOpenAiChatBody(request),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      return parseOpenAiChatResponse(
        requireOkJson(response, "Chat completion", paths.chat),
        response.latencyMs,
      );
    },

    async health(signal?: AbortSignal): Promise<HealthResult> {
      const response = await requestJson(policy, {
        path: paths.health,
        headers,
        timeoutMs: policy.connectTimeoutMs,
        ...(signal ? { signal } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      const body = asRecord(response.json) ?? {};
      return {
        ok: response.ok,
        status: response.status,
        detail: asString(body["status"]) ?? (response.ok ? "ok" : `HTTP ${response.status}`),
        latencyMs: response.latencyMs,
        serverHeader: response.headers["server"] ?? null,
      };
    },
  });
}

/* --------------------------------------------------------------------------------------------- */
/* Ollama native (buildspec.md §7.2's integration)                                                 */
/* --------------------------------------------------------------------------------------------- */

export function parseOllamaModels(body: Record<string, unknown>): readonly ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const entry of asArray(body["models"])) {
    const record = asRecord(entry);
    const id = record ? asString(record["name"]) ?? asString(record["model"]) : null;
    if (!record || !id) continue;
    const details = asRecord(record["details"]) ?? {};
    const parameterSize = asString(details["parameter_size"]);
    out.push({
      id,
      digest: asString(record["digest"]),
      quantization: asString(details["quantization_level"]),
      parameterCount: parameterSize ? parseParameterSize(parameterSize) : null,
      contextTokens: null,
      sizeBytes: asFiniteNumber(record["size"]),
      aliases: Object.freeze([]),
    });
  }
  return Object.freeze(out);
}

/** Ollama reports `"0.8B"` rather than a count; a best-effort number keeps the record comparable. */
function parseParameterSize(text: string): number | null {
  const match = /^([\d.]+)\s*([KMB])?$/i.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? "").toUpperCase();
  const scale = unit === "B" ? 1e9 : unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1;
  return Math.round(value * scale);
}

export function buildOllamaChatBody(request: ChatJsonRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    stream: false,
    // buildspec.md §7.3: Ollama takes the schema directly in `format`, with no OpenAI wrapper.
    format: request.schema,
    ...(request.disableThinking ? { think: false } : {}),
    options: {
      temperature: request.temperature,
      num_predict: request.maxOutputTokens,
      ...(request.contextTokens === undefined ? {} : { num_ctx: request.contextTokens }),
    },
  };
}

export function parseOllamaChatResponse(
  body: Record<string, unknown>,
  latencyMs: number,
): ChatJsonResult {
  const message = asRecord(body["message"]) ?? {};
  const content = asString(message["content"]) ?? "";
  const doneReason = asString(body["done_reason"]);

  let json: unknown = null;
  let jsonParseError: string | null = null;
  try {
    json = content.length === 0 ? null : JSON.parse(content);
  } catch (error) {
    jsonParseError = error instanceof Error ? error.message : String(error);
  }

  return {
    content,
    json,
    jsonParseError,
    modelReported: asString(body["model"]),
    finishReason: doneReason,
    promptTokens: asFiniteNumber(body["prompt_eval_count"]),
    completionTokens: asFiniteNumber(body["eval_count"]),
    serverFingerprint: null,
    latencyMs,
    truncated: doneReason === "length",
    reasoningDropped: asString(message["thinking"]) !== null,
  };
}

export function createOllamaNativeProvider(
  config: Omit<ProviderConfig, "kind">,
): InferenceProvider {
  const internals = prepare({ ...config, kind: ProviderKind.OLLAMA_NATIVE });
  const { policy, paths, headers, fetchImpl } = internals;

  return Object.freeze({
    kind: ProviderKind.OLLAMA_NATIVE,
    baseUrl: config.baseUrl,
    policy,

    async listModels(signal?: AbortSignal): Promise<readonly ModelInfo[]> {
      const response = await requestJson(policy, {
        path: paths.models,
        headers,
        timeoutMs: policy.connectTimeoutMs,
        ...(signal ? { signal } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      return parseOllamaModels(requireOkJson(response, "Listing models", paths.models));
    },

    async chatJson(request: ChatJsonRequest): Promise<ChatJsonResult> {
      const response = await requestJson(policy, {
        path: paths.chat,
        method: "POST",
        headers,
        body: buildOllamaChatBody(request),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      return parseOllamaChatResponse(
        requireOkJson(response, "Chat completion", paths.chat),
        response.latencyMs,
      );
    },

    async health(signal?: AbortSignal): Promise<HealthResult> {
      const response = await requestJson(policy, {
        path: paths.health,
        headers,
        timeoutMs: policy.connectTimeoutMs,
        ...(signal ? { signal } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      const body = asRecord(response.json) ?? {};
      return {
        ok: response.ok,
        status: response.status,
        detail: asString(body["version"]) ?? (response.ok ? "ok" : `HTTP ${response.status}`),
        latencyMs: response.latencyMs,
        serverHeader: response.headers["server"] ?? null,
      };
    },
  });
}

export function createProvider(config: ProviderConfig): InferenceProvider {
  const { kind, ...rest } = config;
  return kind === ProviderKind.OLLAMA_NATIVE
    ? createOllamaNativeProvider(rest)
    : createOpenAiCompatibleProvider(rest);
}

/* --------------------------------------------------------------------------------------------- */
/* Detection                                                                                       */
/* --------------------------------------------------------------------------------------------- */

export type ProviderProbe = {
  readonly path: string;
  readonly status: number | null;
  readonly matched: ProviderKind | null;
  readonly note: string;
};

export type ProviderDetection = {
  readonly kind: ProviderKind;
  /** The base URL that actually works, which may differ from the configured one by a `/v1`. */
  readonly baseUrl: string;
  readonly serverHeader: string | null;
  readonly modelIds: readonly string[];
  readonly probes: readonly ProviderProbe[];
};

export type DetectProviderOptions = {
  readonly allowPlaintextHttp?: boolean | undefined;
  readonly allowPrivateNetwork?: boolean | undefined;
  readonly configLabel?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly signal?: AbortSignal | undefined;
};

type Candidate = { readonly path: string; readonly kind: ProviderKind; readonly baseUrl: string };

function detectionCandidates(baseUrl: string): readonly Candidate[] {
  const url = new URL(baseUrl);
  const base = url.pathname.replace(/\/+$/, "");
  const root = base.replace(/\/v1$/, "");
  const origin = url.origin;

  const raw: Candidate[] = [
    { path: joinPath(base, "/models"), kind: ProviderKind.OPENAI_COMPATIBLE, baseUrl: `${origin}${base}` },
    {
      path: joinPath(root, "/v1/models"),
      kind: ProviderKind.OPENAI_COMPATIBLE,
      baseUrl: `${origin}${joinPath(root, "/v1")}`,
    },
    { path: joinPath(root, "/api/tags"), kind: ProviderKind.OLLAMA_NATIVE, baseUrl: `${origin}${root}` },
  ];

  const seen = new Set<string>();
  return Object.freeze(
    raw.filter((candidate) => {
      if (seen.has(candidate.path)) return false;
      seen.add(candidate.path);
      return true;
    }),
  );
}

/**
 * Probes a host and reports which dialect it speaks.
 *
 * buildspec.md §7.2 tells the implementer to store the base URL "without appending `/v1`", which is
 * correct for Ollama and wrong for llama.cpp. When the configured URL is wrong in either direction
 * this returns the base URL that does work, so setup can show a concrete correction rather than a
 * bare 404.
 */
export async function detectProvider(
  baseUrl: string,
  options: DetectProviderOptions = {},
): Promise<ProviderDetection> {
  const candidates = detectionCandidates(baseUrl);
  const policy = createEndpointPolicy({
    baseUrl,
    allowedPaths: candidates.map((candidate) => candidate.path),
    ...(options.allowPlaintextHttp === undefined ? {} : { allowPlaintextHttp: options.allowPlaintextHttp }),
    ...(options.allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork: options.allowPrivateNetwork }),
    ...(options.configLabel === undefined ? {} : { configLabel: options.configLabel }),
    connectTimeoutMs: options.timeoutMs ?? 5_000,
  });

  const headers = options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {};
  const probes: ProviderProbe[] = [];
  let serverHeader: string | null = null;

  for (const candidate of candidates) {
    let status: number | null = null;
    let note = "";
    try {
      const response = await requestJson(policy, {
        path: candidate.path,
        headers,
        timeoutMs: options.timeoutMs ?? 5_000,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      status = response.status;
      serverHeader = serverHeader ?? response.headers["server"] ?? null;
      const body = asRecord(response.json);

      if (response.ok && body) {
        const models =
          candidate.kind === ProviderKind.OPENAI_COMPATIBLE && Array.isArray(body["data"])
            ? parseOpenAiModels(body)
            : candidate.kind === ProviderKind.OLLAMA_NATIVE && Array.isArray(body["models"])
              ? parseOllamaModels(body)
              : null;
        if (models) {
          probes.push({
            path: candidate.path,
            status,
            matched: candidate.kind,
            note: `answered with ${models.length} model(s)`,
          });
          return {
            kind: candidate.kind,
            baseUrl: candidate.baseUrl,
            serverHeader,
            modelIds: Object.freeze(models.map((model) => model.id)),
            probes: Object.freeze(probes),
          };
        }
        note = "HTTP 200 but the body has no recognisable model list";
      } else {
        note = `HTTP ${response.status}`;
      }
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    }
    probes.push({ path: candidate.path, status, matched: null, note });
  }

  const summary = probes.map((probe) => `  ${probe.path} -> ${probe.note}`).join("\n");
  throw modelUnavailable(
    `No supported inference API found at ${new URL(baseUrl).origin}. Probed:\n${summary}\n` +
      "An OpenAI-compatible host (llama.cpp, vLLM, LM Studio) needs a base URL ending in '/v1'; " +
      "a native Ollama host needs one without it.",
    { base_url: new URL(baseUrl).origin },
  );
}
