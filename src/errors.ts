export type GatewayErrorKind =
  | "auth"
  | "rate_limit"
  /** Usage quota exhausted (OpenAI insufficient_quota, Gemini per-day quota, plan usage windows). Not retryable. */
  | "quota"
  /** The account cannot pay: HTTP 402, credit balance too low, billing hard limit. Not retryable. */
  | "billing"
  /** The prompt does not fit the model's context window — compact and retry. Not retryable as-is. */
  | "context_overflow"
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

/**
 * HTTP status (+ provider error body) → kind. Body classification runs BEFORE
 * the transport's retry decision, so quota/billing 429s are never retried.
 */
export function kindForStatus(status: number, body?: unknown): GatewayErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || isBillingError(body)) return "billing";
  if (status === 408) return "timeout";
  if (status === 429) return isQuotaError(body) ? "quota" : "rate_limit";
  if (status >= 500) return "server";
  if ((status === 400 || status === 413) && isContextOverflow(status, body)) return "context_overflow";
  return "invalid_request";
}

function errorField(body: unknown): Record<string, unknown> | undefined {
  if (body !== null && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (e !== null && typeof e === "object") return e as Record<string, unknown>;
  }
  return undefined;
}

function errorCode(body: unknown): string {
  const e = errorField(body);
  return typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : "";
}

/** The provider's own error message only — never the whole body (echoed request fields must not trip a classifier). */
function errorMessageText(body: unknown): string {
  if (typeof body === "string") return body;
  const e = errorField(body);
  if (typeof e?.message === "string") return e.message;
  const top = body !== null && typeof body === "object" ? (body as Record<string, unknown>).message : undefined;
  return typeof top === "string" ? top : "";
}

/** Codes/messages meaning "the account cannot pay" — distinct from "going too fast". */
const BILLING_CODES = new Set(["billing_hard_limit_reached", "billing_not_active", "credit_balance_too_low", "insufficient_credits"]);
const BILLING_PHRASES = [/credit balance is too low/i, /insufficient (credits|balance|funds)/i, /requires more credits/i];

function isBillingError(body: unknown): boolean {
  if (BILLING_CODES.has(errorCode(body))) return true;
  const message = errorMessageText(body);
  return message !== "" && BILLING_PHRASES.some((phrase) => phrase.test(message));
}

function isQuotaError(body: unknown): boolean {
  const code = errorCode(body);
  if (code.includes("quota") || code.includes("insufficient") || code.startsWith("usage_limit")) return true;
  // Gemini answers BOTH per-minute and per-day exhaustion with 429 RESOURCE_EXHAUSTED;
  // only the per-day (and other non-minute) QuotaFailure violations are worth not retrying.
  const details = errorField(body)?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const violations = (detail as { violations?: unknown } | null)?.violations;
      if (!Array.isArray(violations)) continue;
      for (const violation of violations) {
        const quotaId = (violation as { quotaId?: unknown } | null)?.quotaId;
        if (typeof quotaId === "string" && /PerDay/i.test(quotaId)) return true;
      }
    }
  }
  return false;
}

/**
 * Context-window refusals, each phrased in the vendor's own words:
 * Anthropic "prompt is too long: N tokens > M maximum"; OpenAI code
 * `context_length_exceeded` ("Your input exceeds the context window" /
 * "This model's maximum context length is N tokens"); xAI "maximum prompt
 * length is N"; Gemini "The input token count (N) exceeds the maximum number
 * of tokens allowed"; Mistral/vLLM "too large for model with N maximum context
 * length"; Moonshot "exceeded model token limit"; OpenRouter relays the
 * upstream phrasing. Anthropic 413 `request_too_large` counts too.
 */
const CONTEXT_OVERFLOW_CODES = new Set(["context_length_exceeded", "exceed_context_size_error", "request_too_large"]);
const CONTEXT_OVERFLOW_PHRASES = [
  /prompt is too long/i,
  /maximum (prompt|context) length is \d+/i,
  /exceeds the context window/i,
  /input token count.{0,24}exceeds the maximum number of tokens/i,
  /too large for model with \d+ maximum context length/i,
  /exceeded model token limit/i,
  /exceeds the available context size/i,
  /context length exceeded/i
];

function isContextOverflow(status: number, body: unknown): boolean {
  const code = errorCode(body);
  if (CONTEXT_OVERFLOW_CODES.has(code) && (code !== "request_too_large" || status === 413)) return true;
  const message = errorMessageText(body);
  return message !== "" && CONTEXT_OVERFLOW_PHRASES.some((phrase) => phrase.test(message));
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
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return "(unserializable body)"; // never throw inside error handling
  }
  return serialized === undefined ? "(no body)" : serialized.slice(0, 500);
}
