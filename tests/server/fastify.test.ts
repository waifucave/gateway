import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import gatewayPluginDefault, { gatewayPlugin } from "../../src/server/fastify.js";
import { jsonFetch, parseSseFrames, sseFetch } from "../helpers/http.js";

const OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

describe("gatewayPlugin", () => {
  it("serves the registry endpoints under a prefix", async () => {
    app = fastify();
    await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: { deepseek: "sk-test" } });
    const providers = await app.inject({ method: "GET", url: "/api/llm/v1/providers" });
    expect(providers.statusCode).toBe(200);
    expect((providers.json() as { providers: unknown[] }).providers).toHaveLength(14);

    const detail = await app.inject({ method: "GET", url: "/api/llm/v1/models/openrouter/moonshotai/kimi-k2.6" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ providerId: "openrouter", modelId: "moonshotai/kimi-k2.6" });

    const missing = await app.inject({ method: "GET", url: "/api/llm/v1/nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("posts chat through the raw-string body path", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    app = fastify();
    await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/v1/chat",
      headers: { "content-type": "application/json" },
      payload: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { temperature: 0.7, "reasoning.enabled": true }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(response.json()).toMatchObject({ content: [{ type: "text", text: "hello" }], finishReason: "stop" });
  });

  it("streams SSE chat responses", async () => {
    const fetchImpl = sseFetch([
      'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"y"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      ""
    ]);
    app = fastify();
    await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/v1/chat",
      headers: { "content-type": "application/json" },
      payload: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { "reasoning.enabled": false },
        stream: true
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    const frames = parseSseFrames(response.body);
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "text-delta",
      "text-delta",
      "done",
      "[DONE]"
    ]);
  });

  it("maps validation failures to 400 (probe works through fastify)", async () => {
    app = fastify();
    await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: { deepseek: "sk-test" } });
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/v1/chat",
      headers: { "content-type": "application/json" },
      payload: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        toolChoice: "required",
        params: { "reasoning.enabled": true },
        stream: true
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("does not hijack the host app's JSON body parsing (scoped content-type parser)", async () => {
    app = fastify();
    app.post("/echo", async (request) => request.body);
    await app.register(gatewayPlugin, { prefix: "/api/llm" });
    const echo = await app.inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload: { a: 1 } });
    expect(echo.statusCode).toBe(200);
    expect(echo.json()).toEqual({ a: 1 });
  });

  it("works without a prefix and is also the default export", async () => {
    app = fastify();
    await app.register(gatewayPluginDefault);
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { models: unknown[] }).models).toHaveLength(100);
  });
});
