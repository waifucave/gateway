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
import { normalizeUsage } from "../client/usage.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, mapOpenRouterParams, pruneUndefined } from "./shared.js";

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  content_filter: "content_filter"
};

type WireUsage = {
  /** Total prompt tokens (cached included) on every OpenAI-compatible provider. */
  prompt_tokens?: number;
  /** Total completion tokens (reasoning included). */
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  /** OpenRouter adds cache_write_tokens next to OpenAI's cached_tokens. */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /** DeepSeek's cache-hit counter. */
  prompt_cache_hit_tokens?: number;
  /** Moonshot's cache-hit counter. */
  cached_tokens?: number;
  /** OpenRouter: USD charged for this generation. */
  cost?: number;
};

type ReasoningDetail = Record<string, unknown>;

type WirePayload = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      /** OpenRouter's normalized reasoning text. */
      reasoning?: string | null;
      /** OpenRouter's structured reasoning (text/summary/encrypted, with signatures). */
      reasoning_details?: ReasoningDetail[] | null;
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
      reasoning?: string | null;
      reasoning_details?: ReasoningDetail[] | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
};

function decodeUsage(usage: WireUsage | null | undefined): Usage {
  return normalizeUsage({
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? usage?.cached_tokens,
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens,
    costUsd: usage?.cost
  });
}

/** Readable text carried by reasoning_details when no plain `reasoning` string accompanies them. */
function detailsText(details: ReasoningDetail[]): string {
  return details
    .map((detail) => (typeof detail.text === "string" ? detail.text : typeof detail.summary === "string" ? detail.summary : ""))
    .join("");
}

/**
 * Merge streamed reasoning_details fragments: fragments sharing an `index`
 * (and type) belong to one detail — string payload fields concatenate,
 * everything else is last-write-wins. Fragments without an index append.
 */
function mergeDetails(into: ReasoningDetail[], fragments: ReasoningDetail[]): void {
  for (const fragment of fragments) {
    if (fragment === null || typeof fragment !== "object") continue;
    const existing =
      typeof fragment.index === "number"
        ? into.find((d) => d.index === fragment.index && (fragment.type === undefined || d.type === fragment.type))
        : undefined;
    if (!existing) {
      into.push({ ...fragment });
      continue;
    }
    for (const [key, value] of Object.entries(fragment)) {
      if (["text", "summary", "data", "signature"].includes(key) && typeof value === "string" && typeof existing[key] === "string") {
        existing[key] = (existing[key] as string) + value;
      } else if (value !== undefined && value !== null) {
        existing[key] = value;
      }
    }
  }
}

function reasoningBlock(text: string, details: ReasoningDetail[]): ReasoningBlock | undefined {
  if (text === "" && details.length === 0) return undefined;
  return details.length > 0 ? { type: "reasoning", text, details } : { type: "reasoning", text };
}

function encodeMessages(model: ResolvedModel, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const openrouter = model.providerId === "openrouter";
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
      const reasoningBlocks = message.content.filter((b): b is ReasoningBlock => b.type === "reasoning");
      const reasoning = reasoningBlocks.map((b) => b.text).join("");
      const details = reasoningBlocks.flatMap((b) => b.details ?? []);
      const toolCalls = message.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
      // OpenRouter: replay reasoning_details verbatim (carries Anthropic signatures /
      // Gemini thought signatures / OpenAI encrypted reasoning) on tool-call turns,
      // or on any turn when the family requires reasoning round-trip. Native
      // routes keep the DeepSeek-style reasoning_content field.
      const replay = toolCalls.length > 0 || model.features.reasoningRoundTrip === true;
      out.push(
        pruneUndefined({
          role: "assistant",
          // content:null is only valid alongside tool_calls; otherwise the wire requires a string
          content: text !== "" ? text : toolCalls.length ? null : "",
          tool_calls: toolCalls.length
            ? toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }))
            : undefined,
          reasoning_details: openrouter && replay && details.length > 0 ? details : undefined,
          reasoning:
            openrouter && details.length === 0 && reasoning !== "" && model.features.reasoningRoundTrip ? reasoning : undefined,
          reasoning_content: !openrouter && reasoning !== "" && model.features.reasoningRoundTrip ? reasoning : undefined
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
  applyPassthrough(body, request.passthrough, warnings, { wire: model.wire, provider: model.providerId });
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
  const details = Array.isArray(message.reasoning_details) ? message.reasoning_details.filter((d) => d !== null && typeof d === "object") : [];
  const reasoningText =
    typeof message.reasoning_content === "string" && message.reasoning_content !== ""
      ? message.reasoning_content
      : typeof message.reasoning === "string" && message.reasoning !== ""
        ? message.reasoning
        : detailsText(details);
  const reasoning = reasoningBlock(reasoningText, details);
  if (reasoning) content.push(reasoning);
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
  let sawReasoningString = false;
  const details: ReasoningDetail[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  // Dense slot per streamed call. Providers key deltas by `index` (possibly
  // sparse); some omit it and repeat the `id` instead — and a bare
  // continuation (no index, no id) belongs to the most recent call.
  const slotByIndex = new Map<number, number>();
  const slotById = new Map<string, number>();
  const toolCallSlot = (call: { index?: number; id?: string }): number => {
    let slot = call.index !== undefined ? slotByIndex.get(call.index) : undefined;
    if (slot === undefined && call.id) slot = slotById.get(call.id);
    if (slot === undefined && call.index === undefined && !call.id && toolCalls.length > 0) slot = toolCalls.length - 1;
    if (slot === undefined) {
      slot = toolCalls.length;
      toolCalls.push({ id: "", name: "", arguments: "" });
    }
    if (call.index !== undefined) slotByIndex.set(call.index, slot);
    if (call.id) slotById.set(call.id, slot);
    return slot;
  };

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
    // DeepSeek spells it reasoning_content; OpenRouter re-exports the same channel as
    // `reasoning` (plus structured reasoning_details, kept for round-trip). Deltas come
    // from the strings; details only contribute text when no string channel exists.
    const reasoningDelta =
      typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : undefined;
    if (reasoningDelta !== undefined) sawReasoningString = true;
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      yield { type: "reasoning-delta", text: reasoningDelta };
    }
    if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
      mergeDetails(details, delta.reasoning_details);
      const fragmentText = detailsText(delta.reasoning_details);
      if (!sawReasoningString && fragmentText !== "") {
        reasoning += fragmentText;
        yield { type: "reasoning-delta", text: fragmentText };
      }
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      text += delta.content;
      yield { type: "text-delta", text: delta.content };
    }
    for (const call of delta.tool_calls ?? []) {
      const index = toolCallSlot(call);
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
  const reasoningOut = reasoningBlock(reasoning, details);
  if (reasoningOut) content.push(reasoningOut);
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
