import { GatewayError } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  FinishReason,
  ReasoningBlock,
  StreamEvent,
  TextBlock,
  ToolCallBlock,
  Usage
} from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, mapOpenRouterParams, pruneUndefined } from "./shared.js";

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  content_filter: "content_filter"
};

type WireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek's cache-hit counter. */
  prompt_cache_hit_tokens?: number;
};

type WirePayload = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
};

type StreamChunk = {
  id?: string;
  usage?: WireUsage | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
};

function decodeUsage(usage: WireUsage | null | undefined): Usage {
  return pruneUndefined({
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens
  });
}

function encodeMessages(model: ResolvedModel, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
    } else if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    } else if (message.role === "user") {
      out.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((block) =>
                block.type === "text"
                  ? { type: "text", text: block.text }
                  : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
              )
      });
    } else if (typeof message.content === "string") {
      out.push({ role: "assistant", content: message.content });
    } else {
      // Text blocks are joined into the single wire `content` string; text/toolCall
      // interleaving cannot be represented on this wire and is intentionally lost.
      const text = message.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
      const reasoning = message.content.filter((b): b is ReasoningBlock => b.type === "reasoning").map((b) => b.text).join("");
      const toolCalls = message.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
      out.push(
        pruneUndefined({
          role: "assistant",
          // content:null is only valid alongside tool_calls; otherwise the wire requires a string
          content: text !== "" ? text : toolCalls.length ? null : "",
          tool_calls: toolCalls.length
            ? toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }))
            : undefined,
          reasoning_content: reasoning !== "" && model.features.reasoningRoundTrip ? reasoning : undefined
        })
      );
    }
  }
  return out;
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  const mapped = model.providerId === "openrouter" ? mapOpenRouterParams(model, request.effectiveParams) : mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { model: model.modelId, ...mapped.wire };
  body.messages = encodeMessages(model, request.messages);
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: pruneUndefined({ name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict })
    }));
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice =
      typeof request.toolChoice === "object" ? { type: "function", function: { name: request.toolChoice.name } } : request.toolChoice;
  }
  if (request.responseFormat) {
    body.response_format =
      request.responseFormat.type === "json_object"
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: pruneUndefined({
              name: request.responseFormat.name ?? "response",
              schema: request.responseFormat.schema,
              strict: request.responseFormat.strict
            })
          };
  }
  if (request.stream) {
    body.stream = true;
    if (model.features.streamingUsage) body.stream_options = { include_usage: true };
  }
  applyPassthrough(body, request.passthrough, warnings);
  return { url: buildUrl(model, request.stream), headers: authHeaders(model, apiKey), body: pruneUndefined(body), warnings };
}

function decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse {
  const wire = payload as WirePayload;
  // n>1 is not part of the unified API; only the first choice is surfaced
  const choice = wire.choices?.[0];
  if (!choice) {
    throw new GatewayError("server", `${model.providerId} response has no choices`, { provider: model.providerId, raw: payload });
  }
  const message = choice.message ?? {};
  const content: ContentBlock[] = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content !== "") {
    content.push({ type: "reasoning", text: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content !== "") {
    content.push({ type: "text", text: message.content });
  }
  (message.tool_calls ?? []).forEach((call, index) => {
    content.push({ type: "toolCall", id: call.id ?? `call_${index}`, name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" });
  });
  return {
    id: wire.id ?? "",
    provider: model.providerId,
    model: model.modelId,
    content,
    finishReason: FINISH_REASONS[choice.finish_reason ?? ""] ?? "error",
    usage: decodeUsage(wire.usage),
    warnings: []
  };
}

async function* decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
  let id = "";
  let finishReason: FinishReason = "error";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let text = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for await (const event of events) {
    if (event.data === "[DONE]") break;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(event.data);
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} sent a malformed SSE chunk`, { provider: model.providerId, raw: event.data, cause });
    }
    if (chunk.id) id = chunk.id;
    if (chunk.usage) {
      usage = decodeUsage(chunk.usage);
      yield { type: "usage", usage };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = FINISH_REASONS[choice.finish_reason] ?? "error";
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      reasoning += delta.reasoning_content;
      yield { type: "reasoning-delta", text: delta.reasoning_content };
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      text += delta.content;
      yield { type: "text-delta", text: delta.content };
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      while (toolCalls.length <= index) toolCalls.push({ id: "", name: "", arguments: "" });
      const entry = toolCalls[index]!;
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
      const argumentsDelta = call.function?.arguments ?? "";
      entry.arguments += argumentsDelta;
      yield {
        type: "tool-call-delta",
        index,
        ...(call.id !== undefined ? { id: call.id } : {}),
        ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
        argumentsDelta
      };
    }
  }

  const content: ContentBlock[] = [];
  if (reasoning !== "") content.push({ type: "reasoning", text: reasoning });
  if (text !== "") content.push({ type: "text", text });
  toolCalls.forEach((call, index) => {
    content.push({ type: "toolCall", id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || "{}" });
  });
  yield {
    type: "done",
    response: { id, provider: model.providerId, model: model.modelId, content, finishReason, usage, warnings: [] }
  };
}

export const openaiChatCodec: Codec = { wire: "openai-chat", encode, decodeResponse, decodeStream };
