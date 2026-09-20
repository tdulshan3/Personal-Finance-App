import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { FinanceErrorCode, isFinanceError } from "../core/domain/errors.ts";
import type { FetchLike } from "./endpoint-policy.ts";
import {
  buildOllamaChatBody,
  buildOpenAiChatBody,
  createOllamaNativeProvider,
  createOpenAiCompatibleProvider,
  createProvider,
  detectProvider,
  parseOllamaChatResponse,
  parseOpenAiChatResponse,
  providerPaths,
  ProviderKind,
  type ChatJsonRequest,
} from "./provider.ts";
import { EXTRACTION_JSON_SCHEMA, EXTRACTION_SCHEMA_NAME } from "./schema.ts";

const LAN = {
  baseUrl: "http://192.168.1.118:8081/v1",
  allowPlaintextHttp: true,
  allowPrivateNetwork: true,
  configLabel: "development-lan",
};

/** The exact `/v1/models` body this deployment's llama.cpp build returns, trimmed to one model. */
const LLAMA_CPP_MODELS = {
  models: [
    {
      name: "qwen3.5-0.8b",
      model: "qwen3.5-0.8b",
      digest: "",
      type: "model",
      capabilities: ["completion"],
      details: { format: "gguf", quantization_level: "" },
    },
  ],
  object: "list",
  data: [
    {
      id: "qwen3.5-0.8b",
      aliases: ["qwen3.5-0.8b"],
      object: "model",
      created: 1789907327,
      owned_by: "llamacpp",
      meta: { n_vocab: 248320, n_ctx: 65536, n_params: 752393024, size: 496192768, ftype: "Q4_0" },
    },
  ],
};

const OLLAMA_TAGS = {
  models: [
    {
      name: "qwen3.5:0.8b",
      model: "qwen3.5:0.8b",
      size: 552000000,
      digest: "8f1bcd2e77aa11223344556677889900aabbccddeeff00112233445566778899",
      details: { format: "gguf", parameter_size: "0.8B", quantization_level: "Q4_0" },
    },
  ],
};

function routedFetch(routes: Record<string, () => Response>): FetchLike {
  return async (input) => {
    const path = new URL(input).pathname;
    const handler = routes[path];
    if (!handler) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return handler();
  };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const CHAT_REQUEST: ChatJsonRequest = {
  model: "qwen3.5-0.8b",
  messages: [
    { role: "system", content: "instruction" },
    { role: "user", content: "source_id: src_1" },
  ],
  schema: EXTRACTION_JSON_SCHEMA,
  schemaName: EXTRACTION_SCHEMA_NAME,
  temperature: 0,
  maxOutputTokens: 512,
  contextTokens: 4096,
  disableThinking: true,
};

describe("path derivation", () => {
  test("openai-compatible keeps /health and /props at the root, not under /v1", () => {
    assert.deepEqual(providerPaths(ProviderKind.OPENAI_COMPATIBLE, "/v1"), {
      models: "/v1/models",
      chat: "/v1/chat/completions",
      health: "/health",
      props: "/props",
    });
  });

  test("ollama-native uses buildspec §7.2's own paths", () => {
    assert.deepEqual(providerPaths(ProviderKind.OLLAMA_NATIVE, ""), {
      models: "/api/tags",
      chat: "/api/chat",
      health: "/api/version",
      props: null,
    });
  });

  test("a provider can only reach the paths it declared", () => {
    const provider = createProvider({ kind: ProviderKind.OPENAI_COMPATIBLE, ...LAN });
    assert.deepEqual([...provider.policy.allowedPaths].sort(), [
      "/health",
      "/props",
      "/v1/chat/completions",
      "/v1/models",
    ]);
  });
});

describe("openai-compatible provider", () => {
  test("merges llama.cpp's two model lists into one record", async () => {
    const provider = createOpenAiCompatibleProvider({
      ...LAN,
      fetchImpl: routedFetch({ "/v1/models": () => json(LLAMA_CPP_MODELS) }),
    });
    const models = await provider.listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0]?.id, "qwen3.5-0.8b");
    assert.equal(models[0]?.contextTokens, 65536);
    assert.equal(models[0]?.parameterCount, 752393024);
    assert.equal(models[0]?.quantization, "Q4_0");
    assert.deepEqual(models[0]?.aliases, ["qwen3.5-0.8b"]);
  });

  test("builds a structured-output request with the schema, temperature 0 and no streaming", () => {
    const body = buildOpenAiChatBody(CHAT_REQUEST) as Record<string, unknown>;
    assert.equal(body["model"], "qwen3.5-0.8b");
    assert.equal(body["temperature"], 0);
    assert.equal(body["max_tokens"], 512);
    assert.equal(body["stream"], false);
    const format = body["response_format"] as Record<string, unknown>;
    assert.equal(format["type"], "json_schema");
    const jsonSchema = format["json_schema"] as Record<string, unknown>;
    assert.equal(jsonSchema["name"], EXTRACTION_SCHEMA_NAME);
    assert.equal(jsonSchema["strict"], true);
    assert.equal(jsonSchema["schema"], EXTRACTION_JSON_SCHEMA);
    // buildspec.md §7.3: thinking off. Verified against this host's Qwen chat template.
    assert.deepEqual(body["chat_template_kwargs"], { enable_thinking: false });
  });

  test("omits the thinking switch when it was not requested", () => {
    const body = buildOpenAiChatBody({ ...CHAT_REQUEST, disableThinking: false });
    assert.equal("chat_template_kwargs" in body, false);
  });

  test("discards hidden reasoning instead of returning it", () => {
    const result = parseOpenAiChatResponse(
      {
        model: "qwen3.5-0.8b",
        system_fingerprint: "b0-unknown",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: '{"schema_version":1,"source_id":"src_1","events":[]}',
              reasoning_content: "Thinking Process: the user wants...",
            },
          },
        ],
        usage: { prompt_tokens: 121, completion_tokens: 168 },
      },
      42,
    );
    assert.equal(result.reasoningDropped, true);
    assert.ok(!result.content.includes("Thinking Process"));
    assert.deepEqual(result.json, { schema_version: 1, source_id: "src_1", events: [] });
    assert.equal(result.modelReported, "qwen3.5-0.8b");
    assert.equal(result.serverFingerprint, "b0-unknown");
    assert.equal(result.promptTokens, 121);
    assert.equal(result.truncated, false);
  });

  test("reports truncation when the token budget ran out", () => {
    const result = parseOpenAiChatResponse(
      { model: "qwen3.5-0.8b", choices: [{ finish_reason: "length", message: { content: '{"schema' } }] },
      10,
    );
    assert.equal(result.truncated, true);
    assert.ok(result.jsonParseError);
  });

  test("turns a non-2xx answer into MODEL_UNAVAILABLE rather than a generic throw", async () => {
    const provider = createOpenAiCompatibleProvider({
      ...LAN,
      fetchImpl: routedFetch({}),
    });
    await assert.rejects(
      () => provider.listModels(),
      (error: unknown) => isFinanceError(error) && error.code === FinanceErrorCode.MODEL_UNAVAILABLE,
    );
  });

  test("reads the health endpoint at the server root", async () => {
    let seen = "";
    const provider = createOpenAiCompatibleProvider({
      ...LAN,
      fetchImpl: async (input) => {
        seen = new URL(input).pathname;
        return json({ status: "ok" }, { server: "llama.cpp" });
      },
    });
    const health = await provider.health();
    assert.equal(seen, "/health");
    assert.equal(health.ok, true);
    assert.equal(health.detail, "ok");
    assert.equal(health.serverHeader, "llama.cpp");
  });
});

describe("ollama-native provider", () => {
  test("parses /api/tags and keeps the digest", async () => {
    const provider = createOllamaNativeProvider({
      ...LAN,
      baseUrl: "http://192.168.1.118:11434",
      fetchImpl: routedFetch({ "/api/tags": () => json(OLLAMA_TAGS) }),
    });
    const models = await provider.listModels();
    assert.equal(models[0]?.id, "qwen3.5:0.8b");
    assert.equal(models[0]?.digest?.slice(0, 8), "8f1bcd2e");
    assert.equal(models[0]?.parameterCount, 800000000);
    assert.equal(models[0]?.quantization, "Q4_0");
  });

  test("puts the schema in `format` and the tuning in `options`, as buildspec §7.2 describes", () => {
    const body = buildOllamaChatBody(CHAT_REQUEST) as Record<string, unknown>;
    assert.equal(body["format"], EXTRACTION_JSON_SCHEMA);
    assert.equal(body["stream"], false);
    assert.equal(body["think"], false);
    assert.deepEqual(body["options"], { temperature: 0, num_predict: 512, num_ctx: 4096 });
    assert.equal("response_format" in body, false);
  });

  test("discards Ollama's `thinking` field too", () => {
    const result = parseOllamaChatResponse(
      {
        model: "qwen3.5:0.8b",
        done_reason: "stop",
        message: { role: "assistant", content: "{}", thinking: "hidden" },
        prompt_eval_count: 100,
        eval_count: 40,
      },
      7,
    );
    assert.equal(result.reasoningDropped, true);
    assert.equal(result.completionTokens, 40);
    assert.equal(result.truncated, false);
  });
});

describe("detectProvider", () => {
  test("identifies a llama.cpp host and reports the working base URL", async () => {
    const detection = await detectProvider("http://192.168.1.118:8081/v1", {
      allowPlaintextHttp: true,
      allowPrivateNetwork: true,
      fetchImpl: routedFetch({
        "/v1/models": () => json(LLAMA_CPP_MODELS, { server: "llama.cpp" }),
      }),
    });
    assert.equal(detection.kind, ProviderKind.OPENAI_COMPATIBLE);
    assert.equal(detection.baseUrl, "http://192.168.1.118:8081/v1");
    assert.deepEqual([...detection.modelIds], ["qwen3.5-0.8b"]);
    assert.equal(detection.serverHeader, "llama.cpp");
  });

  test("corrects a base URL that is missing the /v1 an OpenAI-compatible host needs", async () => {
    // buildspec.md §7.2 says to store the base URL *without* `/v1`, which is wrong for llama.cpp.
    const detection = await detectProvider("http://192.168.1.118:8081", {
      allowPlaintextHttp: true,
      allowPrivateNetwork: true,
      fetchImpl: routedFetch({ "/v1/models": () => json(LLAMA_CPP_MODELS) }),
    });
    assert.equal(detection.kind, ProviderKind.OPENAI_COMPATIBLE);
    assert.equal(detection.baseUrl, "http://192.168.1.118:8081/v1");
  });

  test("identifies a native Ollama host", async () => {
    const detection = await detectProvider("http://192.168.1.118:11434", {
      allowPlaintextHttp: true,
      allowPrivateNetwork: true,
      fetchImpl: routedFetch({ "/api/tags": () => json(OLLAMA_TAGS) }),
    });
    assert.equal(detection.kind, ProviderKind.OLLAMA_NATIVE);
    assert.deepEqual([...detection.modelIds], ["qwen3.5:0.8b"]);
  });

  test("explains what it probed when nothing answers, instead of a bare 404", async () => {
    await assert.rejects(
      () =>
        detectProvider("http://192.168.1.118:8081/v1", {
          allowPlaintextHttp: true,
          allowPrivateNetwork: true,
          fetchImpl: routedFetch({}),
        }),
      (error: unknown) => {
        assert.ok(isFinanceError(error));
        assert.equal(error.code, FinanceErrorCode.MODEL_UNAVAILABLE);
        assert.match(error.message, /\/v1\/models -> HTTP 404/);
        assert.match(error.message, /\/api\/tags -> HTTP 404/);
        assert.match(error.message, /ending in '\/v1'/);
        return true;
      },
    );
  });

  test("never probes a host outside the configured origin", async () => {
    const seen: string[] = [];
    await assert.rejects(() =>
      detectProvider("http://192.168.1.118:8081/v1", {
        allowPlaintextHttp: true,
        allowPrivateNetwork: true,
        fetchImpl: async (input) => {
          seen.push(input);
          return new Response("{}", { status: 404 });
        },
      }),
    );
    assert.ok(seen.length > 0);
    assert.ok(seen.every((url) => url.startsWith("http://192.168.1.118:8081/")), seen.join(", "));
  });
});
