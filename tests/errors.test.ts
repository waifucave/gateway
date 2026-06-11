import { describe, expect, it } from "vitest";
import { GatewayError, extractErrorMessage, kindForStatus } from "../src/errors.js";

describe("kindForStatus", () => {
  it("maps statuses to the taxonomy", () => {
    expect(kindForStatus(400)).toBe("invalid_request");
    expect(kindForStatus(401)).toBe("auth");
    expect(kindForStatus(402)).toBe("quota");
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
