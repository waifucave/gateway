import { GatewayError, extractErrorMessage } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { CacheControl, ChatMessage, ChatResponse, ContentBlock, FinishReason, StreamEvent, TextBlock, Usage, Warning } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { normalizeUsage } from "../client/usage.js";
import {
  applyPassthrough,
  authHeaders,
  buildUrl,
  enforceCacheBreakpoints,
  mapNativeParams,
  parseArguments,
  pruneUndefined,
  setPath,
  wireCacheControl
} from "./shared.js";

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
  usage?: WireUsage;
};

type WireUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

/** Anthropic's input_tokens is the UNCACHED remainder only — the normalized total adds reads and writes back. */
function decodeUsage(usage: WireUsage | undefined): Usage {
  const cacheRead = usage?.cache_read_input_tokens;
  const cacheWrite = usage?.cache_creation_input_tokens;
  return normalizeUsage({
    inputTokens: (usage?.input_tokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: usage?.cache_creation?.ephemeral_1h_input_tokens
  });
}

function defaultMaxTokens(model: ResolvedModel): number {
  return model.limits.maxOutputTokens > 0 ? Math.min(model.limits.maxOutputTokens, DEFAULT_MAX_TOKENS) : DEFAULT_MAX_TOKENS;
}

type WireMessage = { role: "user" | "assistant"; content: Array<Record<string, unknown>> };

type WireBlock = Record<string, unknown>;

/** Text block → wire block, carrying a block-level cache breakpoint. */
function textBlock(block: TextBlock): WireBlock {
  return block.cacheControl ? { type: "text", text: block.text, cache_control: wireCacheControl(block.cacheControl) } : { type: "text", text: block.text };
}

/**
 * Message-level breakpoint → the LAST block of that message that may carry
 * one. Thinking / redacted_thinking blocks cannot be cache-marked, so the mark
 * walks back past them; a message with nothing markable is reported.
 */
function markLastBlock(blocks: WireBlock[], cacheControl: CacheControl | undefined, warnings: Warning[]): void {
  if (!cacheControl) return;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const type = blocks[i]!.type;
    if (type === "thinking" || type === "redacted_thinking") continue;
    blocks[i] = { ...blocks[i]!, cache_control: wireCacheControl(cacheControl) };
    return;
  }
  warnings.push({ code: "cache_ignored", param: "cacheControl", message: "cache breakpoint on a message with no cacheable block was ignored" });
}

function encodeMessages(
  model: ResolvedModel,
  messages: ChatMessage[],
  warnings: Warning[]
): { system?: string | WireBlock[]; messages: WireMessage[] } {
  const systemBlocks: WireBlock[] = [];
  let systemMarked = false;
  const out: WireMessage[] = [];
  // Anthropic rejects empty content arrays and empty text blocks (400) —
  // strip empty text blocks and drop turns that end up with no blocks at all.
  const push = (role: "user" | "assistant", rawBlocks: WireBlock[], cacheControl: CacheControl | undefined) => {
    const blocks = rawBlocks.filter((block) => !(block.type === "text" && block.text === ""));
    if (blocks.length === 0) return;
    markLastBlock(blocks, cacheControl, warnings);
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") {
      const blocks = (typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content)
        .filter((block) => block.text !== "")
        .map(textBlock);
      markLastBlock(blocks, message.cacheControl, warnings);
      if (blocks.some((block) => block.cache_control !== undefined) || Array.isArray(message.content)) systemMarked = true;
      systemBlocks.push(...blocks);
    } else if (message.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }], message.cacheControl);
    } else if (message.role === "user") {
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map((block) =>
              block.type === "text" ? textBlock(block) : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
            );
      push("user", blocks, message.cacheControl);
    } else {
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map((block): WireBlock => {
              if (block.type === "text") return textBlock(block);
              if (block.type === "toolCall") {
                return { type: "tool_use", id: block.id, name: block.name, input: parseArguments(model.providerId, block.name, block.arguments) };
              }
              return block.redacted
                ? { type: "redacted_thinking", data: block.data ?? "" }
                : pruneUndefined({ type: "thinking", thinking: block.text, signature: block.signature });
            });
      push("assistant", blocks, message.cacheControl);
    }
  }
  // Breakpoints need the block form; unmarked plain-string systems keep the
  // historical joined string (byte-identical prompts for existing callers).
  const system =
    systemBlocks.length === 0 ? undefined : systemMarked ? systemBlocks : systemBlocks.map((block) => block.text as string).join("\n\n");
  enforceCacheBreakpoints([...(Array.isArray(system) ? system : []), ...out.flatMap((message) => message.content)], model.providerId, warnings);
  return { system, messages: out };
}

/**
 * Anthropic structured outputs accept a JSON-Schema subset: every object must
 * be closed (`additionalProperties: false`) and numeric/length/array-size
 * constraints are rejected. Close objects and move those constraints into the
 * description (the official SDKs do the same), so callers keep one schema for
 * every wire. Returns a deep copy — the caller's schema is never mutated.
 */
const UNSUPPORTED_SCHEMA_CONSTRAINTS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems"];

function toAnthropicOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => toAnthropicOutputSchema(entry));
  if (schema === null || typeof schema !== "object") return schema;
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (UNSUPPORTED_SCHEMA_CONSTRAINTS.includes(key) || (key === "minItems" && typeof value === "number" && value > 1)) {
      notes.push(`${key}: ${JSON.stringify(value)}`);
    } else if ((key === "properties" || key === "$defs" || key === "definitions") && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, toAnthropicOutputSchema(sub)]));
    } else if (key === "items" || key === "anyOf" || key === "allOf" || key === "oneOf" || key === "prefixItems") {
      out[key] = toAnthropicOutputSchema(value);
    } else {
      out[key] = structuredClone(value);
    }
  }
  if (notes.length > 0) {
    const note = `(${notes.join(", ")})`;
    out.description = typeof out.description === "string" && out.description !== "" ? `${out.description} ${note}` : note;
  }
  const isObject = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object")) || "properties" in out;
  if (isObject && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  if (request.responseFormat?.type === "json_object") {
    throw new GatewayError("invalid_request", "anthropic-messages has no JSON mode; use responseFormat json_schema", { provider: model.providerId });
  }
  const mapped = mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { model: model.modelId, ...mapped.wire };
  if (typeof body.max_tokens !== "number") body.max_tokens = defaultMaxTokens(model);
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  const thinkingStyle = model.features.thinkingStyle ?? "budget";
  if (thinkingStyle === "always-on") {
    // Fable-class models reject any explicit thinking config (enabled/budget/disabled all 400).
    if (thinking && thinking.type !== "enabled") {
      warnings.push({ code: "param_forced", param: "reasoning.enabled", message: "thinking is always on for this model and cannot be disabled" });
    } else if (typeof thinking?.budget_tokens === "number") {
      warnings.push({ code: "param_dropped", param: "reasoning.budgetTokens", message: "budget_tokens is not supported on this model; thinking is adaptive and always on" });
    }
    delete body.thinking;
  } else if (thinking) {
    if (thinking.type === "enabled") {
      if (thinkingStyle === "adaptive") {
        if (typeof thinking.budget_tokens === "number") {
          warnings.push({ code: "param_dropped", param: "reasoning.budgetTokens", message: "budget_tokens is rejected by this model; using adaptive thinking instead" });
        }
        body.thinking = { type: "adaptive" };
      } else {
        if (typeof thinking.budget_tokens !== "number") thinking.budget_tokens = DEFAULT_THINKING_BUDGET;
        if ((body.max_tokens as number) <= thinking.budget_tokens) body.max_tokens = thinking.budget_tokens + DEFAULT_THINKING_BUDGET;
      }
    } else {
      body.thinking = { type: "disabled" };
    }
  }
  const { system, messages } = encodeMessages(model, request.messages, warnings);
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
  if (request.responseFormat?.type === "json_schema") {
    // Native structured outputs (GA, no beta header): output_config.format, merged
    // with output_config.effort when both are set. The JSON arrives as the text block.
    setPath(body, "output_config.format", { type: "json_schema", schema: toAnthropicOutputSchema(request.responseFormat.schema) });
  }
  if (request.stream) body.stream = true;
  applyPassthrough(body, request.passthrough, warnings, { wire: model.wire, provider: model.providerId });
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
  const usage = decodeUsage(wire.usage);
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
  // message_start carries the prompt counts; message_delta's usage is cumulative
  // (and on newer API versions repeats the input/cache fields) — merge, later wins.
  let wireUsage: WireUsage = {};
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
      wireUsage = { ...wireUsage, ...(((data.message as Record<string, unknown> | undefined)?.usage ?? {}) as WireUsage) };
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
      for (const [key, value] of Object.entries(usageData)) {
        if (value !== null && value !== undefined) (wireUsage as Record<string, unknown>)[key] = value;
      }
    } else if (type === "message_stop") {
      const usage = decodeUsage(wireUsage);
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

  // Truncated stream (no message_stop): the Codec contract still requires a done
  // event. Anthropic delivers stop_reason in message_delta (message_stop is just
  // the terminating envelope), so a captured stop_reason is trusted; otherwise "error".
  yield {
    type: "done",
    response: {
      id,
      provider: model.providerId,
      model: model.modelId,
      content: assembleContent(blocks),
      finishReason,
      usage: decodeUsage(wireUsage),
      warnings: []
    }
  };
}

export const anthropicMessagesCodec: Codec = { wire: "anthropic-messages", encode, decodeResponse, decodeStream };
