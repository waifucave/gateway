import { GatewayError, extractErrorMessage } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ChatMessage, ChatResponse, ContentBlock, FinishReason, StreamEvent, TextBlock, Usage } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, pruneUndefined, setPath } from "./shared.js";

type ResponsesPayload = {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    summary?: Array<{ type?: string; text?: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    input_tokens_details?: { cached_tokens?: number };
  };
};

function encodeInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      input.push({ role: "developer", content: [{ type: "input_text", text: message.content }] });
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
    } else if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      input.push({
        role: "user",
        content: blocks.map((block) =>
          block.type === "text"
            ? { type: "input_text", text: block.text }
            : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` }
        )
      });
    } else {
      // Text blocks flatten into one output message; interleaving with tool calls
      // cannot be represented on this wire. Reasoning is server-managed by OpenAI
      // and never re-sent.
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      const text = blocks
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text !== "") input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const block of blocks) {
        if (block.type === "toolCall") input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments });
      }
    }
  }
  return input;
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  const mapped = mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { model: model.modelId, ...mapped.wire };
  body.input = encodeInput(request.messages);
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) =>
      pruneUndefined({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict })
    );
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice = typeof request.toolChoice === "object" ? { type: "function", name: request.toolChoice.name } : request.toolChoice;
  }
  if (request.responseFormat) {
    setPath(
      body,
      "text.format",
      request.responseFormat.type === "json_object"
        ? { type: "json_object" }
        : pruneUndefined({
            type: "json_schema",
            name: request.responseFormat.name ?? "response",
            schema: request.responseFormat.schema,
            strict: request.responseFormat.strict
          })
    );
  }
  if (request.stream) body.stream = true;
  applyPassthrough(body, request.passthrough, warnings);
  return { url: buildUrl(model, request.stream), headers: authHeaders(model, apiKey), body: pruneUndefined(body), warnings };
}

function decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse {
  const wire = payload as ResponsesPayload;
  const content: ContentBlock[] = [];
  let hasToolCalls = false;
  let callIndex = 0;
  for (const item of wire.output ?? []) {
    if (item.type === "reasoning") {
      const text = (item.summary ?? [])
        .map((s) => s.text ?? "")
        .join("");
      if (text !== "") content.push({ type: "reasoning", text });
    } else if (item.type === "message") {
      const text = (item.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("");
      if (text !== "") content.push({ type: "text", text });
    } else if (item.type === "function_call") {
      hasToolCalls = true;
      content.push({ type: "toolCall", id: item.call_id ?? `call_${callIndex}`, name: item.name ?? "", arguments: item.arguments ?? "{}" });
      callIndex++;
    }
  }
  const finishReason: FinishReason =
    wire.status === "completed"
      ? hasToolCalls
        ? "tool_calls"
        : "stop"
      : wire.status === "incomplete"
        ? wire.incomplete_details?.reason === "max_output_tokens"
          ? "length"
          : wire.incomplete_details?.reason === "content_filter"
            ? "content_filter"
            : "error"
        : "error";
  const usage: Usage = pruneUndefined({
    inputTokens: wire.usage?.input_tokens ?? 0,
    outputTokens: wire.usage?.output_tokens ?? 0,
    reasoningTokens: wire.usage?.output_tokens_details?.reasoning_tokens,
    cachedInputTokens: wire.usage?.input_tokens_details?.cached_tokens
  });
  return { id: wire.id ?? "", provider: model.providerId, model: model.modelId, content, finishReason, usage, warnings: [] };
}

async function* decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
  const toolIndexByOutputIndex = new Map<number, number>();
  let nextToolIndex = 0;
  // accumulated only for the truncated-stream fallback below
  let id = "";
  let text = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  for await (const event of events) {
    let data: Record<string, unknown> & { type?: string };
    try {
      data = JSON.parse(event.data);
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} sent a malformed SSE chunk`, { provider: model.providerId, raw: event.data, cause });
    }
    const type = event.event ?? data.type;
    if (type === "response.created") {
      id = (data.response as { id?: string } | undefined)?.id ?? id;
    } else if (type === "response.output_item.added") {
      const item = data.item as { type?: string; call_id?: string; name?: string } | undefined;
      if (item?.type === "function_call") {
        const index = nextToolIndex++;
        // assumes OpenAI's documented added-before-delta ordering per output_index
        toolIndexByOutputIndex.set(data.output_index as number, index);
        toolCalls.push({ id: item.call_id ?? `call_${index}`, name: item.name ?? "", arguments: "" });
        yield {
          type: "tool-call-delta",
          index,
          ...(item.call_id !== undefined ? { id: item.call_id } : {}),
          ...(item.name !== undefined ? { name: item.name } : {}),
          argumentsDelta: ""
        };
      }
    } else if (type === "response.output_text.delta") {
      if (typeof data.delta === "string" && data.delta !== "") {
        text += data.delta;
        yield { type: "text-delta", text: data.delta };
      }
    } else if (type === "response.reasoning_summary_text.delta") {
      if (typeof data.delta === "string" && data.delta !== "") {
        reasoning += data.delta;
        yield { type: "reasoning-delta", text: data.delta };
      }
    } else if (type === "response.function_call_arguments.delta") {
      const index = toolIndexByOutputIndex.get(data.output_index as number) ?? 0;
      if (typeof data.delta === "string") {
        const entry = toolCalls[index];
        if (entry) entry.arguments += data.delta;
        yield { type: "tool-call-delta", index, argumentsDelta: data.delta };
      }
    } else if (type === "response.completed") {
      const response = decodeResponse(model, data.response);
      yield { type: "usage", usage: response.usage };
      yield { type: "done", response };
      return;
    } else if (type === "response.failed" || type === "error") {
      throw new GatewayError("server", extractErrorMessage(data.response ?? data), { provider: model.providerId, raw: data });
    }
    // all other event types (response.in_progress, …) are ignored
  }

  // Truncated stream (no response.completed): the Codec contract still requires
  // a done event — synthesize one from accumulated deltas with finishReason "error".
  const content: ContentBlock[] = [];
  if (reasoning !== "") content.push({ type: "reasoning", text: reasoning });
  if (text !== "") content.push({ type: "text", text });
  for (const call of toolCalls) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments || "{}" });
  yield {
    type: "done",
    response: {
      id,
      provider: model.providerId,
      model: model.modelId,
      content,
      finishReason: "error",
      usage: { inputTokens: 0, outputTokens: 0 },
      warnings: []
    }
  };
}

export const openaiResponsesCodec: Codec = { wire: "openai-responses", encode, decodeResponse, decodeStream };
