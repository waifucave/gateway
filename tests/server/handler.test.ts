import { describe, expect, it, vi } from "vitest";
import { createGatewayHandler } from "../../src/server/handler.js";
import { envCredentials } from "../../src/server/env.js";
import { jsonFetch, parseSseFrames, sseFetch } from "../helpers/http.js";

const get = (handler: ReturnType<typeof createGatewayHandler>, path: string, init?: RequestInit) =>
  handler.handle(new Request(`http://gateway.test${path}`, init));

describe("envCredentials", () => {
  it("resolves each provider's documented env var and treats empty as unset", () => {
    const lookup = envCredentials({ DEEPSEEK_API_KEY: "sk-env", ANTHROPIC_API_KEY: "" });
    expect(lookup("deepseek")).toBe("sk-env");
    expect(lookup("anthropic")).toBeUndefined();
    expect(lookup("openrouter")).toBeUndefined();
    expect(lookup("not-a-provider")).toBeUndefined();
  });
});

describe("GET /v1/providers", () => {
  it("lists all 14 providers with credential status", async () => {
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test", anthropic: "" } });
    const response = await get(handler, "/v1/providers");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: Array<Record<string, unknown>> };
    expect(body.providers).toHaveLength(14);
    const deepseek = body.providers.find((p) => p.id === "deepseek");
    expect(deepseek).toEqual({
      id: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      credentialEnv: "DEEPSEEK_API_KEY",
      wire: "openai-chat",
      credentialConfigured: true
    });
    // empty string counts as unconfigured; absent counts as unconfigured
    expect(body.providers.find((p) => p.id === "anthropic")?.credentialConfigured).toBe(false);
    expect(body.providers.find((p) => p.id === "openrouter")?.credentialConfigured).toBe(false);
  });

  it("supports credential lookup functions", async () => {
    const handler = createGatewayHandler({ credentials: (id) => (id === "xai" ? "sk-x" : undefined) });
    const body = (await (await get(handler, "/v1/providers")).json()) as { providers: Array<Record<string, unknown>> };
    expect(body.providers.find((p) => p.id === "xai")?.credentialConfigured).toBe(true);
    expect(body.providers.find((p) => p.id === "deepseek")?.credentialConfigured).toBe(false);
  });
});

describe("GET /v1/models", () => {
  it("returns all 100 routes with summary flags", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: Array<Record<string, unknown>> };
    expect(body.models).toHaveLength(100);
    expect(body.models.find((m) => m.providerId === "deepseek" && m.modelId === "deepseek-v4-pro")).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      family: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      company: "DeepSeek",
      wire: "openai-chat",
      contextTokens: 1000000,
      maxOutputTokens: 384000,
      streaming: true,
      tools: true,
      reasoning: true,
      jsonMode: true,
      jsonSchema: false,
      imageInput: false,
      deprecated: false,
      confidence: "verified"
    });
    const gpt = body.models.find((m) => m.providerId === "openai" && m.modelId === "gpt-5.5");
    expect(gpt).toMatchObject({
      family: "gpt-5-5",
      displayName: "GPT-5.5",
      wire: "openai-responses",
      contextTokens: 1050000,
      jsonSchema: true,
      imageInput: true,
      reasoning: true
    });
  });
});

describe("GET /v1/models/:provider/:model", () => {
  it("returns the full resolved capability doc", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models/deepseek/deepseek-v4-pro");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      wire: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      endpoint: "/chat/completions",
      limits: { contextTokens: 1000000, maxOutputTokens: 384000 }
    });
    expect(body.params).toHaveProperty("temperature");
    expect(Array.isArray(body.constraints)).toBe(true);
  });

  it("joins trailing segments so OpenRouter slash ids resolve", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models/openrouter/moonshotai/kimi-k2.6");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      providerId: "openrouter",
      modelId: "moonshotai/kimi-k2.6",
      family: "kimi-k2-6",
      displayName: "Kimi K2.6",
      baseUrl: "https://openrouter.ai/api/v1"
    });
  });

  it("404s for unknown models with a serialized error", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models/deepseek/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { kind: "invalid_request", message: "unknown model deepseek:nope", retryable: false }
    });
  });
});

describe("routing", () => {
  it("404s outside /v1 and for unknown /v1 paths", async () => {
    const handler = createGatewayHandler();
    expect((await get(handler, "/")).status).toBe(404);
    expect((await get(handler, "/api/llm/v1/providers")).status).toBe(404);
    expect((await get(handler, "/v1/nope")).status).toBe(404);
  });

  it("405s wrong methods on known paths with an allow header", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/providers", { method: "POST", body: "{}" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    const chat = await get(handler, "/v1/chat");
    expect(chat.status).toBe(405);
    expect(chat.headers.get("allow")).toBe("POST");
  });

  it("404s malformed percent-encoding instead of throwing", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models/deepseek/%E0%A4%A");
    expect(response.status).toBe(404);
  });

  it("tolerates trailing slashes and URL-encoded segments", async () => {
    const handler = createGatewayHandler();
    expect((await get(handler, "/v1/providers/")).status).toBe(200);
    expect((await get(handler, "/v1/models/deepseek/deepseek-v4-pro/")).status).toBe(200);
    expect((await get(handler, "/v1/models/deepseek/deepseek%2Dv4%2Dpro")).status).toBe(200);
  });
});

const post = (handler: ReturnType<typeof createGatewayHandler>, path: string, body: unknown) =>
  handler.handle(
    new Request(`http://gateway.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  );

describe("POST /v1/validate", () => {
  it("returns the pinned ValidationResult for an out-of-range param", async () => {
    const handler = createGatewayHandler();
    const response = await post(handler, "/v1/validate", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      params: { temperature: 99 }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      violations: [{ param: "temperature", code: "out_of_range", message: "temperature must be in [0, 2]" }],
      warnings: [
        { ruleId: "thinking-drops-sampling", param: "temperature", code: "dropped" },
        { ruleId: "thinking-drops-sampling", param: "topP", code: "dropped" }
      ],
      effectiveParams: { "reasoning.enabled": true, "reasoning.effort": "high" }
    });
  });

  it("reports forbidden tool choice under thinking (UI live-gating contract)", async () => {
    const handler = createGatewayHandler();
    const response = await post(handler, "/v1/validate", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      params: { "reasoning.enabled": true },
      toolChoice: "required"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; violations: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.violations).toContainEqual({
      ruleId: "thinking-no-forced-tools",
      param: "toolChoice",
      code: "forbidden_value",
      value: "required"
    });
  });

  it("accepts responseFormat as object or string", async () => {
    const handler = createGatewayHandler();
    // gpt-5.5 supports json_schema; deepseek-v4-pro does not
    const objectForm = await post(handler, "/v1/validate", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      params: { "reasoning.enabled": false },
      responseFormat: { type: "json_schema", schema: {} }
    });
    const stringForm = await post(handler, "/v1/validate", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      params: { "reasoning.enabled": false },
      responseFormat: "json_schema"
    });
    for (const response of [objectForm, stringForm]) {
      const body = (await response.json()) as { ok: boolean; violations: Array<{ code: string }> };
      expect(body.ok).toBe(false);
      expect(body.violations).toContainEqual(expect.objectContaining({ code: "unsupported_response_format" }));
    }
  });

  it("404s unknown models and 400s malformed bodies", async () => {
    const handler = createGatewayHandler();
    expect((await post(handler, "/v1/validate", { provider: "deepseek", model: "nope", params: {} })).status).toBe(404);
    expect((await post(handler, "/v1/validate", { provider: "", model: "x" })).status).toBe(400);
    expect((await post(handler, "/v1/validate", { provider: "deepseek", model: "deepseek-v4-pro", params: 5 })).status).toBe(400);
    expect((await post(handler, "/v1/validate", [1, 2])).status).toBe(400);
    const notJson = await handler.handle(
      new Request("http://gateway.test/v1/validate", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } })
    );
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({
      error: { kind: "invalid_request", message: "request body must be valid JSON", retryable: false }
    });
  });
});

describe("POST /v1/chat (non-streaming)", () => {
  const OK_PAYLOAD = {
    id: "cmpl_1",
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 }
  };

  it("encodes through the real pipeline and returns the normalized ChatResponse", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.7, "reasoning.enabled": true }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    // P1b golden wire body, verbatim
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }]
    });

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "cmpl_1",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 1 }
    });
    expect(body.warnings).toEqual([
      {
        code: "param_dropped",
        param: "temperature",
        ruleId: "thinking-drops-sampling",
        message: "temperature was dropped by constraint rule thinking-drops-sampling"
      },
      {
        code: "param_dropped",
        param: "topP",
        ruleId: "thinking-drops-sampling",
        message: "topP was dropped by constraint rule thinking-drops-sampling"
      }
    ]);
    expect(body.raw).toBeUndefined();
  });

  it("maps gateway failures to HTTP statuses: validation 400, missing credential 401, provider 401 → 401", async () => {
    const noCreds = createGatewayHandler({ fetchImpl: jsonFetch(OK_PAYLOAD) });
    const authResponse = await post(noCreds, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(authResponse.status).toBe(401);
    expect(await authResponse.json()).toEqual({
      error: { kind: "auth", message: "no credential configured for provider deepseek", provider: "deepseek", retryable: false }
    });

    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD) });
    const validation = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      toolChoice: "required",
      params: { "reasoning.enabled": true }
    });
    expect(validation.status).toBe(400);
    const validationBody = (await validation.json()) as { error: { kind: string } };
    expect(validationBody.error.kind).toBe("unsupported_parameter");

    const upstream401 = createGatewayHandler({
      credentials: { deepseek: "sk-bad" },
      fetchImpl: jsonFetch({ error: { message: "invalid api key" } }, 401)
    });
    const providerError = await post(upstream401, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false }
    });
    expect(providerError.status).toBe(401);
    const providerBody = (await providerError.json()) as { error: { kind: string; status: number } };
    expect(providerBody.error).toMatchObject({ kind: "auth", status: 401, provider: "deepseek" });
  });

  it("404s unknown models and 400s missing messages", async () => {
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD) });
    expect((await post(handler, "/v1/chat", { provider: "deepseek", model: "nope", messages: [] })).status).toBe(404);
    expect((await post(handler, "/v1/chat", { provider: "deepseek", model: "deepseek-v4-pro" })).status).toBe(400);
  });

  it("exposes raw only when the handler was created with includeRaw", async () => {
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD), includeRaw: true });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false }
    });
    expect(((await response.json()) as { raw: unknown }).raw).toEqual(OK_PAYLOAD);
  });

  it("400s a bare-string responseFormat instead of bypassing validation", async () => {
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD) });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false },
      responseFormat: "json_schema"
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("responseFormat must be an object");
  });

  it("400s non-array tools instead of a misleading 500", async () => {
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD) });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false },
      tools: "garbage"
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("tools must be an array");
  });
});

describe("POST /v1/chat (streaming SSE)", () => {
  const DEEPSEEK_SSE = [
    'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"y"},"finish_reason":"stop"}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    "",
    "data: [DONE]",
    ""
  ];

  it("streams normalized events as SSE frames ending with [DONE]", async () => {
    const fetchImpl = sseFetch(DEEPSEEK_SSE);
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.7, "reasoning.enabled": true },
      stream: true
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    });

    const frames = parseSseFrames(await response.text());
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "text-delta",
      "text-delta",
      "usage",
      "done",
      "[DONE]"
    ]);
    const done = frames[3] as { response: { content: unknown; warnings: Array<{ code: string; param: string }> } };
    expect(done.response.content).toEqual([{ type: "text", text: "hey" }]);
    expect(done.response.warnings.some((w) => w.code === "param_dropped" && w.param === "temperature")).toBe(true);
  });

  it("drives the openai-responses wire end to end (carryover #5)", async () => {
    const completed = {
      id: "resp_2",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi!" }] }],
      usage: { input_tokens: 3, output_tokens: 2 }
    };
    const fetchImpl = sseFetch([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"hi"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"!"}',
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: completed })}`,
      ""
    ]);
    const handler = createGatewayHandler({ credentials: { openai: "sk-oai" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: true
    });
    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-oai");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "gpt-5.5", stream: true });

    const frames = parseSseFrames(await response.text());
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "text-delta",
      "text-delta",
      "usage",
      "done",
      "[DONE]"
    ]);
    const done = frames[3] as { response: { content: unknown; finishReason: string } };
    expect(done.response.content).toEqual([{ type: "text", text: "hi!" }]);
    expect(done.response.finishReason).toBe("stop");
  });

  it("drives the google wire end to end (carryover #5)", async () => {
    const fetchImpl = sseFetch([
      'data: {"responseId":"r2","candidates":[{"content":{"parts":[{"text":"hm","thought":true}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"he"}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"llo"},{"functionCall":{"name":"lookup","args":{"q":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}',
      ""
    ]);
    const handler = createGatewayHandler({ credentials: { "google-ai-studio": "sk-goog" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "google-ai-studio",
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", parameters: { type: "object", properties: {} } }],
      stream: true
    });
    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("sk-goog");

    const frames = parseSseFrames(await response.text());
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "reasoning-delta",
      "text-delta",
      "text-delta",
      "tool-call-delta",
      "usage",
      "done",
      "[DONE]"
    ]);
    const done = frames[5] as { response: { content: Array<{ type: string }>; finishReason: string } };
    expect(done.response.finishReason).toBe("tool_calls");
    expect(done.response.content).toEqual([
      { type: "reasoning", text: "hm" },
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call_0", name: "lookup", arguments: '{"q":1}' }
    ]);
  });

  it("maps pre-I/O failures to HTTP statuses instead of a 200 SSE", async () => {
    const fetchImpl = sseFetch(DEEPSEEK_SSE);
    const withCreds = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const validation = await post(withCreds, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      toolChoice: "required",
      params: { "reasoning.enabled": true },
      stream: true
    });
    expect(validation.status).toBe(400);
    expect(validation.headers.get("content-type")).toBe("application/json");
    expect(fetchImpl).not.toHaveBeenCalled();

    const noCreds = createGatewayHandler({ fetchImpl });
    const auth = await post(noCreds, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: true
    });
    expect(auth.status).toBe(401);
  });

  it("delivers mid-stream failures as a serialized error event, then [DONE]", async () => {
    const fetchImpl = sseFetch(["data: {broken", ""]);
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false },
      stream: true
    });
    // the broken frame IS the first event: gateway.stream wraps decode failures as an error event,
    // so the probe yields {type:"error"} and the handler still answers 200 SSE. Pinned on purpose:
    // only pre-I/O throws become HTTP statuses.
    expect(response.status).toBe(200);
    const frames = parseSseFrames(await response.text());
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "error", error: { kind: expect.any(String), retryable: expect.any(Boolean) } });
    expect(frames[1]).toBe("[DONE]");
  });

  it("returns 499 for a request whose signal is already aborted (carryover #3)", async () => {
    const fetchImpl = sseFetch(DEEPSEEK_SSE);
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const controller = new AbortController();
    controller.abort(new Error("client gone"));
    const response = await handler.handle(
      new Request("http://gateway.test/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "deepseek",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          params: { "reasoning.enabled": false },
          stream: true
        }),
        signal: controller.signal
      })
    );
    expect(response.status).toBe(499);
  });

  it("aborts the upstream provider fetch when the SSE consumer cancels (client disconnect)", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      const encoder = new TextEncoder();
      // one frame, then the body stays open forever
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n'));
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false },
      stream: true
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("text-delta");
    expect(upstreamSignal?.aborted).toBe(false);
    await reader.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("survives an error event arriving into an orphaned pull after cancel (no unhandled rejection)", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      let failBody: (() => void) | undefined;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n'));
            // when the upstream aborts, error the body read like a real socket teardown
            init?.signal?.addEventListener("abort", () => failBody?.(), { once: true });
            failBody = () => controller.error(new Error("socket torn down"));
          }
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch;

      const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
      const response = await post(handler, "/v1/chat", {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { "reasoning.enabled": false },
        stream: true
      });
      const reader = response.body!.getReader();
      await reader.read(); // first frame; a pull for the second is now parked on iterator.next()
      await reader.cancel(); // aborts upstream → body errors → generator yields error event into the orphaned pull
      await new Promise((resolve) => setTimeout(resolve, 20)); // let the orphaned pull settle
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
