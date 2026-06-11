import { Registry, type ModelRef } from "../registry/loader.js";
import { validateRequest, type ValidateInput, type ValidationResult } from "../validate/validateRequest.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ConstraintWarning } from "../validate/constraints.js";
import { codecFor } from "../codecs/index.js";
import type { EncodedRequest } from "../codecs/types.js";
import { fetchWithRetry } from "../transport/http.js";
import { parseSse } from "../transport/sse.js";
import { GatewayError } from "../errors.js";
import type { ChatRequest, ChatResponse, StreamEvent, Warning } from "./types.js";

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
};

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
    const { model, encoded, warnings } = this.prepare(request, false);
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
    if (this.options.includeRaw) decoded.raw = payload;
    return decoded;
  }

  /**
   * Pre-I/O failures (unknown model, validation, credentials) THROW;
   * transport/provider/decode failures arrive as a final `error` event.
   * Aborts mid-stream surface as an `error` event of kind "network" (see chat()'s abort contract).
   */
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { model, encoded, warnings } = this.prepare(request, true);
    try {
      const response = await fetchWithRetry(model.providerId, encoded, this.transportOptions(request.signal));
      if (!response.body) throw new GatewayError("server", `${model.providerId} returned no response body`, { provider: model.providerId });
      for await (const event of codecFor(model.wire).decodeStream(model, parseSse(response.body))) {
        if (event.type === "done") event.response.warnings = [...warnings, ...event.response.warnings];
        yield event;
      }
    } catch (cause) {
      yield {
        type: "error",
        error: cause instanceof GatewayError ? cause : new GatewayError("network", `stream failed: ${String(cause)}`, { provider: model.providerId, cause })
      };
    }
  }

  private prepare(request: ChatRequest, stream: boolean): { model: ResolvedModel; encoded: EncodedRequest; warnings: Warning[] } {
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
    return { model, encoded, warnings: [...toWarnings(validation.warnings), ...encoded.warnings] };
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
