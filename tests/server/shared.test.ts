import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/errors.js";
import { errorResponse, httpStatusForError, jsonResponse, serializeGatewayError } from "../../src/server/shared.js";

describe("httpStatusForError", () => {
  it("maps every GatewayError kind to a status", () => {
    const expected: Array<[ConstructorParameters<typeof GatewayError>[0], number]> = [
      ["auth", 401],
      ["rate_limit", 429],
      ["quota", 402],
      ["invalid_request", 400],
      ["unsupported_parameter", 400],
      ["content_filter", 422],
      ["timeout", 504],
      ["server", 502],
      ["network", 502]
    ];
    for (const [kind, status] of expected) {
      expect(httpStatusForError(new GatewayError(kind, "x")), kind).toBe(status);
    }
  });
});

describe("serializeGatewayError", () => {
  it("keeps kind/message/provider/status/retryable and drops raw and cause", () => {
    const error = new GatewayError("rate_limit", "slow down", {
      provider: "deepseek",
      status: 429,
      raw: { secret: "do-not-leak" },
      cause: new Error("inner")
    });
    expect(serializeGatewayError(error)).toEqual({
      kind: "rate_limit",
      message: "slow down",
      provider: "deepseek",
      status: 429,
      retryable: true
    });
  });

  it("omits provider/status when absent", () => {
    expect(serializeGatewayError(new GatewayError("invalid_request", "bad"))).toEqual({
      kind: "invalid_request",
      message: "bad",
      retryable: false
    });
  });
});

describe("jsonResponse", () => {
  it("builds a JSON response with the given status", async () => {
    const response = jsonResponse(418, { hello: "world" });
    expect(response.status).toBe(418);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ hello: "world" });
  });
});

describe("errorResponse", () => {
  it("maps GatewayErrors through the status table", async () => {
    const response = errorResponse(new GatewayError("auth", "no key", { provider: "xai" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { kind: "auth", message: "no key", provider: "xai", retryable: false }
    });
  });

  it("returns 499 network for non-GatewayError failures when the request signal is aborted (carryover #3 normalization)", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client went away"));
    const response = errorResponse(new Error("client went away"), controller.signal);
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({
      error: { kind: "network", message: "client aborted the request", retryable: false }
    });
  });

  it("returns 500 server for unexpected non-GatewayError failures", async () => {
    const response = errorResponse(new TypeError("boom"));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe("server");
    expect(body.error.message).toContain("boom");
  });

  it("prefers the GatewayError mapping even when the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(errorResponse(new GatewayError("unsupported_parameter", "x"), controller.signal).status).toBe(400);
  });
});
