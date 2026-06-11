import { GatewayError } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { Warning } from "../client/types.js";

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
  "reasoning.budgetTokens": "reasoning.max_tokens",
  "reasoning.exclude": "reasoning.exclude"
};

export function mapOpenRouterParams(model: ResolvedModel, effectiveParams: Record<string, unknown>): MappedParams {
  const wire: Record<string, unknown> = {};
  const warnings: Warning[] = [];
  for (const [name, value] of Object.entries(effectiveParams)) {
    if (value === undefined || DIRECTIVE_PARAMS.has(name)) continue;
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

/** Merge raw passthrough keys into the body, warning per key (MIGRATION_PLAN §4.5). */
export function applyPassthrough(body: Record<string, unknown>, passthrough: Record<string, unknown> | undefined, warnings: Warning[]): void {
  for (const [key, value] of Object.entries(passthrough ?? {})) {
    body[key] = value;
    warnings.push({ code: "passthrough", param: key, message: `${key} sent unvalidated via passthrough` });
  }
}
