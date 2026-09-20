# 0005 — llama.cpp's OpenAI-compatible endpoint instead of Ollama's native API

- **Status:** Accepted
- **Date:** 2026-09-20
- **Supersedes:** `buildspec.md` §7.2 (and the `/api/chat` protocol details in §7.3)
- **Related:** [0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md)

## Context

`buildspec.md` §7.2 pins the extraction configuration to `"provider": "ollama"`, instructs us to
*"store the native Ollama base URL without appending `/v1`; use `/api/chat` and `/api/tags` for this
integration"*, and names the model `qwen3.5:0.8b` (Ollama tag syntax). §7.3 then describes the call
as `POST /api/chat` with `stream:false` and a schema in Ollama's `format` field.

The owner's actual inference host is **llama.cpp's server**, not Ollama:

- Base URL: `http://192.168.1.118:8081/v1`
- Model: `qwen3.5-0.8b`
- `/api/tags` and `/api/chat` **404** on that host. Ollama's native API is not there.

So §7.2 and the §7.3 transport details are wrong for this deployment. The *intent* of §7.2 — one
fixed, locked, low-temperature, bounded, single-concurrency extractor — is not.

## Decision

Talk to the extraction model over the **OpenAI-compatible API** that llama.cpp's server exposes.

| §7.2 field | Value here |
|---|---|
| `provider` | `llamacpp` (OpenAI-compatible) |
| `base_url` | `http://192.168.1.118:8081/v1` — the `/v1` **is** part of the base URL, contrary to §7.2 |
| `model` | `qwen3.5-0.8b` (hyphen, not Ollama's `qwen3.5:0.8b` colon tag) |
| `model_locked` | `true` — unchanged from §7.2 |
| chat call | `POST {base_url}/chat/completions`, `stream: false` |
| model listing | `GET {base_url}/models` — replaces `/api/tags` |
| structured output | `response_format: { type: "json_schema", json_schema: { …, strict: true } }` — replaces Ollama's `format` field |
| `temperature` | `0` |
| `max_tokens` | `512` (replaces `num_predict`) |
| context | `4096` — a server launch flag on the host, not a per-request option; there is no `num_ctx` in this API |
| `max_concurrency` | `1` |
| `timeout_seconds` | `120` |

Everything in §7.3 **above the transport layer is unchanged**: the extraction prompt verbatim, the
bounded schema with `additionalProperties:false` and finite enums, amounts returned as strings and
converted to minor units by application code, evidence validated against the source text, one
bounded retry then review, and `source_id` supplied by the controller and never taken from model
output. §7.4's review policy is untouched — model-derived financial entries still require review.

Per-extraction provenance records `model` and `server version` (from `GET {base_url}/models` and the
server's own build info) in place of §7.2's Ollama digest. **llama.cpp does not expose an Ollama-style
model digest**, so "save its digest" cannot be satisfied literally; the recorded identity is weaker
and a silently swapped GGUF on the host would not be detected. That is a real gap, not a solved one.

## Consequences

- **§18's endpoint controls apply harder, not less.** `http://192.168.1.118:8081` is plain HTTP on a
  private LAN address. §18 permits that only as "a specifically approved local/private host … in a
  clearly labeled development configuration". The client must remain a restricted client — fixed
  scheme, fixed host and port, fixed API paths, no redirects, bounded response size, bounded
  timeouts — and never a general URL fetcher.
- **Data leaves the phone.** §18 requires setup to say so plainly: every message sent for extraction
  crosses the LAN to a host the owner operates. The rules-only processing option must stay available.
- **The agent endpoint is still undecided.** §14.1 specifies `GET {agent_base_url}/api/tags` for the
  model dropdown, §14.1 also specifies Ollama native tool calling, and §16 maps
  `ModelService.listAgentModels` to `/api/tags`. If the agent also ends up on llama.cpp, those all
  need the same substitution (`/v1/models`, OpenAI `tools`), and llama.cpp's tool-calling support is
  model-dependent and weaker than Ollama's. **This is not decided yet and needs its own ADR before
  M6.**
- **Two provider shapes may coexist.** §7.2's "two separate model configurations with independent
  clients" now also means potentially two different *protocols*. The client abstraction has to carry
  a provider kind, and the extraction client must never be swapped for the agent client (§1 rule 2).
- **Benchmarks in §22 still have to be run against this endpoint.** The owner's reported ~10
  tokens/second is planning input only. Prompt-processing time, queue time, p50/p95 latency and
  valid-result rate are unmeasured. *Untested.*
- Model updates on the host still require fixture evaluation before acceptance (§7.2), and there is
  no digest to detect an unannounced one — so the host is trusted operationally.
