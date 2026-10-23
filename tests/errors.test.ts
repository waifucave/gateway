import { describe, expect, it } from "vitest";
import { GatewayError, extractErrorMessage, kindForStatus } from "../src/errors.js";

describe("kindForStatus", () => {
  it("maps statuses to the taxonomy", () => {
    expect(kindForStatus(400)).toBe("invalid_request");
    expect(kindForStatus(401)).toBe("auth");
    expect(kindForStatus(402)).toBe("billing");
    expect(kindForStatus(403)).toBe("auth");
    expect(kindForStatus(404)).toBe("invalid_request");
    expect(kindForStatus(408)).toBe("timeout");
    expect(kindForStatus(422)).toBe("invalid_request");
    expect(kindForStatus(429)).toBe("rate_limit");
    expect(kindForStatus(500)).toBe("server");
    expect(kindForStatus(503)).toBe("server");
  });

  it("upgrades 429 to quota when the provider error code says so", () => {
    expect(kindForStatus(429, { error: { code: "insufficient_quota", message: "x" } })).toBe("quota");
    expect(kindForStatus(429, { error: { type: "quota_exceeded", message: "x" } })).toBe("quota");
    expect(kindForStatus(429, { error: { code: "rate_limit_exceeded", message: "x" } })).toBe("rate_limit");
  });

  it("classifies billing exhaustion (402, credit balance, billing codes) as billing", () => {
    expect(kindForStatus(402, { error: { message: "Insufficient credits" } })).toBe("billing");
    expect(kindForStatus(429, { error: { code: "billing_hard_limit_reached", message: "x" } })).toBe("billing");
    expect(kindForStatus(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })).toBe("billing");
  });

  it("classifies Gemini per-day RESOURCE_EXHAUSTED as quota but per-minute as rate_limit", () => {
    const body = (quotaId: string) => ({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota",
        details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] }]
      }
    });
    expect(kindForStatus(429, body("GenerateRequestsPerDayPerProjectPerModel-FreeTier"))).toBe("quota");
    expect(kindForStatus(429, body("GenerateRequestsPerMinutePerProjectPerModel-FreeTier"))).toBe("rate_limit");
  });

  it("classifies context-window refusals as context_overflow", () => {
    expect(kindForStatus(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } })).toBe("context_overflow");
    expect(kindForStatus(400, { error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } })).toBe("context_overflow");
    expect(kindForStatus(400, { error: { message: "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens." } })).toBe("context_overflow");
    expect(kindForStatus(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "The input token count (461428) exceeds the maximum number of tokens allowed (131072)." } })).toBe("context_overflow");
    expect(kindForStatus(413, { error: { type: "request_too_large", message: "Request exceeds the maximum allowed number of bytes." } })).toBe("context_overflow");
    expect(kindForStatus(400, { error: { message: "Your request exceeded model token limit: 262144" } })).toBe("context_overflow");
    // an unrelated 400 that merely mentions tokens stays invalid_request
    expect(kindForStatus(400, { error: { message: "max_tokens must be at least 1" } })).toBe("invalid_request");
  });
});

describe("extractErrorMessage", () => {
  it("handles OpenAI, Anthropic, and Google error shapes plus plain text", () => {
    expect(extractErrorMessage({ error: { message: "bad key" } })).toBe("bad key");
    expect(extractErrorMessage({ error: { type: "invalid_request_error", message: "no model" } })).toBe("no model");
    expect(extractErrorMessage({ error: { code: 400, message: "stop limit", status: "INVALID_ARGUMENT" } })).toBe("stop limit");
    expect(extractErrorMessage({ message: "top-level" })).toBe("top-level");
    expect(extractErrorMessage("plain text body")).toBe("plain text body");
    expect(extractErrorMessage("")).toBe("(empty body)");
    expect(extractErrorMessage({ weird: true })).toBe('{"weird":true}');
  });

  it("never throws on unserializable bodies (error-path safety)", () => {
    expect(extractErrorMessage({ big: 1n })).toBe("(unserializable body)");
  });
});

describe("GatewayError", () => {
  it("defaults retryable from kind", () => {
    expect(new GatewayError("rate_limit", "x").retryable).toBe(true);
    expect(new GatewayError("server", "x").retryable).toBe(true);
    expect(new GatewayError("timeout", "x").retryable).toBe(true);
    expect(new GatewayError("network", "x").retryable).toBe(true);
    expect(new GatewayError("auth", "x").retryable).toBe(false);
    expect(new GatewayError("quota", "x").retryable).toBe(false);
    expect(new GatewayError("billing", "x").retryable).toBe(false);
    expect(new GatewayError("context_overflow", "x").retryable).toBe(false);
    expect(new GatewayError("invalid_request", "x").retryable).toBe(false);
    expect(new GatewayError("unsupported_parameter", "x", { retryable: true }).retryable).toBe(true);
  });

  it("fromHttp carries provider, status, raw and an extracted message", () => {
    const error = GatewayError.fromHttp("deepseek", 429, { error: { message: "slow down" } });
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.kind).toBe("rate_limit");
    expect(error.provider).toBe("deepseek");
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.raw).toEqual({ error: { message: "slow down" } });
    expect(error.message).toBe("deepseek returned HTTP 429: slow down");
    expect(error.name).toBe("GatewayError");
  });
});
