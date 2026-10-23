import { GatewayError } from "../errors.js";
import type { ResolvedModel, WireProtocol } from "../registry/types.js";
import type { CacheControl, ChatMessage, TextBlock, Warning } from "../client/types.js";

const UNSAFE_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Write a dotted wire path ("thinking.budget_tokens") as nested objects, merging siblings.
 * Path components are registry-controlled wireNames — never pass untrusted input.
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  for (const part of parts) {
    if (UNSAFE_PATH_KEYS.has(part)) throw new Error(`unsafe wire path "${path}"`);
  }
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cursor[key];
    if (next === null || next === undefined || typeof next !== "object" || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
}

/** Deep-copy dropping undefined values; never mutates input (bodies may reference caller objects). */
export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => pruneUndefined(entry)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) out[key] = pruneUndefined(entry);
    }
    return out as T;
  }
  return value;
}

/** effectiveParams keys that are validation directives, not wire params. */
const DIRECTIVE_PARAMS = new Set(["reasoningRoundTrip"]);

/**
 * Params the GATEWAY implements when a descriptor carries no wireName (e.g.
 * Anthropic has no "hide thinking" request field, so `reasoning.exclude` is
 * applied to the normalized response instead — see client/gateway.ts).
 */
export const GATEWAY_SIDE_PARAMS = new Set(["reasoning.exclude"]);

/** `thinking.type` carries "enabled"/"disabled" strings on the wire; the unified param is boolean. */
function wireValue(wireName: string, value: unknown): unknown {
  if (wireName === "thinking.type" && typeof value === "boolean") return value ? "enabled" : "disabled";
  return value;
}

export type MappedParams = { wire: Record<string, unknown>; warnings: Warning[] };

/** Map effectiveParams onto the wire body using each descriptor's native wireName. */
export function mapNativeParams(model: ResolvedModel, effectiveParams: Record<string, unknown>): MappedParams {
  const wire: Record<string, unknown> = {};
  const warnings: Warning[] = [];
  for (const [name, value] of Object.entries(effectiveParams)) {
    if (value === undefined || DIRECTIVE_PARAMS.has(name)) continue;
    const descriptor = model.params[name];
    if (!descriptor) {
      warnings.push({ code: "unmapped_param", param: name, message: `${name} has no descriptor on ${model.providerId}:${model.modelId}; not sent` });
      continue;
    }
    if (descriptor.wireName === undefined && GATEWAY_SIDE_PARAMS.has(name)) continue;
    const wireName = descriptor.wireName ?? name;
    setPath(wire, wireName, wireValue(wireName, value));
  }
  return { wire, warnings };
}

/**
 * OpenRouter normalizes parameters across hosts, but descriptors keep NATIVE
 * wireNames (e.g. generationConfig.temperature on a Gemini doc). OpenRouter
 * routes therefore map canonical names through this table instead.
 * reasoning.* nests into OpenRouter's normalized `reasoning` object.
 */
export const OPENROUTER_WIRE_NAMES: Record<string, string> = {
  temperature: "temperature",
  topP: "top_p",
  topK: "top_k",
  minP: "min_p",
  topA: "top_a",
  frequencyPenalty: "frequency_penalty",
  presencePenalty: "presence_penalty",
  repetitionPenalty: "repetition_penalty",
  logitBias: "logit_bias",
  seed: "seed",
  logprobs: "logprobs",
  topLogprobs: "top_logprobs",
  maxOutputTokens: "max_tokens",
  stopSequences: "stop",
  n: "n",
  verbosity: "verbosity",
  "reasoning.enabled": "reasoning.enabled",
  "reasoning.effort": "reasoning.effort",
  "reasoning.budgetTokens": "reasoning.max_tokens"
  // reasoning.exclude is NOT forwarded: OpenRouter would then omit reasoning /
  // reasoning_details, breaking signature round-trip on Claude/Gemini tool
  // loops. The gateway hides reasoning itself (GATEWAY_SIDE_PARAMS).
};

export function mapOpenRouterParams(model: ResolvedModel, effectiveParams: Record<string, unknown>): MappedParams {
  const wire: Record<string, unknown> = {};
  const warnings: Warning[] = [];
  for (const [name, value] of Object.entries(effectiveParams)) {
    // gateway-side params never go upstream on OpenRouter; reasoning.enabled /
    // effort / budget still map, so reasoning stays on when the caller enabled it
    if (value === undefined || DIRECTIVE_PARAMS.has(name) || GATEWAY_SIDE_PARAMS.has(name)) continue;
    const wireName = OPENROUTER_WIRE_NAMES[name];
    if (wireName === undefined) {
      warnings.push({ code: "unmapped_param", param: name, message: `${name} has no OpenRouter mapping; not sent` });
      continue;
    }
    setPath(wire, wireName, value);
  }
  return { wire, warnings };
}

/**
 * P1a carryover #1: for google-generative-language the model id and :method live
 * in the URL path and streaming switches the method — baseUrl+endpoint alone is
 * not a URL. All codecs build URLs through here.
 */
export function buildUrl(model: ResolvedModel, stream: boolean): string {
  if (model.wire === "google-generative-language") {
    const method = stream ? ":streamGenerateContent?alt=sse" : model.endpoint.startsWith(":") ? model.endpoint : ":generateContent";
    return `${model.baseUrl}/v1beta/models/${model.modelId}${method}`;
  }
  return `${model.baseUrl}${model.endpoint}`;
}

export function authHeaders(model: ResolvedModel, apiKey: string): Record<string, string> {
  switch (model.wire) {
    case "anthropic-messages":
      return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "google-generative-language":
      return { "content-type": "application/json", "x-goog-api-key": apiKey };
    default:
      return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  }
}

/** Tool-call arguments travel as JSON text in the unified shape; some wires need the parsed object. */
export function parseArguments(provider: string, toolName: string, argumentsJson: string): Record<string, unknown> {
  if (argumentsJson.trim() === "") return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through to the error below
  }
  throw new GatewayError("invalid_request", `tool call "${toolName}" has non-object JSON arguments`, { provider });
}

/**
 * Body keys each codec owns. Passthrough may never set them: they carry the
 * typed request (model, conversation, tools, stream framing, structured output)
 * and overwriting them would bypass validation entirely — /v1/chat is exposed.
 */
export const CORE_BODY_KEYS: Record<WireProtocol, ReadonlySet<string>> = {
  "openai-chat": new Set(["model", "messages", "tools", "tool_choice", "stream", "stream_options", "response_format"]),
  "openai-responses": new Set(["model", "input", "instructions", "tools", "tool_choice", "stream", "previous_response_id"]),
  "anthropic-messages": new Set(["model", "messages", "system", "tools", "tool_choice", "stream"]),
  "google-generative-language": new Set(["contents", "systemInstruction", "tools", "toolConfig"])
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursive merge: objects merge key-by-key, everything else (arrays, scalars) replaces. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_PATH_KEYS.has(key)) throw new GatewayError("invalid_request", `passthrough key "${key}" is not allowed`);
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

/**
 * Merge raw passthrough keys into the body, warning per key (MIGRATION_PLAN §4.5).
 * With `scope`, the wire's CORE_BODY_KEYS are rejected (GatewayError
 * invalid_request) and object values deep-merge into what the codec already
 * wrote (e.g. passthrough `thinking: {display}` keeps the encoded `thinking.type`).
 */
export function applyPassthrough(
  body: Record<string, unknown>,
  passthrough: Record<string, unknown> | undefined,
  warnings: Warning[],
  scope?: { wire: WireProtocol; provider: string }
): void {
  const entries = Object.entries(passthrough ?? {});
  const core = scope ? CORE_BODY_KEYS[scope.wire] : undefined;
  // validate every key before mutating anything — a rejected request leaves the body untouched
  for (const [key] of entries) {
    if (UNSAFE_PATH_KEYS.has(key)) throw new GatewayError("invalid_request", `passthrough key "${key}" is not allowed`, { provider: scope?.provider });
    if (core?.has(key)) {
      throw new GatewayError(
        "invalid_request",
        `passthrough key "${key}" is reserved by the ${scope!.wire} codec; set it through the typed request fields instead`,
        { provider: scope!.provider }
      );
    }
  }
  for (const [key, value] of entries) {
    const current = body[key];
    body[key] = scope && isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
    warnings.push({ code: "passthrough", param: key, message: `${key} sent unvalidated via passthrough` });
  }
}

/**
 * `prompt_cache_key` is an OpenAI API field: only the OpenAI provider itself
 * receives it (OpenRouter and other OpenAI-compatible providers do not document it).
 */
export function supportsPromptCacheKey(model: ResolvedModel): boolean {
  return model.providerId === "openai";
}

/** System content as one string (wires without system block arrays). */
export function systemText(content: string | TextBlock[]): string {
  return typeof content === "string" ? content : content.map((block) => block.text).join("\n\n");
}

/** True when a message (or one of its text blocks) carries a cache breakpoint. */
export function hasCacheMarker(message: ChatMessage): boolean {
  if (message.cacheControl) return true;
  return Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.cacheControl !== undefined);
}

/** Unified CacheControl → wire `cache_control` (Anthropic / OpenRouter share the shape). */
export function wireCacheControl(cacheControl: CacheControl): Record<string, unknown> {
  return cacheControl.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Enforce Anthropic's breakpoint rules on wire blocks in RENDER order
 * (tools → system → messages): at most 4 (`cache_control` removed from the
 * earliest extras), and a 1h breakpoint may not follow a 5m one (downgraded).
 * Each adjustment emits a `cache_ignored` warning.
 */
export function enforceCacheBreakpoints(blocks: Array<Record<string, unknown>>, provider: string, warnings: Warning[]): void {
  const marked = blocks.filter((block) => block.cache_control !== undefined);
  const excess = marked.length - MAX_CACHE_BREAKPOINTS;
  if (excess > 0) {
    for (const block of marked.slice(0, excess)) delete block.cache_control;
    warnings.push({
      code: "cache_ignored",
      param: "cacheControl",
      message: `${provider} allows at most ${MAX_CACHE_BREAKPOINTS} cache breakpoints; dropped the ${excess} earliest`
    });
  }
  let sawShort = false;
  let downgraded = 0;
  for (const block of marked.slice(Math.max(excess, 0))) {
    const control = block.cache_control as { ttl?: string };
    if (control.ttl === "1h" && sawShort) {
      block.cache_control = { type: "ephemeral" };
      downgraded++;
    } else if (control.ttl !== "1h") {
      sawShort = true;
    }
  }
  if (downgraded > 0) {
    warnings.push({
      code: "cache_ignored",
      param: "cacheControl",
      message: `${downgraded} 1h cache breakpoint(s) after a 5m breakpoint downgraded to 5m (longer TTLs must come first)`
    });
  }
}
