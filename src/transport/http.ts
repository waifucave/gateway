import { GatewayError } from "../errors.js";

export type HttpRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

export type HttpOptions = {
  fetchImpl?: typeof fetch;
  /** Time to response HEADERS (not whole stream). Default 120s. */
  timeoutMs?: number;
  /** Retries after the first attempt, on rate-limit 429s/5xx/network errors (never quota/billing). Default 2. */
  maxRetries?: number;
  /** Base backoff delay; doubles per attempt, with jitter. Default 500ms (set 1 in tests). */
  retryBaseDelayMs?: number;
  signal?: AbortSignal;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(); // loop's pre-abort check will throw the caller's reason
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function retryDelayMs(attempt: number, base: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const trimmed = retryAfter.trim();
    const seconds = Number(trimmed);
    if (trimmed !== "" && Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  const exponential = base * 2 ** attempt;
  return Math.min(exponential + Math.random() * exponential, 10_000);
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * POST with retries on 429/5xx/network failures. The timeout covers time to
 * response headers only; for streaming, the caller keeps reading the body and
 * the caller's `signal` stays wired to it (we deliberately do not remove the
 * abort listener on the success path).
 */
export async function fetchWithRetry(provider: string, request: HttpRequest, options: HttpOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 2;
  const base = options.retryBaseDelayMs ?? 500;

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error(String(options.signal.reason ?? "aborted"));

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
    } catch (cause) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) throw cause; // user abort wins — propagate untouched
      if (timedOut) throw new GatewayError("timeout", `${provider} did not respond within ${timeoutMs}ms`, { provider, cause });
      if (attempt < maxRetries) {
        await sleep(retryDelayMs(attempt, base), options.signal);
        continue;
      }
      throw new GatewayError("network", `network error calling ${provider}: ${String(cause)}`, { provider, cause });
    }
    clearTimeout(timer);

    if (response.ok) return response; // keep the user-abort wiring alive for body consumption

    options.signal?.removeEventListener("abort", onAbort);
    // 429s are classified from the body BEFORE deciding to retry: a quota or
    // billing exhaustion (insufficient_quota, credit balance, per-day quota)
    // is terminal and backoff only delays the truth.
    if (response.status === 429) {
      const error = GatewayError.fromHttp(provider, response.status, await parseBody(response));
      if (!error.retryable || attempt >= maxRetries) throw error;
      await sleep(retryDelayMs(attempt, base, response), options.signal);
      continue;
    }
    if (response.status >= 500 && attempt < maxRetries) {
      await response.body?.cancel().catch(() => {});
      await sleep(retryDelayMs(attempt, base, response), options.signal);
      continue;
    }
    throw GatewayError.fromHttp(provider, response.status, await parseBody(response));
  }
}
