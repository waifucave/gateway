import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { openaiChatCodec } from "../../src/codecs/openaiChat.js";
import type { CodecRequest } from "../../src/codecs/types.js";
import type { ChatMessage } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";
import type { StreamEvent } from "../../src/client/types.js";

const registry = Registry.load();

type GoldenInput = Partial<Omit<CodecRequest, "effectiveParams">> & { params?: Record<string, unknown> };

function goldenEncode(providerId: string, modelId: string, input: GoldenInput) {
  const model = registry.resolve(providerId, modelId)!;
  const validation = validateRequest(model, {
    params: input.params ?? {},
    toolChoice: input.toolChoice,
    responseFormat: input.responseFormat?.type,
    stream: input.stream ?? false
  });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return openaiChatCodec.encode(
    model,
    {
      messages: input.messages ?? [{ role: "user", content: "hi" }],
      tools: input.tools,
      toolChoice: input.toolChoice,
      responseFormat: input.responseFormat,
      passthrough: input.passthrough,
      effectiveParams: validation.effectiveParams,
      stream: input.stream ?? false
    },
    "TEST_KEY"
  );
}

async function* sse(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const event of events) yield event;
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("openai-chat encode — DeepSeek thinking quirks (live-validated 2026-06-10)", () => {
  it("GOLDEN: thinking drops sampling — no temperature/top_p on the wire", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-pro", {
      params: { temperature: 0.7, "reasoning.enabled": true },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.body).toEqual({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.url).toBe("https://api.deepseek.com/chat/completions");
    expect(encoded.headers).toEqual({ "content-type": "application/json", authorization: "Bearer TEST_KEY" });
  });

  it("GOLDEN: thinking disabled keeps sampling", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { temperature: 0.7, "reasoning.enabled": false }
    });
    expect(encoded.body).toEqual({
      model: "deepseek-v4-flash",
      temperature: 0.7,
      top_p: 1,
      thinking: { type: "disabled" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }]
    });
  });

  it("forced tool choice under default-on thinking is rejected upstream by validation (codec never sees it)", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const validation = validateRequest(model, { params: {}, toolChoice: "required" });
    expect(validation.ok).toBe(false);
  });
});

describe("openai-chat encode — OpenRouter dialect", () => {
  it("GOLDEN: deepseek via OpenRouter uses the normalized reasoning object", () => {
    const encoded = goldenEncode("openrouter", "deepseek/deepseek-v4-pro", {
      params: { temperature: 0.7, "reasoning.enabled": true }
    });
    expect(encoded.body).toEqual({
      model: "deepseek/deepseek-v4-pro",
      reasoning: { enabled: true, effort: "high" },
      messages: [{ role: "user", content: "hi" }]
    });
    expect(encoded.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("GOLDEN: an Anthropic model via OpenRouter maps budgetTokens to reasoning.max_tokens", () => {
    const encoded = goldenEncode("openrouter", "anthropic/claude-fable-5", {
      params: { "reasoning.enabled": true, "reasoning.budgetTokens": 2000 }
    });
    expect(encoded.body).toEqual({
      model: "anthropic/claude-fable-5",
      reasoning: { enabled: true, max_tokens: 2000 },
      messages: [{ role: "user", content: "hi" }]
    });
  });
});

describe("openai-chat encode — structure", () => {
  const TOOLS = [{ name: "pick", description: "pick one", parameters: { type: "object", properties: {} } }];

  it("encodes tools and named tool choice", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { "reasoning.enabled": false },
      tools: TOOLS,
      toolChoice: { name: "pick" }
    });
    expect(encoded.body.tools).toEqual([
      { type: "function", function: { name: "pick", description: "pick one", parameters: { type: "object", properties: {} } } }
    ]);
    expect(encoded.body.tool_choice).toEqual({ type: "function", function: { name: "pick" } });
  });

  it("encodes assistant tool calls, reasoning round-trip and tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thought" },
          { type: "toolCall", id: "call_1", name: "pick", arguments: '{"k":1}' }
        ]
      },
      { role: "tool", toolCallId: "call_1", content: "42" }
    ];
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", { params: { "reasoning.enabled": false }, messages });
    expect(encoded.body.messages).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "pick", arguments: '{"k":1}' } }],
        reasoning_content: "thought"
      },
      { role: "tool", tool_call_id: "call_1", content: "42" }
    ]);
  });

  it("omits reasoning_content when the model does not round-trip reasoning", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: [{ type: "reasoning", text: "thought" }, { type: "text", text: "answer" }] }
    ];
    // deepseek-v3.2 (openrouter-only) has reasoningRoundTrip: false
    const encoded = goldenEncode("openrouter", "deepseek/deepseek-v3.2", { messages });
    expect(encoded.body.messages).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("encodes image blocks as data-URL image_url parts", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { "reasoning.enabled": false },
      messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mimeType: "image/png", data: "AAA=" }] }]
    });
    expect(encoded.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } }
        ]
      }
    ]);
  });

  it("encodes response_format json_object and json_schema", () => {
    const jsonObject = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { "reasoning.enabled": false },
      responseFormat: { type: "json_object" }
    });
    expect(jsonObject.body.response_format).toEqual({ type: "json_object" });

    const schema = { type: "object", properties: { a: { type: "number" } } };
    const jsonSchema = goldenEncode("openrouter", "deepseek/deepseek-v3.2", {
      responseFormat: { type: "json_schema", name: "out", schema, strict: true }
    });
    expect(jsonSchema.body.response_format).toEqual({ type: "json_schema", json_schema: { name: "out", schema, strict: true } });
  });

  it("sets stream and stream_options only when the model reports streaming usage", () => {
    const withUsage = goldenEncode("deepseek", "deepseek-v4-flash", { params: { "reasoning.enabled": false }, stream: true });
    expect(withUsage.body.stream).toBe(true);
    expect(withUsage.body.stream_options).toEqual({ include_usage: true });

    const withoutUsage = goldenEncode("openrouter", "deepseek/deepseek-v3.2", { stream: true }); // streamingUsage: false
    expect(withoutUsage.body.stream).toBe(true);
    expect(withoutUsage.body).not.toHaveProperty("stream_options");
  });

  it("merges passthrough keys with a warning", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { "reasoning.enabled": false },
      passthrough: { service_tier: "flex" }
    });
    expect(encoded.body.service_tier).toBe("flex");
    expect(encoded.warnings).toContainEqual({ code: "passthrough", param: "service_tier", message: "service_tier sent unvalidated via passthrough" });
  });
});

describe("openai-chat decodeResponse", () => {
  const model = registry.resolve("deepseek", "deepseek-v4-pro")!;

  it("decodes reasoning_content, text, tool calls and DeepSeek cache usage", () => {
    const response = openaiChatCodec.decodeResponse(model, {
      id: "cmpl_1",
      choices: [
        {
          message: {
            content: "answer",
            reasoning_content: "thought",
            tool_calls: [{ id: "call_9", function: { name: "pick", arguments: '{"k":1}' } }]
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 }, prompt_cache_hit_tokens: 4 }
    });
    expect(response).toEqual({
      id: "cmpl_1",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      content: [
        { type: "reasoning", text: "thought" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call_9", name: "pick", arguments: '{"k":1}' }
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, cachedInputTokens: 4 },
      warnings: []
    });
  });

  it("maps finish reasons, defaulting unknown ones to error", () => {
    const decode = (finish_reason: string | null) =>
      openaiChatCodec.decodeResponse(model, { choices: [{ message: { content: "x" }, finish_reason }] }).finishReason;
    expect(decode("stop")).toBe("stop");
    expect(decode("length")).toBe("length");
    expect(decode("content_filter")).toBe("content_filter");
    expect(decode("insufficient_system_resource")).toBe("error");
    expect(decode(null)).toBe("error");
  });

  it("throws GatewayError server when choices are missing", () => {
    expect(() => openaiChatCodec.decodeResponse(model, { object: "error" })).toThrow(GatewayError);
  });
});

describe("openai-chat decodeStream", () => {
  const model = registry.resolve("deepseek", "deepseek-v4-pro")!;

  it("yields deltas, usage and an assembled done event", async () => {
    const events = await collect(
      openaiChatCodec.decodeStream(
        model,
        sse([
          { data: '{"id":"c1","choices":[{"delta":{"reasoning_content":"th"}}]}' },
          { data: '{"choices":[{"delta":{"content":"he"}}]}' },
          { data: '{"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}' },
          { data: '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}' },
          { data: "[DONE]" }
        ])
      )
    );
    expect(events).toEqual([
      { type: "reasoning-delta", text: "th" },
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } },
      {
        type: "done",
        response: {
          id: "c1",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          content: [
            { type: "reasoning", text: "th" },
            { type: "text", text: "hello" }
          ],
          finishReason: "stop",
          usage: { inputTokens: 7, outputTokens: 2 },
          warnings: []
        }
      }
    ]);
  });

  it("accumulates indexed tool-call deltas", async () => {
    const events = await collect(
      openaiChatCodec.decodeStream(
        model,
        sse([
          { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"pick","arguments":""}}]}}]}' },
          { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"k\\""}}]}}]}' },
          { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}' },
          { data: "[DONE]" }
        ])
      )
    );
    expect(events[0]).toEqual({ type: "tool-call-delta", index: 0, id: "call_1", name: "pick", argumentsDelta: "" });
    expect(events[1]).toEqual({ type: "tool-call-delta", index: 0, argumentsDelta: '{"k"' });
    expect(events[2]).toEqual({ type: "tool-call-delta", index: 0, argumentsDelta: ":1}" });
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type === "done") {
      expect(done.response.content).toEqual([{ type: "toolCall", id: "call_1", name: "pick", arguments: '{"k":1}' }]);
      expect(done.response.finishReason).toBe("tool_calls");
    }
  });

  it("throws GatewayError on malformed chunks", async () => {
    await expect(collect(openaiChatCodec.decodeStream(model, sse([{ data: "{not json" }])))).rejects.toThrow(GatewayError);
  });
});
