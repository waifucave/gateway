import { Gateway, type GatewayOptions } from "../client/gateway.js";
import { PROVIDERS } from "../registry/providers.js";
import { errorResponse, jsonResponse, serializeGatewayError } from "./shared.js";
import type { ChatMessage, ChatRequest, ResponseFormat, StreamEvent, ToolChoice, ToolDef } from "../client/types.js";
import type { ValidateInput } from "../validate/validateRequest.js";

export type GatewayHandlerOptions = GatewayOptions;

export type ModelSummary = {
  providerId: string;
  modelId: string;
  family: string;
  displayName: string;
  company: string;
  wire: string;
  contextTokens: number;
  maxOutputTokens: number;
  streaming: boolean;
  tools: boolean;
  reasoning: boolean;
  jsonMode: boolean;
  jsonSchema: boolean;
  imageInput: boolean;
  deprecated: boolean;
  confidence: string;
  routeStatus?: string;
};

export type GatewayHttpHandler = {
  /** Framework-agnostic entry point (§4.6): plain Fetch Request in, Response out. */
  handle: (request: Request) => Promise<Response>;
  gateway: Gateway;
};

const NOT_FOUND_BODY = { error: { kind: "invalid_request", message: "not found", retryable: false } };

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" };
const DONE_FRAME = "data: [DONE]\n\n";

function sseFrame(event: StreamEvent): string {
  const payload = event.type === "error" ? { type: "error", error: serializeGatewayError(event.error) } : event;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function methodNotAllowed(allow: string): Response {
  return new Response(
    JSON.stringify({ error: { kind: "invalid_request", message: `method not allowed; use ${allow}`, retryable: false } }),
    { status: 405, headers: { "content-type": "application/json", allow } }
  );
}

function pathSegments(url: string): string[] {
  return new URL(url).pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // undecodable segment can't match a route → 404
      }
    });
}

function badRequest(message: string): Response {
  return jsonResponse(400, { error: { kind: "invalid_request", message, retryable: false } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ParsedBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

/**
 * P1c carryover: handler.ts previously validated only top-level request shapes
 * (messages is an array, tools is an array, ...) — malformed ELEMENTS inside
 * them (a message missing `role`, a content block with a bogus `type`, a tool
 * without `name`) reached the codecs and either silently misencoded or threw a
 * raw TypeError that surfaced as a 500 `{kind:"server"}`. These checks are
 * structural only (roles/types/required fields) — semantics stay in codecs.
 */
const CHAT_ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Mirrors the ChatMessage union in client/types.ts: user/assistant content arrays allow different block types. */
const CONTENT_BLOCK_TYPES = new Set(["text", "image", "reasoning", "toolCall"]);
const CONTENT_BLOCK_TYPES_BY_ROLE: Record<"user" | "assistant", Set<string>> = {
  user: new Set(["text", "image"]),
  assistant: new Set(["text", "reasoning", "toolCall"])
};

function validateContentBlock(block: unknown, messageIndex: number, blockIndex: number, role: "user" | "assistant"): string | undefined {
  const prefix = `messages[${messageIndex}].content[${blockIndex}]`;
  if (!isPlainObject(block)) return `${prefix} must be an object`;
  if (!CONTENT_BLOCK_TYPES.has(block.type as string)) {
    return `${prefix}: unknown content block type ${JSON.stringify(block.type)}`;
  }
  if (!CONTENT_BLOCK_TYPES_BY_ROLE[role].has(block.type as string)) {
    return `${prefix}: block type ${JSON.stringify(block.type)} not allowed in ${role} messages`;
  }
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? undefined : `${prefix}: text block requires a string "text"`;
    case "image":
      return typeof block.mimeType === "string" && typeof block.data === "string"
        ? undefined
        : `${prefix}: image block requires "mimeType" and "data" strings`;
    case "reasoning":
      if (typeof block.text !== "string") return `${prefix}: reasoning block requires a string "text"`;
      if (block.signature !== undefined && typeof block.signature !== "string") return `${prefix}: reasoning block "signature" must be a string`;
      if (block.redacted !== undefined && typeof block.redacted !== "boolean") return `${prefix}: reasoning block "redacted" must be a boolean`;
      if (block.data !== undefined && typeof block.data !== "string") return `${prefix}: reasoning block "data" must be a string`;
      return undefined;
    case "toolCall":
      if (typeof block.id !== "string" || block.id === "") return `${prefix}: toolCall block requires an "id"`;
      if (typeof block.name !== "string" || block.name === "") return `${prefix}: toolCall block requires a "name"`;
      if (typeof block.arguments !== "string") return `${prefix}: toolCall block requires "arguments"`;
      return undefined;
    default:
      return undefined; // unreachable: type is checked against CONTENT_BLOCK_TYPES above
  }
}

function validateChatMessages(messages: unknown[]): string | undefined {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isPlainObject(message)) return `messages[${i}] must be an object`;
    if (typeof message.role !== "string" || !CHAT_ROLES.has(message.role)) {
      return `messages[${i}]: missing or invalid "role"`;
    }
    if (message.role === "tool") {
      if (typeof message.toolCallId !== "string" || message.toolCallId === "") return `messages[${i}]: "toolCallId" is required`;
      if (typeof message.content !== "string") return `messages[${i}]: "content" must be a string`;
      continue;
    }
    if (message.role === "system") {
      if (typeof message.content !== "string") return `messages[${i}]: "content" must be a string`;
      continue;
    }
    // user / assistant: content is a string or an array of content blocks
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) return `messages[${i}]: "content" must be a string or an array`;
    const role = message.role as "user" | "assistant";
    for (let j = 0; j < message.content.length; j++) {
      const error = validateContentBlock(message.content[j], i, j, role);
      if (error) return error;
    }
  }
  return undefined;
}

function validateTools(tools: unknown[]): string | undefined {
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (!isPlainObject(tool)) return `tools[${i}] must be an object`;
    if (typeof tool.name !== "string" || tool.name === "") return `tools[${i}]: missing "name"`;
    if (!isPlainObject(tool.parameters)) return `tools[${i}]: "parameters" must be an object`;
    if (tool.description !== undefined && typeof tool.description !== "string") return `tools[${i}]: "description" must be a string`;
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") return `tools[${i}]: "strict" must be a boolean`;
  }
  return undefined;
}

/** Shared by /v1/chat and /v1/validate — both accept a raw toolChoice. */
function validateToolChoice(value: unknown): string | undefined {
  if (value === undefined || value === "auto" || value === "none" || value === "required") return undefined;
  if (isPlainObject(value) && typeof value.name === "string" && value.name !== "") return undefined;
  return 'toolChoice must be "auto", "none", "required", or { name: string }';
}

async function readJsonBody(request: Request): Promise<ParsedBody> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, response: badRequest("request body must be valid JSON") };
  }
  if (!isPlainObject(parsed)) return { ok: false, response: badRequest("request body must be a JSON object") };
  return { ok: true, body: parsed };
}

/** /v1/validate takes the object form ({type:"json_schema",...}) or the bare string. */
function responseFormatType(value: unknown): ValidateInput["responseFormat"] {
  const type = isPlainObject(value) ? value.type : value;
  return type === "json_object" || type === "json_schema" ? type : undefined;
}

function buildCredentialCheck(credentials: GatewayOptions["credentials"]): (providerId: string) => boolean {
  return (providerId) => {
    const value = typeof credentials === "function" ? credentials(providerId) : credentials?.[providerId];
    return value !== undefined && value !== "";
  };
}

function buildModelSummaries(gateway: Gateway): ModelSummary[] {
  const summaries: ModelSummary[] = [];
  for (const ref of gateway.listModels()) {
    const model = gateway.getCapabilities(ref.providerId, ref.modelId);
    if (!model) continue; // unresolvable route — registry diagnostics cover it
    summaries.push({
      providerId: model.providerId,
      modelId: model.modelId,
      family: model.family,
      displayName: model.displayName,
      company: model.company,
      wire: model.wire,
      contextTokens: model.limits.contextTokens,
      maxOutputTokens: model.limits.maxOutputTokens,
      streaming: model.features.streaming,
      tools: model.features.tools.supported,
      reasoning: Object.keys(model.params).some((name) => name.startsWith("reasoning.")),
      jsonMode: model.features.structuredOutput.jsonMode ?? false,
      jsonSchema: model.features.structuredOutput.jsonSchema ?? false,
      imageInput: model.modalities.input.includes("image"),
      deprecated: model.meta.deprecated ?? false,
      confidence: model.meta.confidence,
      ...(model.meta.routeStatus !== undefined ? { routeStatus: model.meta.routeStatus } : {})
    });
  }
  return summaries;
}

export function createGatewayHandler(options: GatewayHandlerOptions = {}): GatewayHttpHandler {
  const gateway = new Gateway(options);
  const credentialConfigured = buildCredentialCheck(options.credentials);
  const modelSummaries = buildModelSummaries(gateway);

  function handleProviders(): Response {
    return jsonResponse(200, {
      providers: PROVIDERS.map((provider) => ({ ...provider, credentialConfigured: credentialConfigured(provider.id) }))
    });
  }

  function handleModelDetail(provider: string, model: string): Response {
    const resolved = gateway.getCapabilities(provider, model);
    if (!resolved) {
      return jsonResponse(404, { error: { kind: "invalid_request", message: `unknown model ${provider}:${model}`, retryable: false } });
    }
    return jsonResponse(200, resolved);
  }

  function resolveTarget(body: Record<string, unknown>): { ok: true; provider: string; model: string } | { ok: false; response: Response } {
    const { provider, model } = body;
    if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") {
      return { ok: false, response: badRequest("provider and model must be non-empty strings") };
    }
    if (!gateway.getCapabilities(provider, model)) {
      return {
        ok: false,
        response: jsonResponse(404, { error: { kind: "invalid_request", message: `unknown model ${provider}:${model}`, retryable: false } })
      };
    }
    return { ok: true, provider, model };
  }

  async function handleValidate(request: Request): Promise<Response> {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const target = resolveTarget(parsed.body);
    if (!target.ok) return target.response;
    const { params, toolChoice, responseFormat, stream } = parsed.body;
    if (params !== undefined && !isPlainObject(params)) return badRequest("params must be an object");
    const toolChoiceError = validateToolChoice(toolChoice);
    if (toolChoiceError) return badRequest(toolChoiceError);
    try {
      const result = gateway.validate(target.provider, target.model, {
        params: (params as Record<string, unknown> | undefined) ?? {},
        toolChoice: toolChoice as ValidateInput["toolChoice"],
        responseFormat: responseFormatType(responseFormat),
        stream: stream === true
      });
      return jsonResponse(200, result);
    } catch (error) {
      return errorResponse(error, request.signal);
    }
  }

  async function handleChat(request: Request): Promise<Response> {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const target = resolveTarget(parsed.body);
    if (!target.ok) return target.response;
    const body = parsed.body;
    if (!Array.isArray(body.messages)) return badRequest("messages must be an array");
    if (body.params !== undefined && !isPlainObject(body.params)) return badRequest("params must be an object");
    if (body.passthrough !== undefined && !isPlainObject(body.passthrough)) return badRequest("passthrough must be an object");
    if (body.tools !== undefined && !Array.isArray(body.tools)) return badRequest("tools must be an array");
    if (body.responseFormat !== undefined && !isPlainObject(body.responseFormat)) return badRequest("responseFormat must be an object");
    const messagesError = validateChatMessages(body.messages);
    if (messagesError) return badRequest(messagesError);
    if (Array.isArray(body.tools)) {
      const toolsError = validateTools(body.tools);
      if (toolsError) return badRequest(toolsError);
    }
    const toolChoiceError = validateToolChoice(body.toolChoice);
    if (toolChoiceError) return badRequest(toolChoiceError);
    const chatRequest: ChatRequest = {
      provider: target.provider,
      model: target.model,
      messages: body.messages as ChatMessage[],
      tools: body.tools as ToolDef[] | undefined,
      toolChoice: body.toolChoice as ToolChoice | undefined,
      responseFormat: body.responseFormat as ResponseFormat | undefined,
      params: body.params as Record<string, unknown> | undefined,
      passthrough: body.passthrough as Record<string, unknown> | undefined,
      signal: request.signal
    };
    if (body.stream === true) return streamingChat(chatRequest, request.signal);
    try {
      return jsonResponse(200, await gateway.chat(chatRequest));
    } catch (error) {
      return errorResponse(error, request.signal);
    }
  }

  /**
   * SSE notes:
   * - First-event probe: gateway.stream() rejects its first next() for pre-I/O
   *   failures (validation, credentials) — probing it BEFORE building the
   *   Response maps those to real HTTP statuses instead of a 200 SSE.
   * - The provider fetch runs off a handler-owned controller linked to BOTH the
   *   request signal and ReadableStream.cancel(), so a vanished client aborts
   *   the upstream call (the transport keeps the signal wired to the body).
   * - timeoutMs bounds time-to-headers only (P1b carryover #2); the body is
   *   deliberately unbounded — streams run until done/error or client cancel.
   */
  async function streamingChat(chatRequest: ChatRequest, requestSignal: AbortSignal): Promise<Response> {
    if (requestSignal.aborted) return errorResponse(requestSignal.reason, requestSignal);
    const upstream = new AbortController();
    const onAbort = () => upstream.abort(requestSignal.reason);
    requestSignal.addEventListener("abort", onAbort, { once: true });
    const detach = () => requestSignal.removeEventListener("abort", onAbort);

    const iterator = gateway.stream({ ...chatRequest, signal: upstream.signal });
    let first: IteratorResult<StreamEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      detach();
      return errorResponse(error, requestSignal);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.done) {
          controller.enqueue(encoder.encode(DONE_FRAME));
          controller.close();
          detach();
          return;
        }
        controller.enqueue(encoder.encode(sseFrame(first.value)));
      },
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.enqueue(encoder.encode(DONE_FRAME));
          controller.close();
          detach();
          return;
        }
        controller.enqueue(encoder.encode(sseFrame(next.value)));
      },
      cancel() {
        // cancel after normal completion is a harmless no-op (fetch settled, detach/return idempotent)
        upstream.abort(new Error("client closed the SSE connection"));
        detach();
        void iterator.return(undefined);
      }
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  }

  async function handle(request: Request): Promise<Response> {
    const segments = pathSegments(request.url);
    if (segments[0] !== "v1") return jsonResponse(404, NOT_FOUND_BODY);
    const route = segments[1];

    if (route === "providers" && segments.length === 2) {
      return request.method === "GET" ? handleProviders() : methodNotAllowed("GET");
    }
    if (route === "models" && segments.length === 2) {
      return request.method === "GET" ? jsonResponse(200, { models: modelSummaries }) : methodNotAllowed("GET");
    }
    if (route === "models" && segments.length >= 4) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return handleModelDetail(segments[2]!, segments.slice(3).join("/"));
    }
    if (route === "chat" && segments.length === 2) {
      return request.method === "POST" ? handleChat(request) : methodNotAllowed("POST");
    }
    if (route === "validate" && segments.length === 2) {
      return request.method === "POST" ? handleValidate(request) : methodNotAllowed("POST");
    }
    return jsonResponse(404, NOT_FOUND_BODY);
  }

  return { handle, gateway };
}
