export type GatewayErrorKind =
  | "auth"
  | "rate_limit"
  | "quota"
  | "invalid_request"
  | "unsupported_parameter"
  | "content_filter"
  | "timeout"
  | "server"
  | "network";

const RETRYABLE_KINDS: ReadonlySet<GatewayErrorKind> = new Set(["rate_limit", "timeout", "server", "network"]);

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly raw?: unknown;

  constructor(
    kind: GatewayErrorKind,
    message: string,
    opts: { provider?: string; status?: number; raw?: unknown; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GatewayError";
    this.kind = kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.raw = opts.raw;
    this.retryable = opts.retryable ?? RETRYABLE_KINDS.has(kind);
  }

  static fromHttp(provider: string, status: number, body: unknown): GatewayError {
    return new GatewayError(kindForStatus(status, body), `${provider} returned HTTP ${status}: ${extractErrorMessage(body)}`, {
      provider,
      status,
      raw: body
    });
  }
}

export function kindForStatus(status: number, body?: unknown): GatewayErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 408) return "timeout";
  if (status === 429) return isQuotaError(body) ? "quota" : "rate_limit";
  if (status >= 500) return "server";
  return "invalid_request";
}

function errorField(body: unknown): Record<string, unknown> | undefined {
  if (body !== null && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (e !== null && typeof e === "object") return e as Record<string, unknown>;
  }
  return undefined;
}

function isQuotaError(body: unknown): boolean {
  const e = errorField(body);
  const code = typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : "";
  return code.includes("quota") || code.includes("insufficient");
}

/** Handles OpenAI `{error:{message}}`, Anthropic `{error:{type,message}}`, Google `{error:{code,message,status}}`, top-level `{message}`, and plain text. */
export function extractErrorMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 500) || "(empty body)";
  const e = errorField(body);
  if (e && typeof e.message === "string" && e.message !== "") return e.message;
  if (body !== null && typeof body === "object") {
    const msg = (body as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  const serialized = JSON.stringify(body);
  return serialized === undefined ? "(no body)" : serialized.slice(0, 500);
}
