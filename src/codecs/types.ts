import type { ResolvedModel, WireProtocol } from "../registry/types.js";
import type { ChatMessage, ChatResponse, ResponseFormat, StreamEvent, ToolChoice, ToolDef, Warning } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";

export type CodecRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  /**
   * `validateRequest(...).effectiveParams` — the codec's ONLY parameter source.
   * Callers MUST gate on `ValidationResult.ok` before encoding.
   */
  effectiveParams: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  stream: boolean;
};

export type EncodedRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  warnings: Warning[];
};

export interface Codec {
  readonly wire: WireProtocol;
  encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest;
  decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse;
  /** Throws GatewayError on malformed/error frames; ends with a `done` event. */
  decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncIterable<StreamEvent>;
}
