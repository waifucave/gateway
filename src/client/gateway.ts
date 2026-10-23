import { Registry, type ModelRef } from "../registry/loader.js";
import { validateRequest, type ValidateInput, type ValidationResult } from "../validate/validateRequest.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ConstraintWarning } from "../validate/constraints.js";
import { codecFor } from "../codecs/index.js";
import type { EncodedRequest } from "../codecs/types.js";
import { fetchWithRetry } from "../transport/http.js";
import { parseSse, withIdleTimeout } from "../transport/sse.js";
import { GatewayError } from "../errors.js";
import type { ChatRequest, ChatResponse, ContentBlock, StreamEvent, Warning } from "./types.js";

export type GatewayOptions = {
  /** providerId → API key, or a lookup function. The gateway never persists keys. */
  credentials?: Record<string, string> | ((providerId: string) => string | undefined);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Override the capability-data directory (tests). */
  dataDir?: string;
  /** Attach the raw provider payload to ChatResponse.raw (non-streaming only). */
  includeRaw?: boolean;
  /**
   * stream(): abort with a `timeout` error when no bytes arrive for this long
   * between chunks (stall guard; pings count as activity). Default 60s; 0 disables.
   */
  streamIdleTimeoutMs?: number;
};

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

const WARNING_CODES = { dropped: "param_dropped", forced: "param_forced", clamped: "param_clamped" } as const;

function toWarnings(warnings: ConstraintWarning[]): Warning[] {
  return warnings.map((warning) => ({
    code: WARNING_CODES[warning.code],
    param: warning.param,
    ruleId: warning.ruleId,
    message: `${warning.param} was ${warning.code} by constraint rule ${warning.ruleId}`
  }));
}

function violationSummary(result: ValidationResult): string {
  return result.violations
    .map((violation) =>
      "message" in violation && violation.message !== undefined ? `${violation.param}: ${violation.message}` : `${violation.param}: ${violation.code} (rule ${violation.ruleId})`
    )
    .join("; ");
}

/**
 * `reasoning.exclude`: hide reasoning TEXT from the normalized response while
 * keeping whatever must round-trip (signatures, redacted data, OpenRouter
 * details). Blocks with nothing left to replay are dropped entirely.
 */
function hideReasoning(content: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type !== "reasoning") {
      out.push(block);
      continue;
    }
    const { text: _text, ...rest } = block;
    const keep = rest.signature !== undefined || rest.redacted === true || rest.data !== undefined || (rest.details?.length ?? 0) > 0;
    if (keep) out.push({ ...rest, type: "reasoning", text: "", ...(rest.details ? { details: rest.details.map(stripDetailText) } : {}) });
  }
  return out;
}

function stripDetailText(detail: Record<string, unknown>): Record<string, unknown> {
  // reasoning.text / reasoning.summary carry the readable text; signatures and
  // encrypted data stay. OpenRouter accepts details with an empty text.
  return "text" in detail || "summary" in detail
    ? { ...detail, ...("text" in detail ? { text: "" } : {}), ...("summary" in detail ? { summary: "" } : {}) }
    : detail;
}

export class Gateway {
  readonly registry: Registry;
  private readonly options: GatewayOptions;

  constructor(options: GatewayOptions = {}) {
    this.options = options;
    this.registry = Registry.load(options.dataDir);
  }

  listModels(): ModelRef[] {
    return this.registry.listModels();
  }

  getCapabilities(provider: string, model: string): ResolvedModel | undefined {
    return this.registry.resolve(provider, model);
  }

  validate(provider: string, model: string, input: ValidateInput): ValidationResult {
    return validateRequest(this.resolveOrThrow(provider, model), input);
  }

  /**
   * Abort contract (P1b carryover #3): if `request.signal` aborts, chat()
   * rejects with the RAW abort reason, not a GatewayError — user aborts must
   * stay distinguishable from provider failures. stream() differs: mid-stream
   * aborts arrive as a final `error` event of kind "network". The HTTP layer
   * normalizes both to a 499 response (see server/shared.ts errorResponse).
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { model, encoded, warnings, excludeReasoning } = this.prepare(request, false);
    const response = await fetchWithRetry(model.providerId, encoded, this.transportOptions(request.signal));
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} returned a non-JSON response body`, { provider: model.providerId, cause });
    }
    // codecs cast payload to their wire shape — a literal JSON null/scalar must not reach them
    if (payload === null || typeof payload !== "object") {
      throw new GatewayError("server", `${model.providerId} returned an unexpected non-object response`, { provider: model.providerId, raw: payload });
    }
    const decoded = codecFor(model.wire).decodeResponse(model, payload);
    decoded.warnings = [...warnings, ...decoded.warnings];
    if (excludeReasoning) decoded.content = hideReasoning(decoded.content);
    if (this.options.includeRaw) decoded.raw = payload;
    return decoded;
  }

  /**
   * Pre-I/O failures (unknown model, validation, credentials) THROW;
   * transport/provider/decode failures arrive as a final `error` event.
   * Aborts mid-stream surface as an `error` event of kind "network" (see chat()'s abort contract).
   */
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { model, encoded, warnings, excludeReasoning } = this.prepare(request, true);
    // Own controller linked to the caller's signal so a stall can abort the
    // upstream fetch/body without being mistaken for a user abort.
    const upstream = new AbortController();
    const onAbort = () => upstream.abort(request.signal?.reason);
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    const idleMs = this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    try {
      const response = await fetchWithRetry(model.providerId, encoded, this.transportOptions(upstream.signal));
      if (!response.body) throw new GatewayError("server", `${model.providerId} returned no response body`, { provider: model.providerId });
      const body = withIdleTimeout(response.body, idleMs, () => {
        const error = new GatewayError("timeout", `${model.providerId} stream stalled: no data for ${idleMs}ms`, { provider: model.providerId });
        upstream.abort(error);
        return error;
      });
      for await (const event of codecFor(model.wire).decodeStream(model, parseSse(body))) {
        if (excludeReasoning && event.type === "reasoning-delta") continue;
        if (event.type === "done") {
          event.response.warnings = [...warnings, ...event.response.warnings];
          if (excludeReasoning) event.response.content = hideReasoning(event.response.content);
        }
        yield event;
      }
    } catch (cause) {
      yield {
        type: "error",
        error: cause instanceof GatewayError ? cause : new GatewayError("network", `stream failed: ${String(cause)}`, { provider: model.providerId, cause })
      };
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  private prepare(
    request: ChatRequest,
    stream: boolean
  ): { model: ResolvedModel; encoded: EncodedRequest; warnings: Warning[]; excludeReasoning: boolean } {
    const model = this.resolveOrThrow(request.provider, request.model);
    const validation = validateRequest(model, {
      params: request.params ?? {},
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat?.type,
      stream
    });
    // carryover #5: effectiveParams is only meaningful when ok — never encode a rejected request
    if (!validation.ok) {
      throw new GatewayError("unsupported_parameter", `invalid request for ${model.providerId}:${model.modelId} — ${violationSummary(validation)}`, {
        provider: model.providerId,
        raw: validation.violations
      });
    }
    const apiKey = this.credentialFor(model.providerId);
    if (apiKey === undefined || apiKey === "") {
      throw new GatewayError("auth", `no credential configured for provider ${model.providerId}`, { provider: model.providerId });
    }
    const encoded = codecFor(model.wire).encode(
      model,
      {
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        responseFormat: request.responseFormat,
        effectiveParams: validation.effectiveParams,
        passthrough: request.passthrough,
        stream
      },
      apiKey
    );
    return {
      model,
      encoded,
      warnings: [...toWarnings(validation.warnings), ...encoded.warnings],
      excludeReasoning: validation.effectiveParams["reasoning.exclude"] === true
    };
  }

  private resolveOrThrow(provider: string, model: string): ResolvedModel {
    const resolved = this.registry.resolve(provider, model);
    if (!resolved) throw new GatewayError("invalid_request", `unknown model ${provider}:${model}`, { provider });
    return resolved;
  }

  private credentialFor(providerId: string): string | undefined {
    const credentials = this.options.credentials;
    return typeof credentials === "function" ? credentials(providerId) : credentials?.[providerId];
  }

  private transportOptions(signal?: AbortSignal) {
    return {
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      retryBaseDelayMs: this.options.retryBaseDelayMs,
      signal
    };
  }
}

export function createGateway(options: GatewayOptions = {}): Gateway {
  return new Gateway(options);
}
