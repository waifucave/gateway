import { GatewayError, type GatewayErrorKind } from "../errors.js";

/** GatewayError kind → HTTP status for the gateway's own API responses. */
const STATUS_FOR_KIND: Record<GatewayErrorKind, number> = {
  auth: 401,
  rate_limit: 429,
  quota: 402,
  invalid_request: 400,
  unsupported_parameter: 400,
  content_filter: 422,
  timeout: 504,
  server: 502,
  network: 502
};

export function httpStatusForError(error: GatewayError): number {
  return STATUS_FOR_KIND[error.kind];
}

export type SerializedGatewayError = {
  kind: GatewayErrorKind;
  message: string;
  provider?: string;
  status?: number;
  retryable: boolean;
};

/** JSON-safe projection of a GatewayError. Drops raw/cause: provider bodies can be huge or unserializable. */
export function serializeGatewayError(error: GatewayError): SerializedGatewayError {
  const out: SerializedGatewayError = { kind: error.kind, message: error.message, retryable: error.retryable };
  if (error.provider !== undefined) out.provider = error.provider;
  if (error.status !== undefined) out.status = error.status;
  return out;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * One error→Response path for the whole HTTP layer. Carryover #3 normalization:
 * chat() rejects with the RAW abort reason (not a GatewayError) when the caller
 * aborts, and stream()'s first next() does the same pre-I/O — both land here and
 * become a uniform 499 when the request signal is aborted.
 */
export function errorResponse(error: unknown, signal?: AbortSignal): Response {
  if (error instanceof GatewayError) {
    return jsonResponse(httpStatusForError(error), { error: serializeGatewayError(error) });
  }
  if (signal?.aborted) {
    return jsonResponse(499, { error: { kind: "network", message: "client aborted the request", retryable: false } });
  }
  return jsonResponse(500, { error: { kind: "server", message: `unexpected error: ${String(error)}`, retryable: false } });
}
