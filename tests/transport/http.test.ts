import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../../src/errors.js";
import { fetchWithRetry } from "../../src/transport/http.js";

const REQ = { url: "https://api.example.com/chat", headers: { "content-type": "application/json" }, body: { model: "m" } };
const FAST = { maxRetries: 2, retryBaseDelayMs: 1, timeoutMs: 5_000 };

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}

describe("fetchWithRetry", () => {
  it("returns the first successful response and sends the JSON body", async () => {
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(url).toBe(REQ.url);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ model: "m" });
      return json({ ok: true });
    });
    const response = await fetchWithRetry("deepseek", REQ, { ...FAST, fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 429 (honoring Retry-After) and 5xx, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { message: "slow" } }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(json({ error: { message: "boom" } }, 500))
      .mockResolvedValueOnce(json({ ok: true }));
    const response = await fetchWithRetry("deepseek", REQ, { ...FAST, fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws GatewayError rate_limit when retries are exhausted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: { message: "slow" } }, 429));
    const error = await fetchWithRetry("deepseek", REQ, { ...FAST, fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.kind).toBe("rate_limit");
    expect(error.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });

  it("does NOT retry 4xx and extracts the provider message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: { message: "bad param" } }, 400));
    const error = await fetchWithRetry("openai", REQ, { ...FAST, fetchImpl }).catch((e) => e);
    expect(error.kind).toBe("invalid_request");
    expect(error.message).toBe("openai returned HTTP 400: bad param");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries network errors, then surfaces GatewayError network", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const error = await fetchWithRetry("xai", REQ, { ...FAST, fetchImpl }).catch((e) => e);
    expect(error.kind).toBe("network");
    expect(error.retryable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("recovers when a network error is followed by success", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json({ ok: true }));
    const response = await fetchWithRetry("xai", REQ, { ...FAST, fetchImpl });
    expect(response.status).toBe(200);
  });

  it("aborts with GatewayError timeout when the provider hangs", async () => {
    const fetchImpl = vi.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
        })
    );
    const error = await fetchWithRetry("moonshot", REQ, { fetchImpl, timeoutMs: 20, maxRetries: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.kind).toBe("timeout");
  });

  it("propagates the caller's abort as-is (not as timeout)", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("user aborted")));
        })
    );
    setTimeout(() => controller.abort(), 10);
    const error = await fetchWithRetry("zai", REQ, { fetchImpl, timeoutMs: 5_000, signal: controller.signal }).catch((e) => e);
    expect(error).not.toBeInstanceOf(GatewayError);
    expect(error.message).toBe("user aborted");
  });

  it("rejects immediately when called with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    const fetchImpl = vi.fn();
    const error = await fetchWithRetry("zai", REQ, { fetchImpl, signal: controller.signal }).catch((e) => e);
    expect(error.message).toBe("pre-aborted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
