import { GatewayError, extractErrorMessage } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ChatMessage, ChatResponse, ContentBlock, FinishReason, StreamEvent, Usage } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, parseArguments, pruneUndefined } from "./shared.js";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_BUDGET = 1024;

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter"
};

type AnthropicPayload = {
  id?: string;
  stop_reason?: string | null;
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    data?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
};

function defaultMaxTokens(model: ResolvedModel): number {
  return model.limits.maxOutputTokens > 0 ? Math.min(model.limits.maxOutputTokens, DEFAULT_MAX_TOKENS) : DEFAULT_MAX_TOKENS;
}

type WireMessage = { role: "user" | "assistant"; content: Array<Record<string, unknown>> };

function encodeMessages(model: ResolvedModel, messages: ChatMessage[]): { system?: string; messages: WireMessage[] } {
  const systems: string[] = [];
  const out: WireMessage[] = [];
  const push = (role: "user" | "assistant", blocks: Array<Record<string, unknown>>) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") {
      systems.push(message.content);
    } else if (message.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }]);
    } else if (message.role === "user") {
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map((block) =>
              block.type === "text"
                ? { type: "text", text: block.text }
                : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
            );
      push("user", blocks);
    } else {
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map((block): Record<string, unknown> => {
              if (block.type === "text") return { type: "text", text: block.text };
              if (block.type === "toolCall") {
                return { type: "tool_use", id: block.id, name: block.name, input: parseArguments(model.providerId, block.name, block.arguments) };
              }
              return block.redacted
                ? { type: "redacted_thinking", data: block.data ?? "" }
                : pruneUndefined({ type: "thinking", thinking: block.text, signature: block.signature });
            });
      push("assistant", blocks);
    }
  }
  return { system: systems.length > 0 ? systems.join("\n\n") : undefined, messages: out };
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  if (request.responseFormat) {
    throw new GatewayError(
      "invalid_request",
      "responseFormat is not implemented for the anthropic-messages codec; use tools for structured output",
      { provider: model.providerId }
    );
  }
  const mapped = mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { model: model.modelId, ...mapped.wire };
  if (typeof body.max_tokens !== "number") body.max_tokens = defaultMaxTokens(model);
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking) {
    if (thinking.type === "enabled") {
      if (typeof thinking.budget_tokens !== "number") thinking.budget_tokens = DEFAULT_THINKING_BUDGET;
      if ((body.max_tokens as number) <= thinking.budget_tokens) body.max_tokens = thinking.budget_tokens + DEFAULT_THINKING_BUDGET;
    } else {
      body.thinking = { type: "disabled" };
    }
  }
  const { system, messages } = encodeMessages(model, request.messages);
  if (system !== undefined) body.system = system;
  body.messages = messages;
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => pruneUndefined({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice =
      typeof request.toolChoice === "object"
        ? { type: "tool", name: request.toolChoice.name }
        : request.toolChoice === "required"
          ? { type: "any" }
          : { type: request.toolChoice };
  }
  if (request.stream) body.stream = true;
  applyPassthrough(body, request.passthrough, warnings);
  return { url: buildUrl(model, request.stream), headers: authHeaders(model, apiKey), body: pruneUndefined(body), warnings };
}

function decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse {
  const wire = payload as AnthropicPayload;
  const content: ContentBlock[] = [];
  (wire.content ?? []).forEach((block, index) => {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      content.push(
        block.signature !== undefined
          ? { type: "reasoning", text: block.thinking ?? "", signature: block.signature }
          : { type: "reasoning", text: block.thinking ?? "" }
      );
    } else if (block.type === "redacted_thinking") {
      content.push({ type: "reasoning", text: "", redacted: true, data: block.data ?? "" });
    } else if (block.type === "tool_use") {
      content.push({ type: "toolCall", id: block.id ?? `call_${index}`, name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) });
    }
  });
  const usage: Usage = pruneUndefined({
    inputTokens: wire.usage?.input_tokens ?? 0,
    outputTokens: wire.usage?.output_tokens ?? 0,
    cachedInputTokens: wire.usage?.cache_read_input_tokens
  });
  return {
    id: wire.id ?? "",
    provider: model.providerId,
    model: model.modelId,
    content,
    finishReason: STOP_REASONS[wire.stop_reason ?? ""] ?? "error",
    usage,
    warnings: []
  };
}

type StreamBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; signature?: string; redacted?: boolean; data?: string }
  | { kind: "tool"; toolIndex: number; id: string; name: string; arguments: string };

function assembleContent(blocks: Map<number, StreamBlock>): ContentBlock[] {
  return [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]): ContentBlock => {
      if (block.kind === "text") return { type: "text", text: block.text };
      if (block.kind === "reasoning") {
        return pruneUndefined({ type: "reasoning", text: block.text, signature: block.signature, redacted: block.redacted, data: block.data });
      }
      return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments || "{}" };
    })
    .filter((block) => !(block.type === "text" && block.text === ""));
}

async function* decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
  let id = "";
  let finishReason: FinishReason = "error";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens: number | undefined;
  const blocks = new Map<number, StreamBlock>();
  let nextToolIndex = 0;

  for await (const event of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: Record<string, any>;
    try {
      data = JSON.parse(event.data) as Record<string, unknown>;
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} sent a malformed SSE chunk`, { provider: model.providerId, raw: event.data, cause });
    }
    const type = event.event ?? (data.type as string | undefined);
    if (type === "message_start") {
      id = (data.message as Record<string, unknown> | undefined)?.id as string ?? "";
      inputTokens = ((data.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined)?.input_tokens as number ?? 0;
      cachedInputTokens = ((data.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined)?.cache_read_input_tokens as number | undefined;
    } else if (type === "content_block_start") {
      const index = data.index as number;
      const block = (data.content_block ?? {}) as Record<string, unknown>;
      if (block.type === "tool_use") {
        const toolIndex = nextToolIndex++;
        blocks.set(index, { kind: "tool", toolIndex, id: block.id as string ?? `call_${toolIndex}`, name: block.name as string ?? "", arguments: "" });
        yield {
          type: "tool-call-delta",
          index: toolIndex,
          ...(block.id !== undefined ? { id: block.id as string } : {}),
          ...(block.name !== undefined ? { name: block.name as string } : {}),
          argumentsDelta: ""
        };
      } else if (block.type === "thinking") {
        blocks.set(index, { kind: "reasoning", text: block.thinking as string ?? "" });
      } else if (block.type === "redacted_thinking") {
        blocks.set(index, { kind: "reasoning", text: "", redacted: true, data: block.data as string ?? "" });
      } else {
        blocks.set(index, { kind: "text", text: block.text as string ?? "" });
      }
    } else if (type === "content_block_delta") {
      const block = blocks.get(data.index as number);
      const delta = (data.delta ?? {}) as Record<string, unknown>;
      if (!block) continue;
      if (delta.type === "text_delta" && block.kind === "text" && typeof delta.text === "string" && delta.text !== "") {
        block.text += delta.text;
        yield { type: "text-delta", text: delta.text };
      } else if (delta.type === "thinking_delta" && block.kind === "reasoning" && typeof delta.thinking === "string" && delta.thinking !== "") {
        block.text += delta.thinking;
        yield { type: "reasoning-delta", text: delta.thinking };
      } else if (delta.type === "signature_delta" && block.kind === "reasoning") {
        block.signature = (block.signature ?? "") + ((delta.signature as string | undefined) ?? "");
      } else if (delta.type === "input_json_delta" && block.kind === "tool") {
        const argumentsDelta = (delta.partial_json as string | undefined) ?? "";
        block.arguments += argumentsDelta;
        yield { type: "tool-call-delta", index: block.toolIndex, argumentsDelta };
      }
    } else if (type === "message_delta") {
      const delta = (data.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.stop_reason === "string") finishReason = STOP_REASONS[delta.stop_reason] ?? "error";
      const usageData = (data.usage ?? {}) as Record<string, unknown>;
      if (typeof usageData.output_tokens === "number") outputTokens = usageData.output_tokens;
    } else if (type === "message_stop") {
      const usage: Usage = pruneUndefined({ inputTokens, outputTokens, cachedInputTokens });
      yield { type: "usage", usage };
      yield {
        type: "done",
        response: { id, provider: model.providerId, model: model.modelId, content: assembleContent(blocks), finishReason, usage, warnings: [] }
      };
      return;
    } else if (type === "error") {
      throw new GatewayError("server", extractErrorMessage(data), { provider: model.providerId, raw: data });
    }
    // ping and other event types are ignored
  }

  // Truncated stream (no message_stop): the Codec contract still requires a done event.
  yield {
    type: "done",
    response: {
      id,
      provider: model.providerId,
      model: model.modelId,
      content: assembleContent(blocks),
      finishReason: "error",
      usage: pruneUndefined({ inputTokens, outputTokens, cachedInputTokens }),
      warnings: []
    }
  };
}

export const anthropicMessagesCodec: Codec = { wire: "anthropic-messages", encode, decodeResponse, decodeStream };
