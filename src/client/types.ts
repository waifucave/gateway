import type { GatewayError } from "../errors.js";

export type TextBlock = { type: "text"; text: string };

/** `data` is base64-encoded image bytes. */
export type ImageBlock = { type: "image"; mimeType: string; data: string };

/**
 * Opaque reasoning content. `signature` (Anthropic) must round-trip on tool loops;
 * `redacted` + `data` carry Anthropic redacted_thinking blocks.
 */
export type ReasoningBlock = { type: "reasoning"; text: string; signature?: string; redacted?: boolean; data?: string };

/** `arguments` is the raw JSON text of the call arguments (consumers parse it; codecs that need objects parse internally). */
// signature: Gemini 3 thoughtSignature captured at decode; round-tripped on replay (other providers ignore it).
export type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: string; signature?: string };

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock;

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<TextBlock | ImageBlock> }
  | { role: "assistant"; content: string | Array<TextBlock | ReasoningBlock | ToolCallBlock> }
  | { role: "tool"; toolCallId: string; content: string };

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
  /** Merged raw into the wire body, unvalidated; each key emits a warning. */
  passthrough?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

export type Warning = {
  code: "param_dropped" | "param_forced" | "param_clamped" | "passthrough" | "unmapped_param";
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
