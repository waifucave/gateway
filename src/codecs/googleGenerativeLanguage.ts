import { GatewayError } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ChatMessage, ChatResponse, ContentBlock, FinishReason, StreamEvent, ToolCallBlock, Usage } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, parseArguments, pruneUndefined, setPath } from "./shared.js";

const FINISH_REASONS: Record<string, FinishReason> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  BLOCKLIST: "content_filter",
  RECITATION: "content_filter",
  SPII: "content_filter"
};

type GooglePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
};

type GooglePayload = {
  responseId?: string;
  candidates?: Array<{
    content?: { parts?: Array<GooglePart> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
};

type WireContent = { role: "user" | "model"; parts: Array<Record<string, unknown>> };

function encodeContents(
  model: ResolvedModel,
  messages: ChatMessage[]
): { systemInstruction?: { parts: Array<{ text: string }> }; contents: WireContent[] } {
  const systems: string[] = [];
  const contents: WireContent[] = [];
  const toolNameById = new Map<string, string>();
  // Empty parts arrays / empty text parts are invalid on this wire — strip and drop.
  // NOTE: thought parts with empty text must NOT be stripped (part.thought === undefined check).
  const push = (role: "user" | "model", rawParts: Array<Record<string, unknown>>) => {
    const parts = rawParts.filter((part) => !("text" in part && part.text === "" && part.thought === undefined));
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === "system") {
      systems.push(message.content);
    } else if (message.role === "tool") {
      const name = toolNameById.get(message.toolCallId);
      if (name === undefined) {
        throw new GatewayError("invalid_request", `tool result "${message.toolCallId}" has no matching toolCall earlier in the conversation`, {
          provider: model.providerId
        });
      }
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(message.content) as unknown;
        response = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { result: parsed };
      } catch {
        response = { result: message.content };
      }
      push("user", [{ functionResponse: { name, response } }]);
    } else if (message.role === "user") {
      const parts =
        typeof message.content === "string"
          ? [{ text: message.content }]
          : message.content.map((block) =>
              block.type === "text" ? { text: block.text } : { inlineData: { mimeType: block.mimeType, data: block.data } }
            );
      push("user", parts);
    } else {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      const parts = blocks.map((block): Record<string, unknown> => {
        if (block.type === "text") return { text: block.text };
        if (block.type === "toolCall") {
          toolNameById.set(block.id, block.name);
          // Gemini 3 hard-rejects history functionCall parts without a thoughtSignature
          // (HTTP 400, observed live 2026-07-02). Round-trip the real signature when one
          // was captured at decode; for synthetic/injected calls use Google's documented
          // bypass value for exactly this case.
          return {
            functionCall: { name: block.name, args: parseArguments(model.providerId, block.name, block.arguments) },
            thoughtSignature: block.signature ?? GOOGLE_INJECTED_CALL_SIGNATURE
          };
        }
        // Reasoning is re-encoded unconditionally (not gated on features.reasoningRoundTrip,
        // unlike openai-chat): Gemini 3 requires thoughtSignature round-trip on tool loops,
        // mirroring the anthropic-messages pattern.
        return pruneUndefined({ text: block.text, thought: true, thoughtSignature: block.signature });
      });
      push("model", parts);
    }
  }
  return { systemInstruction: systems.length > 0 ? { parts: [{ text: systems.join("\n\n") }] } : undefined, contents };
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  const mapped = mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { ...mapped.wire };
  // Roleplay banter routinely trips default SAFETY thresholds; run with permissive settings.
  // (Prompt-level blockReasons like PROHIBITED_CONTENT are not configurable and still surface as errors.)
  if (body.safetySettings === undefined) {
    body.safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ];
  } // model id lives in the URL, not the body
  const { systemInstruction, contents } = encodeContents(model, request.messages);
  if (systemInstruction !== undefined) body.systemInstruction = systemInstruction;
  body.contents = contents;
  if (request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) =>
          pruneUndefined({
            name: tool.name,
            description: tool.description,
            parameters: sanitizeGoogleSchema(tool.parameters)
          })
        )
      }
    ];
  }
  if (request.toolChoice !== undefined) {
    const mode = request.toolChoice === "auto" ? "AUTO" : request.toolChoice === "none" ? "NONE" : "ANY";
    setPath(
      body,
      "toolConfig.functionCallingConfig",
      pruneUndefined({ mode, allowedFunctionNames: typeof request.toolChoice === "object" ? [request.toolChoice.name] : undefined })
    );
  }
  if (request.responseFormat) {
    setPath(body, "generationConfig.responseMimeType", "application/json");
    if (request.responseFormat.type === "json_schema") setPath(body, "generationConfig.responseJsonSchema", request.responseFormat.schema);
  }
  // streaming is selected via the URL (:streamGenerateContent?alt=sse); no body flag
  applyPassthrough(body, request.passthrough, warnings);
  return { url: buildUrl(model, request.stream), headers: authHeaders(model, apiKey), body: pruneUndefined(body), warnings };
}

function decodeParts(parts: GooglePart[], toolStartIndex: number): { blocks: ContentBlock[]; toolCount: number } {
  const blocks: ContentBlock[] = [];
  let toolCount = 0;
  for (const part of parts) {
    if (part.functionCall) {
      blocks.push(
        pruneUndefined({
          type: "toolCall",
          id: part.functionCall.id ?? `call_${toolStartIndex + toolCount}`,
          name: part.functionCall.name ?? "",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
          signature: part.thoughtSignature
        }) as ToolCallBlock
      );
      toolCount++;
    } else if (part.thought === true) {
      blocks.push(
        part.thoughtSignature !== undefined
          ? { type: "reasoning", text: part.text ?? "", signature: part.thoughtSignature }
          : { type: "reasoning", text: part.text ?? "" }
      );
    } else if (typeof part.text === "string" && part.text !== "") {
      blocks.push({ type: "text", text: part.text });
    }
  }
  return { blocks, toolCount };
}

function decodeUsage(meta: GooglePayload["usageMetadata"]): Usage {
  return pruneUndefined({
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: meta?.candidatesTokenCount ?? 0,
    reasoningTokens: meta?.thoughtsTokenCount,
    cachedInputTokens: meta?.cachedContentTokenCount
  });
}

function decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse {
  const wire = payload as GooglePayload;
  // multi-candidate responses are not part of the unified API; only the first is surfaced
  const candidate = wire.candidates?.[0];
  if (!candidate) {
    const blockReason = (wire as { promptFeedback?: { blockReason?: string } }).promptFeedback?.blockReason;
    if (blockReason) {
      throw new GatewayError("server", `${model.providerId} blocked the prompt: ${blockReason}`, { provider: model.providerId, raw: payload });
    }
    throw new GatewayError("server", `${model.providerId} response has no candidates`, { provider: model.providerId, raw: payload });
  }
  const { blocks, toolCount } = decodeParts(candidate.content?.parts ?? [], 0);
  const rawFinish = FINISH_REASONS[candidate.finishReason ?? ""] ?? "error";
  return {
    id: wire.responseId ?? "",
    provider: model.providerId,
    model: model.modelId,
    content: blocks,
    finishReason: rawFinish === "stop" && toolCount > 0 ? "tool_calls" : rawFinish,
    usage: decodeUsage(wire.usageMetadata),
    warnings: []
  };
}

async function* decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
  let id = "";
  let finishReason: FinishReason = "error";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  let text = "";
  let reasoning = "";
  let reasoningSignature: string | undefined;
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for await (const event of events) {
    let chunk: GooglePayload;
    try {
      chunk = JSON.parse(event.data);
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} sent a malformed SSE chunk`, { provider: model.providerId, raw: event.data, cause });
    }
    if (chunk.responseId) id = chunk.responseId;
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        const index = toolCalls.length;
        const call = {
          id: part.functionCall.id ?? `call_${index}`,
          name: part.functionCall.name ?? "",
          arguments: JSON.stringify(part.functionCall.args ?? {})
        };
        toolCalls.push(call);
        // functionCall parts arrive whole, so the delta carries the complete arguments JSON
        yield { type: "tool-call-delta", index, id: call.id, name: call.name, argumentsDelta: call.arguments };
      } else if (part.thought === true) {
        reasoning += part.text ?? "";
        if (part.thoughtSignature !== undefined) reasoningSignature = part.thoughtSignature;
        if (part.text) yield { type: "reasoning-delta", text: part.text };
      } else if (typeof part.text === "string" && part.text !== "") {
        text += part.text;
        yield { type: "text-delta", text: part.text };
      }
    }
    if (candidate?.finishReason) {
      const mapped = FINISH_REASONS[candidate.finishReason] ?? "error";
      finishReason = mapped === "stop" && toolCalls.length > 0 ? "tool_calls" : mapped;
    }
    if (chunk.usageMetadata) {
      usage = decodeUsage(chunk.usageMetadata);
      sawUsage = true;
    }
  }

  // This wire has no terminator event — the stream just ends, so done is emitted here.
  if (sawUsage) yield { type: "usage", usage };
  const content: ContentBlock[] = [];
  if (reasoning !== "") {
    content.push(
      reasoningSignature !== undefined ? { type: "reasoning", text: reasoning, signature: reasoningSignature } : { type: "reasoning", text: reasoning }
    );
  }
  if (text !== "") content.push({ type: "text", text });
  for (const call of toolCalls) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
  yield {
    type: "done",
    response: { id, provider: model.providerId, model: model.modelId, content, finishReason, usage, warnings: [] }
  };
}

export const googleGenerativeLanguageCodec: Codec = { wire: "google-generative-language", encode, decodeResponse, decodeStream };

// Google's function-declaration validator rejects ANY field outside its Schema proto with
// HTTP 400 "Unknown name ... Cannot find field" (observed live 2026-07-02 for
// `additionalProperties`; validation tightened server-side vs the 2026-06 smoke). Keep only
// proto-known fields and recurse through the nesting keywords.
// Google's documented dummy signature for function calls the caller injected rather than
// the model generated (Gemini 3 thought-signature validation).
const GOOGLE_INJECTED_CALL_SIGNATURE = "context_engineering_is_the_way_to_go";

const GOOGLE_SCHEMA_FIELDS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "anyOf",
  "default",
  "example",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "pattern",
  "propertyOrdering"
]);

function sanitizeGoogleSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => sanitizeGoogleSchema(entry));
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!GOOGLE_SCHEMA_FIELDS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = sanitizeGoogleSchema(sub);
      }
      out[key] = props;
    } else if (key === "items" || key === "anyOf") {
      out[key] = sanitizeGoogleSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
