import type { GatewayError } from "../errors.js";

/**
 * Provider-agnostic prompt-cache breakpoint: "cache everything up to and
 * including this block". Anthropic → `cache_control` (max 4 per request);
 * OpenRouter Anthropic/Gemini routes → `cache_control` on content parts;
 * OpenAI/Google/others cache implicitly and ignore it. Default TTL 5m.
 */
export type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

export type TextBlock = { type: "text"; text: string; cacheControl?: CacheControl };

/** `data` is base64-encoded image bytes. */
export type ImageBlock = { type: "image"; mimeType: string; data: string };

/**
 * Opaque reasoning content. `signature` (Anthropic) must round-trip on tool loops;
 * `redacted` + `data` carry Anthropic redacted_thinking blocks; `details` carries
 * OpenRouter's `reasoning_details` array verbatim (signatures / encrypted
 * reasoning) and is replayed on OpenRouter routes. Pass reasoning blocks back
 * unchanged on tool loops — the codecs decide what each wire needs.
 */
export type ReasoningBlock = {
  type: "reasoning";
  text: string;
  signature?: string;
  redacted?: boolean;
  data?: string;
  details?: Array<Record<string, unknown>>;
  /**
   * Set instead of `text` when `reasoning.exclude` hid the reasoning: the
   * verbatim original, kept ONLY so the block replays byte-exact (Anthropic
   * rejects modified thinking blocks). Opaque — never display it.
   */
  replay?: string;
};

/** `arguments` is the raw JSON text of the call arguments (consumers parse it; codecs that need objects parse internally). */
// signature: Gemini 3 thoughtSignature captured at decode; round-tripped on replay (other providers ignore it).
export type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: string; signature?: string };

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock;

/**
 * `cacheControl` on a message marks its LAST block as a cache breakpoint
 * (block-level `TextBlock.cacheControl` marks one block). System content may
 * be an array of text blocks so a static prefix can be marked separately;
 * wires without block arrays join system blocks with "\n\n".
 */
export type ChatMessage =
  | { role: "system"; content: string | TextBlock[]; cacheControl?: CacheControl }
  | { role: "user"; content: string | Array<TextBlock | ImageBlock>; cacheControl?: CacheControl }
  | { role: "assistant"; content: string | Array<TextBlock | ReasoningBlock | ToolCallBlock>; cacheControl?: CacheControl }
  | { role: "tool"; toolCallId: string; content: string; cacheControl?: CacheControl };

/** Tools are defined ONCE in JSON Schema; codecs translate per wire. */
export type ToolDef = { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; name?: string; schema: Record<string, unknown>; strict?: boolean };

export type ChatRequest = {
  provider: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  /** Validated against the capability doc (including provider-scoped dotted keys). */
  params?: Record<string, unknown>;
  /** Merged raw into the wire body, unvalidated; each key emits a warning. Core keys (model, messages, …) are rejected. */
  passthrough?: Record<string, unknown>;
  /** Cache-routing key for providers that take one (OpenAI `prompt_cache_key`), e.g. `waifu:<id>:<conversation>`. */
  promptCacheKey?: string;
  signal?: AbortSignal;
};

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

/**
 * ONE convention for every provider:
 * - `inputTokens` = the WHOLE prompt, including cache reads and cache writes
 *   (Anthropic's input_tokens + cache_read + cache_creation; OpenAI/Gemini/
 *   OpenRouter already report the total).
 * - `outputTokens` = all generated tokens, INCLUDING reasoning (Gemini's
 *   candidates + thoughts).
 * - `cacheReadTokens` / `cacheWriteTokens` / `cacheWrite1hTokens` and
 *   `reasoningTokens` are SUBSETS of the above, never added on top; absent when
 *   the provider does not report them.
 * - `costUsd`: OpenRouter's reported `usage.cost`, else computed from catalog
 *   pricing (see computeCostUsd); absent when pricing is unknown.
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Part of cacheWriteTokens written with the 1-hour TTL (Anthropic). */
  cacheWrite1hTokens?: number;
  /** @deprecated alias of `cacheReadTokens`, kept for 0.3.x consumers. */
  cachedInputTokens?: number;
  costUsd?: number;
};

export type Warning = {
  code: "param_dropped" | "param_forced" | "param_clamped" | "passthrough" | "unmapped_param" | "content_dropped" | "cache_ignored";
  param: string;
  ruleId?: string;
  message: string;
};

export type ChatResponse = {
  id: string;
  provider: string;
  model: string;
  content: ContentBlock[];
  finishReason: FinishReason;
  usage: Usage;
  warnings: Warning[];
  /** Original provider payload; attached only when the gateway is created with `includeRaw`. */
  raw?: unknown;
};

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; response: ChatResponse }
  | { type: "error"; error: GatewayError };
