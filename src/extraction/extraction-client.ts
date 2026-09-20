/**
 * The fixed-model extraction client.
 *
 * buildspec.md §1.2: "Extraction always uses the fixed Qwen 3.5 0.8B model when a model is needed.
 * Deterministic parsers run first. The selectable chat model never silently becomes the extractor."
 * buildspec.md §1.3: "Two separate model configurations: one extraction URL and one agent URL, with
 * independent clients, timeouts, queues, and connection tests."
 * buildspec.md §7.2: "Save its digest and parser/prompt version with each extraction. Do not use
 * `latest`, download another model automatically, or fall back to the agent model."
 *
 * Both role configurations are declared here because they are one settings document and must be
 * validated together, but only the extraction role is implemented in this file. The agent role
 * (buildspec.md §14) gets its own client, queue and permission model.
 */

import { FinanceError, FinanceErrorCode, validationError } from "../core/domain/errors.ts";
import { systemClock, SUGGESTED_DEFAULT_ZONE, type Clock, type Instant } from "../core/domain/time.ts";
import type { FetchLike } from "./endpoint-policy.ts";
import { buildExtractionMessages, EXTRACTION_PROMPT_VERSION } from "./prompt.ts";
import {
  createProvider,
  isProviderKind,
  modelUnavailable,
  ProviderKind,
  type InferenceProvider,
  type ModelInfo,
} from "./provider.ts";
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SCHEMA_NAME,
  EXTRACTION_SCHEMA_VERSION,
  parseExtractionPayload,
  type ExtractionPayload,
} from "./schema.ts";

/* --------------------------------------------------------------------------------------------- */
/* Two-role configuration (buildspec.md §7.2)                                                      */
/* --------------------------------------------------------------------------------------------- */

export const AgentMode = {
  /** buildspec.md §7.2's example value: the agent may propose writes for confirmation. */
  ASSIST: "assist",
  /** Read-only answers; no proposals. */
  READ_ONLY: "read_only",
  /** No agent at all; the app stays fully usable (buildspec.md §1.9). */
  OFF: "off",
} as const;

export type AgentMode = (typeof AgentMode)[keyof typeof AgentMode];

export type ExtractionRoleConfig = {
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  /** The exact model id. Never a `latest` tag, never resolved from the agent configuration. */
  readonly model: string;
  readonly modelLocked: boolean;
  readonly numCtx: number;
  readonly temperature: number;
  readonly numPredict: number;
  readonly maxConcurrency: number;
  readonly timeoutSeconds: number;
  /** buildspec.md §7.3: "Disable thinking when supported and verified for the model/server". */
  readonly disableThinking: boolean;
  readonly allowPlaintextHttp: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly configLabel: string;
  readonly apiKey?: string | undefined;
};

export type AgentRoleConfig = {
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  /** buildspec.md §7.2: the agent model is selectable, so it may legitimately be unset. */
  readonly model: string | null;
  readonly numCtx: number;
  readonly temperature: number;
  readonly mode: AgentMode;
  readonly maxToolSteps: number;
  readonly allowPlaintextHttp: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly configLabel: string;
  readonly apiKey?: string | undefined;
};

export type ModelRolesConfig = {
  readonly extraction: ExtractionRoleConfig;
  readonly agent: AgentRoleConfig;
};

/** The tuning values of buildspec.md §7.2's `extraction` block, minus the deployment-specific ones. */
export const EXTRACTION_DEFAULTS = Object.freeze({
  modelLocked: true,
  numCtx: 4096,
  temperature: 0,
  numPredict: 512,
  maxConcurrency: 1,
  timeoutSeconds: 120,
  disableThinking: true,
});

const MIN_NUM_PREDICT = 64;
const MAX_NUM_PREDICT = 4096;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 600;

/**
 * Enforces the non-negotiable rules of buildspec.md §1.2 on the configuration itself, so a bad
 * settings document fails at setup instead of quietly changing how money is extracted.
 */
export function assertExtractionRoleConfig(config: ExtractionRoleConfig): void {
  const fail = (message: string): never => {
    throw validationError(message, { role: "extraction" });
  };

  if (!isProviderKind(config.provider)) fail(`Unknown provider kind '${String(config.provider)}'`);
  if (config.model.trim().length === 0) fail("The extraction model id must be set explicitly");
  if (/(^|:)latest$/i.test(config.model)) {
    // buildspec.md §7.2: "Do not use `latest`".
    fail(`'${config.model}' is a moving tag; the extractor must name an exact model`);
  }
  if (!config.modelLocked) fail("model_locked must be true for the extraction role (buildspec §1.2)");
  if (config.temperature !== 0) {
    fail(`The extractor must run at temperature 0, got ${config.temperature}`);
  }
  if (config.maxConcurrency !== 1) {
    fail(`The extraction queue is single-slot; max_concurrency must be 1, got ${config.maxConcurrency}`);
  }
  if (!Number.isInteger(config.numPredict) || config.numPredict < MIN_NUM_PREDICT || config.numPredict > MAX_NUM_PREDICT) {
    fail(`num_predict must be an integer between ${MIN_NUM_PREDICT} and ${MAX_NUM_PREDICT}`);
  }
  if (!Number.isInteger(config.numCtx) || config.numCtx < config.numPredict + 256) {
    fail("num_ctx must leave room for the prompt as well as the answer");
  }
  if (
    !Number.isFinite(config.timeoutSeconds) ||
    config.timeoutSeconds < MIN_TIMEOUT_SECONDS ||
    config.timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    fail(`timeout_seconds must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}`);
  }
}

export function assertModelRolesConfig(config: ModelRolesConfig): void {
  assertExtractionRoleConfig(config.extraction);
  if (!isProviderKind(config.agent.provider)) {
    throw validationError(`Unknown provider kind '${String(config.agent.provider)}'`, { role: "agent" });
  }
  if (!(Object.values(AgentMode) as string[]).includes(config.agent.mode)) {
    throw validationError(`Unknown agent mode '${config.agent.mode}'`, { role: "agent" });
  }
  if (config.agent.model !== null && config.agent.model === config.extraction.model) {
    /*
     * Not fatal — the owner may genuinely have only one model on one host — but it must be a
     * deliberate choice, because buildspec.md §1.2 forbids the chat model *silently* becoming the
     * extractor. The extraction client still verifies its own model id on every call.
     */
    return;
  }
}

/* --------------------------------------------------------------------------------------------- */
/* Call records                                                                                    */
/* --------------------------------------------------------------------------------------------- */

export type ModelIdentity = {
  readonly id: string;
  readonly digest: string | null;
  readonly quantization: string | null;
  readonly parameterCount: number | null;
  readonly serverContextTokens: number | null;
  readonly providerKind: ProviderKind;
  readonly endpointOrigin: string;
  readonly verifiedAt: Instant;
};

/**
 * buildspec.md §7.2: "Save its digest and parser/prompt version with each extraction."
 * buildspec.md §16's normalized event carries `parser_version` and `model_digest`; this record is
 * what fills them, plus the latency/token figures buildspec.md §22 asks to be benchmarked.
 */
export type ModelCallRecord = {
  readonly modelRequested: string;
  readonly modelReported: string | null;
  readonly digest: string | null;
  readonly quantization: string | null;
  readonly parameterCount: number | null;
  readonly serverContextTokens: number | null;
  readonly serverFingerprint: string | null;
  readonly providerKind: ProviderKind;
  readonly endpointOrigin: string;
  readonly promptVersion: string;
  readonly schemaVersion: number;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly finishReason: string | null;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly queuedMs: number;
  readonly startedAt: Instant;
  readonly truncated: boolean;
  readonly reasoningDropped: boolean;
};

export const ExtractionFailure = {
  EMPTY_CONTENT: "empty_content",
  MALFORMED_JSON: "malformed_json",
  SCHEMA_INVALID: "schema_invalid",
  TRUNCATED: "truncated",
  TEXT_TOO_LONG: "text_too_long",
} as const;

export type ExtractionFailure = (typeof ExtractionFailure)[keyof typeof ExtractionFailure];

export type ExtractionOutcome =
  | { readonly status: "ok"; readonly payload: ExtractionPayload; readonly call: ModelCallRecord }
  | {
      readonly status: "review";
      readonly reason: ExtractionFailure;
      readonly detail: string;
      readonly call: ModelCallRecord | null;
    };

export type ExtractionRequest = {
  readonly sourceId: string;
  readonly text: string;
  readonly signal?: AbortSignal | undefined;
};

export type ExtractionClientDeps = {
  /** Injected in tests; otherwise built from the configuration. */
  readonly provider?: InferenceProvider | undefined;
  readonly clock?: Clock | undefined;
  readonly fetchImpl?: FetchLike | undefined;
};

export type ExtractionClient = {
  readonly config: ExtractionRoleConfig;
  readonly provider: InferenceProvider;
  /** Resolves and caches the locked model's identity. Throws if the host does not have it. */
  verifyModel(signal?: AbortSignal): Promise<ModelIdentity>;
  extract(request: ExtractionRequest): Promise<ExtractionOutcome>;
  /** Number of requests currently queued or running. The queue is single-slot by contract. */
  queueDepth(): number;
};

/*
 * A crude character budget rather than a tokenizer: the extractor must never silently truncate a
 * message (buildspec.md §7.3, "do not silently truncate away amounts"), so this only has to be
 * conservative enough to route an oversized body to review instead of to the model.
 */
const CHARS_PER_TOKEN_ESTIMATE = 2.5;
const PROMPT_OVERHEAD_TOKENS = 260;

export function maxSourceCharsFor(config: ExtractionRoleConfig): number {
  const budget = config.numCtx - config.numPredict - PROMPT_OVERHEAD_TOKENS;
  return Math.max(200, Math.floor(budget * CHARS_PER_TOKEN_ESTIMATE));
}

/* --------------------------------------------------------------------------------------------- */
/* Client                                                                                          */
/* --------------------------------------------------------------------------------------------- */

export function createExtractionClient(
  config: ExtractionRoleConfig,
  deps: ExtractionClientDeps = {},
): ExtractionClient {
  assertExtractionRoleConfig(config);

  const provider =
    deps.provider ??
    createProvider({
      kind: config.provider,
      baseUrl: config.baseUrl,
      allowPlaintextHttp: config.allowPlaintextHttp,
      allowPrivateNetwork: config.allowPrivateNetwork,
      configLabel: config.configLabel,
      readTimeoutMs: config.timeoutSeconds * 1000,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

  const clock = deps.clock ?? systemClock(() => SUGGESTED_DEFAULT_ZONE);
  const timeoutMs = config.timeoutSeconds * 1000;
  const maxChars = maxSourceCharsFor(config);

  let identity: ModelIdentity | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let depth = 0;

  /**
   * buildspec.md §7.2: `max_concurrency: 1`. On a phone, two simultaneous loads of even a 0.8B
   * model make the device unusable (buildspec.md §18), so calls are serialised here rather than
   * relying on the server to queue them.
   */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    depth += 1;
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      depth -= 1;
    });
  }

  async function resolveIdentity(signal?: AbortSignal): Promise<ModelIdentity> {
    if (identity) return identity;

    const models = await provider.listModels(signal);
    const found: ModelInfo | undefined = models.find(
      (model) => model.id === config.model || model.aliases.includes(config.model),
    );
    if (!found) {
      /*
       * buildspec.md §7.2: "`qwen3.5:0.8b` is listed by Ollama, but verify that the exact endpoint
       * actually has it." and "Do not ... download another model automatically, or fall back to the
       * agent model." Picking the single available model here would be exactly that fallback.
       */
      throw modelUnavailable(
        `The endpoint does not serve the locked extraction model '${config.model}'. ` +
          `It offers: ${models.map((model) => model.id).join(", ") || "(nothing)"}. ` +
          "The extractor never substitutes another model.",
        { model: config.model, origin: provider.policy.origin },
      );
    }

    if (found.contextTokens !== null && found.contextTokens < config.numCtx) {
      throw modelUnavailable(
        `The endpoint serves '${config.model}' with a ${found.contextTokens}-token context, ` +
          `below the configured num_ctx of ${config.numCtx}`,
        { model: config.model },
      );
    }

    identity = {
      id: found.id,
      digest: found.digest,
      quantization: found.quantization,
      parameterCount: found.parameterCount,
      serverContextTokens: found.contextTokens,
      providerKind: provider.kind,
      endpointOrigin: provider.policy.origin,
      verifiedAt: clock.now(),
    };
    return identity;
  }

  async function callOnce(
    request: ExtractionRequest,
    known: ModelIdentity,
    attempt: number,
    queuedMs: number,
  ): Promise<{ outcome: ExtractionOutcome; retryable: boolean }> {
    const startedAt = clock.now();
    const result = await provider.chatJson({
      model: config.model,
      messages: buildExtractionMessages(request.sourceId, request.text),
      schema: EXTRACTION_JSON_SCHEMA,
      schemaName: EXTRACTION_SCHEMA_NAME,
      temperature: config.temperature,
      maxOutputTokens: config.numPredict,
      contextTokens: config.numCtx,
      disableThinking: config.disableThinking,
      timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    /*
     * buildspec.md §1.2/§7.2: refuse a silent substitution. A host that answered with a different
     * model has not produced an extraction this app is allowed to trust, so this is a configuration
     * failure rather than a message that needs review.
     */
    if (result.modelReported !== null && result.modelReported !== config.model) {
      throw modelUnavailable(
        `The endpoint answered with model '${result.modelReported}' but the extractor is locked to ` +
          `'${config.model}'. Refusing the result.`,
        { requested: config.model, reported: result.modelReported },
      );
    }

    const call: ModelCallRecord = {
      modelRequested: config.model,
      modelReported: result.modelReported,
      digest: known.digest,
      quantization: known.quantization,
      parameterCount: known.parameterCount,
      serverContextTokens: known.serverContextTokens,
      serverFingerprint: result.serverFingerprint,
      providerKind: provider.kind,
      endpointOrigin: provider.policy.origin,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      temperature: config.temperature,
      maxOutputTokens: config.numPredict,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      finishReason: result.finishReason,
      attempts: attempt,
      latencyMs: result.latencyMs,
      queuedMs,
      startedAt,
      truncated: result.truncated,
      reasoningDropped: result.reasoningDropped,
    };

    if (result.truncated) {
      // Retrying at temperature 0 reproduces the same truncation, so this goes straight to review.
      return {
        outcome: {
          status: "review",
          reason: ExtractionFailure.TRUNCATED,
          detail: `Generation stopped at the ${config.numPredict}-token budget; the JSON is incomplete`,
          call,
        },
        retryable: false,
      };
    }
    if (result.content.trim().length === 0) {
      return {
        outcome: {
          status: "review",
          reason: ExtractionFailure.EMPTY_CONTENT,
          detail: "The endpoint returned no message content",
          call,
        },
        retryable: true,
      };
    }
    if (result.jsonParseError !== null) {
      return {
        outcome: {
          status: "review",
          reason: ExtractionFailure.MALFORMED_JSON,
          detail: result.jsonParseError,
          call,
        },
        retryable: true,
      };
    }

    const parsed = parseExtractionPayload(result.json);
    if (!parsed.ok) {
      return {
        outcome: {
          status: "review",
          reason: ExtractionFailure.SCHEMA_INVALID,
          detail: parsed.problems.join("; "),
          call,
        },
        retryable: true,
      };
    }

    return { outcome: { status: "ok", payload: parsed.payload, call }, retryable: false };
  }

  return Object.freeze({
    config,
    provider,

    verifyModel(signal?: AbortSignal): Promise<ModelIdentity> {
      return enqueue(() => resolveIdentity(signal));
    },

    queueDepth(): number {
      return depth;
    },

    extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
      const queuedAt = clock.now();
      return enqueue(async () => {
        const queuedMs = clock.now() - queuedAt;

        if (request.text.length > maxChars) {
          // buildspec.md §7.3: never silently truncate away amounts; split upstream or review.
          return {
            status: "review",
            reason: ExtractionFailure.TEXT_TOO_LONG,
            detail:
              `The message is ${request.text.length} characters, over the ${maxChars}-character ` +
              `budget for a ${config.numCtx}-token context. Split it at a message section instead.`,
            call: null,
          } satisfies ExtractionOutcome;
        }

        const known = await resolveIdentity(request.signal);

        // buildspec.md §7.3: "After one bounded retry for malformed output, move the item to review."
        let last = await callOnce(request, known, 1, queuedMs);
        if (last.retryable) {
          last = await callOnce(request, known, 2, queuedMs);
        }
        return last.outcome;
      });
    },
  });
}

/** True when an error means "this endpoint cannot serve the locked extractor", not "retry later". */
export function isModelUnavailable(error: unknown): error is FinanceError {
  return error instanceof FinanceError && error.code === FinanceErrorCode.MODEL_UNAVAILABLE;
}
