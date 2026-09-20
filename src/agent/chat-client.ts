import { createEndpointPolicy, requestJson } from "../extraction/endpoint-policy.ts";
import type { FetchLike } from "../extraction/endpoint-policy.ts";
import { ProviderKind, providerPaths } from "../extraction/provider.ts";
import type { ToolDefinition } from "./tools.ts";

/**
 * Tool-calling chat against the owner's *agent* endpoint.
 *
 * buildspec.md §14.1 keeps this configuration separate from the extractor's, and §18 sends every
 * outbound call through the endpoint policy: one allowlisted path, no redirects, capped response
 * size, hard deadline. This client can reach `<base>/api/chat` (or `/chat/completions`) and
 * nothing else on that host.
 *
 * Both wire formats are normalised to one shape so the loop above never cares which server it is
 * talking to.
 */

export type ToolCall = { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> };

export type ChatTurn =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] | undefined }
  | { readonly role: "tool"; readonly toolCallId: string; readonly name: string; readonly content: string };

export type ChatCompletion = {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly latencyMs: number;
};

export type AgentEndpoint = {
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly digest: string | null;
};

export class ChatClientError extends Error {
  readonly kind: "unreachable" | "no_tools" | "bad_response" | "aborted";
  constructor(kind: ChatClientError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return record(JSON.parse(raw)) ?? {};
    } catch {
      return {};
    }
  }
  return record(raw) ?? {};
}

/**
 * Small models sometimes write the call into the text instead of the structured field. Qwen's
 * template uses `<tool_call>{...}</tool_call>`; recognise exactly that and nothing looser, so
 * ordinary prose that happens to contain JSON is never executed.
 */
function toolCallsFromText(content: string, known: ReadonlySet<string>): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const rest = content.replace(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g, (whole, json: string) => {
    try {
      const parsed = record(JSON.parse(json));
      const name = parsed && typeof parsed.name === "string" ? parsed.name : null;
      if (name && known.has(name)) {
        calls.push({ id: `text_${calls.length}`, name, arguments: parseArguments(parsed!.arguments ?? parsed!.parameters) });
        return "";
      }
    } catch {
      // Not a call; leave the text alone.
    }
    return whole;
  });
  return { calls, rest: rest.trim() };
}

/** Thinking models may leak their scratchpad; the owner should never see it (§14.1). */
const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();

export function createChatClient(endpoint: AgentEndpoint, options: { fetchImpl?: FetchLike } = {}) {
  const basePath = new URL(endpoint.baseUrl).pathname.replace(/\/+$/, "");
  const chatPath = providerPaths(endpoint.provider, basePath).chat;
  const policy = createEndpointPolicy({
    baseUrl: endpoint.baseUrl,
    allowedPaths: [chatPath],
    // The owner typed this address into Settings; §18 allows a private host on that condition.
    allowPlaintextHttp: true,
    allowPrivateNetwork: true,
    // A large local model can take a while to load into memory on first use.
    connectTimeoutMs: 10_000,
    readTimeoutMs: 240_000,
    maxResponseBytes: 512_000,
    configLabel: "assistant-lan",
  });
  const isOllama = endpoint.provider === ProviderKind.OLLAMA_NATIVE;

  function wireMessages(turns: readonly ChatTurn[]): unknown[] {
    return turns.map((turn) => {
      if (turn.role === "tool") {
        return isOllama
          ? { role: "tool", content: turn.content, tool_name: turn.name }
          : { role: "tool", content: turn.content, tool_call_id: turn.toolCallId };
      }
      if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: turn.content,
          tool_calls: turn.toolCalls.map((call) =>
            isOllama
              ? { function: { name: call.name, arguments: call.arguments } }
              : { id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
          ),
        };
      }
      return { role: turn.role, content: turn.content };
    });
  }

  function body(turns: readonly ChatTurn[], tools: readonly ToolDefinition[], withThinkSwitch: boolean) {
    const wireTools = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    if (isOllama) {
      return {
        model: endpoint.model,
        messages: wireMessages(turns),
        ...(wireTools.length > 0 ? { tools: wireTools } : {}),
        stream: false,
        ...(withThinkSwitch ? { think: false } : {}),
        options: { temperature: 0.2, num_predict: 1024, num_ctx: 8192 },
      };
    }
    return {
      model: endpoint.model,
      messages: wireMessages(turns),
      ...(wireTools.length > 0 ? { tools: wireTools, tool_choice: "auto" } : {}),
      stream: false,
      temperature: 0.2,
      max_tokens: 1024,
      ...(withThinkSwitch ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    };
  }

  async function complete(input: {
    turns: readonly ChatTurn[];
    tools: readonly ToolDefinition[];
    signal?: AbortSignal | undefined;
  }): Promise<ChatCompletion> {
    const known = new Set(input.tools.map((tool) => tool.name));

    const send = async (withThinkSwitch: boolean) => {
      try {
        return await requestJson(policy, {
          path: chatPath,
          method: "POST",
          body: body(input.turns, input.tools, withThinkSwitch),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
      } catch (error) {
        if (input.signal?.aborted) throw new ChatClientError("aborted", "Stopped.");
        throw new ChatClientError("unreachable", `The assistant model did not answer (${error instanceof Error ? error.message : "network error"}).`);
      }
    };

    let response = await send(true);
    // Some servers reject a thinking switch the model does not have. Ask again without it.
    if (!response.ok && /think/i.test(response.text)) response = await send(false);

    if (!response.ok) {
      if (/does not support tools|tool.*not supported/i.test(response.text)) {
        throw new ChatClientError("no_tools", `The model '${endpoint.model}' cannot call tools. Choose a tool-capable model in Settings → Assistant model.`);
      }
      if (response.status === 404) {
        throw new ChatClientError("unreachable", `The model '${endpoint.model}' was not found on the server. Check Settings → Assistant model.`);
      }
      throw new ChatClientError("bad_response", `The model server answered ${response.status}.`);
    }

    const root = record(response.json);
    const message = isOllama ? record(root?.message) : record(record((root?.choices as unknown[] | undefined)?.[0])?.message);
    if (!message) throw new ChatClientError("bad_response", "The model server sent a reply this app could not read.");

    const structured: ToolCall[] = [];
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    rawCalls.forEach((raw, index) => {
      const call = record(raw);
      const fn = record(call?.function);
      if (!fn || typeof fn.name !== "string") return;
      structured.push({
        id: typeof call?.id === "string" ? call.id : `call_${index}`,
        name: fn.name,
        arguments: parseArguments(fn.arguments),
      });
    });

    const text = stripThinking(typeof message.content === "string" ? message.content : "");
    if (structured.length > 0) return { content: text, toolCalls: structured, latencyMs: response.latencyMs };

    const fromText = toolCallsFromText(text, known);
    return { content: fromText.rest, toolCalls: fromText.calls, latencyMs: response.latencyMs };
  }

  return { complete, endpoint };
}

export type ChatClient = ReturnType<typeof createChatClient>;
