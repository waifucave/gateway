import { describe, expect, it } from "vitest";
import { createGatewayHandler } from "../../src/server/handler.js";
import { envCredentials } from "../../src/server/env.js";

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

  it("tolerates trailing slashes and URL-encoded segments", async () => {
    const handler = createGatewayHandler();
    expect((await get(handler, "/v1/providers/")).status).toBe(200);
    expect((await get(handler, "/v1/models/deepseek/deepseek-v4-pro/")).status).toBe(200);
    expect((await get(handler, "/v1/models/deepseek/deepseek%2Dv4%2Dpro")).status).toBe(200);
  });
});
