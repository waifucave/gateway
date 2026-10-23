import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { anthropicMessagesCodec } from "../../src/codecs/anthropicMessages.js";
import type { ChatMessage, StreamEvent } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";

const registry = Registry.load();
// budget-style family: the legacy thinking goldens below assert budget_tokens behavior
const model = registry.resolve("anthropic", "claude-sonnet-4-5-20250929")!;

function goldenEncode(input: {
  params?: Record<string, unknown>;
  messages?: ChatMessage[];
  tools?: Parameters<typeof anthropicMessagesCodec.encode>[1]["tools"];
  toolChoice?: Parameters<typeof anthropicMessagesCodec.encode>[1]["toolChoice"];
  stream?: boolean;
}) {
  const validation = validateRequest(model, {
    params: input.params ?? {},
    toolChoice: input.toolChoice,
    stream: input.stream ?? false
  });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return anthropicMessagesCodec.encode(
    model,
    {
      messages: input.messages ?? [{ role: "user", content: "hi" }],
      tools: input.tools,
      toolChoice: input.toolChoice,
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

describe("anthropic-messages encode — thinking styles per family", () => {
  const budgetModel = registry.resolve("anthropic", "claude-haiku-4-5-20251001")!;
  const adaptiveModel = registry.resolve("anthropic", "claude-opus-4-6")!;
  const alwaysOnModel = registry.resolve("anthropic", "claude-fable-5")!;

  function encodeFor(m: typeof model, params: Record<string, unknown>) {
    const validation = validateRequest(m, { params, stream: false });
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
    return anthropicMessagesCodec.encode(
      m,
      { messages: [{ role: "user", content: "hi" }], effectiveParams: validation.effectiveParams, stream: false },
      "TEST_KEY"
    );
  }

  it("budget style keeps {enabled, budget_tokens}", () => {
    const encoded = encodeFor(budgetModel, { "reasoning.enabled": true, "reasoning.budgetTokens": 1500 });
    expect(encoded.body.thinking).toEqual({ type: "enabled", budget_tokens: 1500 });
  });

  it("adaptive style emits {type:'adaptive'} and drops budget with a warning", () => {
    const encoded = encodeFor(adaptiveModel, { "reasoning.enabled": true, "reasoning.budgetTokens": 1500 });
    expect(encoded.body.thinking).toEqual({ type: "adaptive" });
    expect(encoded.warnings.map((w) => w.message).join(" ")).toMatch(/budget/i);
  });

  it("adaptive style without budget emits {type:'adaptive'} cleanly", () => {
    const encoded = encodeFor(adaptiveModel, { "reasoning.enabled": true });
    expect(encoded.body.thinking).toEqual({ type: "adaptive" });
  });

  it("always-on style omits thinking entirely (fable rejects any explicit config)", () => {
    const encoded = encodeFor(alwaysOnModel, { "reasoning.enabled": true });
    expect(encoded.body.thinking).toBeUndefined();
  });

  it("always-on style warns that thinking cannot be disabled", () => {
    const encoded = encodeFor(alwaysOnModel, { "reasoning.enabled": false });
    expect(encoded.body.thinking).toBeUndefined();
    expect(encoded.warnings.map((w) => w.message).join(" ")).toMatch(/always on|cannot be disabled/i);
  });
});

describe("anthropic catalog rules — thinking, sampling, exclude (G1/G7)", () => {
  const OLDER = ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-opus-4-6"];

  it("no Claude family maps reasoning.exclude onto a (non-existent) thinking.redacted wire field", () => {
    for (const ref of registry.listModels().filter((m) => m.company === "Anthropic" && m.providerId === "anthropic")) {
      const m = registry.resolve(ref.providerId, ref.modelId)!;
      expect(m.params["reasoning.exclude"]?.wireName, ref.modelId).toBeUndefined();
      const encoded = anthropicMessagesCodec.encode(
        m,
        { messages: [{ role: "user", content: "hi" }], effectiveParams: validateRequest(m, { params: { "reasoning.exclude": true } }).effectiveParams, stream: false },
        "K"
      );
      expect(JSON.stringify(encoded.body), ref.modelId).not.toContain("redacted");
      expect(encoded.body).not.toHaveProperty("reasoning");
    }
  });

  it("thinking requests carry no spurious param_forced warning (G7)", () => {
    for (const ref of registry.listModels().filter((m) => m.company === "Anthropic")) {
      const m = registry.resolve(ref.providerId, ref.modelId)!;
      const result = validateRequest(m, { params: { "reasoning.enabled": true } });
      expect(result.warnings.filter((w) => w.code === "forced"), `${ref.providerId}:${ref.modelId}`).toEqual([]);
      expect(result.effectiveParams).not.toHaveProperty("reasoningRoundTrip");
    }
  });

  it.each(OLDER)("%s: thinking drops temperature/top_k and clamps top_p into [0.95, 1]", (modelId) => {
    const m = registry.resolve("anthropic", modelId)!;
    const result = validateRequest(m, { params: { "reasoning.enabled": true, temperature: 0.7, topK: 40, topP: 0.5 } });
    expect(result.ok, JSON.stringify(result.violations)).toBe(true);
    expect(result.effectiveParams).not.toHaveProperty("temperature");
    expect(result.effectiveParams).not.toHaveProperty("topK");
    expect(result.effectiveParams.topP).toBe(0.95);
    expect(result.warnings.map((w) => `${w.param}:${w.code}`).sort()).toEqual(["temperature:dropped", "topK:dropped", "topP:clamped"]);
  });

  it.each(OLDER)("%s: temperature and top_p together → top_p dropped (Claude 4.5+ accepts only one)", (modelId) => {
    const m = registry.resolve("anthropic", modelId)!;
    const result = validateRequest(m, { params: { temperature: 0.7, topP: 0.9 } });
    expect(result.ok).toBe(true);
    expect(result.effectiveParams.temperature).toBe(0.7);
    expect(result.effectiveParams).not.toHaveProperty("topP");
  });

  it("without thinking, sampling params pass through untouched", () => {
    const m = registry.resolve("anthropic", "claude-haiku-4-5-20251001")!;
    const result = validateRequest(m, { params: { temperature: 0.3, topK: 10 } });
    expect(result.warnings).toEqual([]);
    expect(result.effectiveParams).toMatchObject({ temperature: 0.3, topK: 10 });
  });

  it("Opus 4.7+ / Sonnet 5 / Fable expose no sampling params (removed upstream: 400)", () => {
    for (const modelId of ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
      const m = registry.resolve("anthropic", modelId)!;
      for (const p of ["temperature", "topP", "topK"]) expect(m.params[p], `${modelId}.${p}`).toBeUndefined();
    }
  });
});

describe("anthropic-messages encode — thinking payload", () => {
  it("GOLDEN: thinking payload with budget, top-level system, reasoningRoundTrip directive skipped", () => {
    const encoded = goldenEncode({
      params: { "reasoning.enabled": true, "reasoning.budgetTokens": 1500, maxOutputTokens: 2048 },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.body).toEqual({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2048,
      thinking: { type: "enabled", budget_tokens: 1500 },
      system: "Be terse.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
    expect(encoded.body).not.toHaveProperty("reasoningRoundTrip");
    expect(encoded.url).toBe("https://api.anthropic.com/v1/messages");
    expect(encoded.headers).toEqual({ "content-type": "application/json", "x-api-key": "TEST_KEY", "anthropic-version": "2023-06-01" });
  });

  it("defaults max_tokens to 4096 and thinking budget to 1024", () => {
    const encoded = goldenEncode({ params: { "reasoning.enabled": true } });
    expect(encoded.body.max_tokens).toBe(4096);
    expect(encoded.body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("bumps max_tokens above the thinking budget when needed", () => {
    const encoded = goldenEncode({ params: { "reasoning.enabled": true, "reasoning.budgetTokens": 1500, maxOutputTokens: 1024 } });
    expect(encoded.body.max_tokens).toBe(2524); // 1500 + 1024
    expect(encoded.body.thinking).toEqual({ type: "enabled", budget_tokens: 1500 });
  });

  it("normalizes disabled thinking to {type:'disabled'} with no extra fields", () => {
    const encoded = goldenEncode({ params: { "reasoning.enabled": false, "reasoning.budgetTokens": 1500 } });
    expect(encoded.body.thinking).toEqual({ type: "disabled" });
  });
});

describe("anthropic-messages encode — messages & tools", () => {
  it("GOLDEN: reasoning round-trip — thinking block with signature, tool_use, then tool_result as user", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hmm", signature: "sig_abc" },
          { type: "toolCall", id: "toolu_1", name: "lookup", arguments: '{"q":"x"}' }
        ]
      },
      { role: "tool", toolCallId: "toolu_1", content: "42" }
    ];
    const encoded = goldenEncode({ messages });
    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig_abc" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }
        ]
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }] }
    ]);
  });

  it("encodes redacted thinking blocks", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "reasoning", text: "", redacted: true, data: "OPAQUE" }, { type: "text", text: "ok" }] }
    ];
    const encoded = goldenEncode({ messages });
    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE" }, { type: "text", text: "ok" }] }
    ]);
  });

  it("merges consecutive same-role messages (two tool results → one user message)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "a", arguments: "{}" },
          { type: "toolCall", id: "t2", name: "b", arguments: "{}" }
        ]
      },
      { role: "tool", toolCallId: "t1", content: "1" },
      { role: "tool", toolCallId: "t2", content: "2" }
    ];
    const encoded = goldenEncode({ messages });
    const wireMessages = encoded.body.messages as Array<{ role: string; content: unknown[] }>;
    expect(wireMessages).toHaveLength(3);
    expect(wireMessages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "1" },
        { type: "tool_result", tool_use_id: "t2", content: "2" }
      ]
    });
  });

  it("joins multiple system messages and encodes images", () => {
    const encoded = goldenEncode({
      messages: [
        { role: "system", content: "A." },
        { role: "system", content: "B." },
        { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAA=" }] }
      ]
    });
    expect(encoded.body.system).toBe("A.\n\nB.");
    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } }] }
    ]);
  });

  it("maps tools, required→any and named→tool; sets stream flag", () => {
    const encoded = goldenEncode({
      tools: [{ name: "pick", description: "d", parameters: { type: "object" } }],
      toolChoice: "required",
      stream: true
    });
    expect(encoded.body.tools).toEqual([{ name: "pick", description: "d", input_schema: { type: "object" } }]);
    expect(encoded.body.tool_choice).toEqual({ type: "any" });
    expect(encoded.body.stream).toBe(true);

    const named = goldenEncode({ tools: [{ name: "pick", parameters: { type: "object" } }], toolChoice: { name: "pick" } });
    expect(named.body.tool_choice).toEqual({ type: "tool", name: "pick" });
  });

  it("throws invalid_request for json_object (Anthropic has no JSON mode; jsonMode is false in the catalog)", () => {
    expect(model.features.structuredOutput.jsonMode).toBe(false);
    expect(validateRequest(model, { params: {}, responseFormat: "json_object" }).ok).toBe(false);
    expect(() =>
      anthropicMessagesCodec.encode(
        model,
        { messages: [{ role: "user", content: "hi" }], responseFormat: { type: "json_object" }, effectiveParams: {}, stream: false },
        "TEST_KEY"
      )
    ).toThrow(GatewayError);
  });

  it("GOLDEN: json_schema → native output_config.format (G6), objects closed, unsupported constraints moved to descriptions", () => {
    const schema = {
      type: "object",
      properties: {
        reply: { type: "string", maxLength: 200, description: "the reply" },
        score: { type: "integer", minimum: 0, maximum: 10 },
        tags: { type: "array", items: { type: "object", properties: { t: { type: "string" } }, required: ["t"] } }
      },
      required: ["reply", "score", "tags"]
    };
    const encoded = anthropicMessagesCodec.encode(
      model,
      { messages: [{ role: "user", content: "hi" }], responseFormat: { type: "json_schema", name: "decision", schema }, effectiveParams: {}, stream: false },
      "TEST_KEY"
    );
    expect(encoded.body.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            reply: { type: "string", description: "the reply (maxLength: 200)" },
            score: { type: "integer", description: "(minimum: 0, maximum: 10)" },
            tags: {
              type: "array",
              items: { type: "object", properties: { t: { type: "string" } }, required: ["t"], additionalProperties: false }
            }
          },
          required: ["reply", "score", "tags"],
          additionalProperties: false
        }
      }
    });
    expect(encoded.body).not.toHaveProperty("tools");
    // the caller's schema object is never mutated
    expect(schema.properties.reply).toEqual({ type: "string", maxLength: 200, description: "the reply" });
  });

  it("json_schema merges with effort inside output_config", () => {
    const sonnet5 = registry.resolve("anthropic", "claude-sonnet-5")!;
    const validation = validateRequest(sonnet5, { params: { "reasoning.effort": "low" }, responseFormat: "json_schema" });
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
    const encoded = anthropicMessagesCodec.encode(
      sonnet5,
      {
        messages: [{ role: "user", content: "hi" }],
        responseFormat: { type: "json_schema", schema: { type: "object", properties: {} } },
        effectiveParams: validation.effectiveParams,
        stream: false
      },
      "TEST_KEY"
    );
    expect(encoded.body.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: { type: "object", properties: {}, additionalProperties: false } }
    });
  });

  it("every Claude family that advertises jsonSchema encodes it without throwing", () => {
    for (const ref of registry.listModels().filter((m) => m.providerId === "anthropic")) {
      const m = registry.resolve(ref.providerId, ref.modelId)!;
      expect(m.features.structuredOutput.jsonSchema).toBe(true);
      expect(() =>
        anthropicMessagesCodec.encode(
          m,
          { messages: [{ role: "user", content: "hi" }], responseFormat: { type: "json_schema", schema: { type: "object" } }, effectiveParams: {}, stream: false },
          "K"
        )
      ).not.toThrow();
    }
  });

  it("drops empty text blocks and empty turns (Anthropic rejects empty content)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "ok" }] },
      { role: "user", content: [] }
    ];
    const encoded = goldenEncode({ messages });
    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] }
    ]);
  });
});

describe("anthropic-messages decodeResponse", () => {
  it("decodes thinking + text + tool_use with usage and stop_reason", () => {
    const response = anthropicMessagesCodec.decodeResponse(model, {
      id: "msg_1",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig_1" },
        { type: "text", text: "calling" },
        { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "x" } }
      ],
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 5 }
    });
    expect(response).toEqual({
      id: "msg_1",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      content: [
        { type: "reasoning", text: "hmm", signature: "sig_1" },
        { type: "text", text: "calling" },
        { type: "toolCall", id: "toolu_9", name: "lookup", arguments: '{"q":"x"}' }
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 12, outputTokens: 7, cachedInputTokens: 5 },
      warnings: []
    });
  });

  it("decodes redacted_thinking and maps stop reasons", () => {
    const response = anthropicMessagesCodec.decodeResponse(model, {
      id: "msg_2",
      stop_reason: "refusal",
      content: [{ type: "redacted_thinking", data: "OPAQUE" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    expect(response.content).toEqual([{ type: "reasoning", text: "", redacted: true, data: "OPAQUE" }]);
    expect(response.finishReason).toBe("content_filter");

    const stop = (stop_reason: string) =>
      anthropicMessagesCodec.decodeResponse(model, { stop_reason, content: [], usage: {} }).finishReason;
    expect(stop("end_turn")).toBe("stop");
    expect(stop("stop_sequence")).toBe("stop");
    expect(stop("max_tokens")).toBe("length");
  });
});

describe("anthropic-messages decodeStream", () => {
  it("assembles thinking + signature + text + tool_use across block events", async () => {
    const events = await collect(
      anthropicMessagesCodec.decodeStream(
        model,
        sse([
          { event: "message_start", data: '{"type":"message_start","message":{"id":"msg_3","usage":{"input_tokens":9}}}' },
          { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_z"}}' },
          { event: "content_block_start", data: '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}' },
          { event: "content_block_start", data: '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_5","name":"pick"}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}' },
          { event: "message_delta", data: '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}' },
          { event: "message_stop", data: '{"type":"message_stop"}' }
        ])
      )
    );
    expect(events).toEqual([
      { type: "reasoning-delta", text: "hm" },
      { type: "text-delta", text: "ok" },
      { type: "tool-call-delta", index: 0, id: "toolu_5", name: "pick", argumentsDelta: "" },
      { type: "tool-call-delta", index: 0, argumentsDelta: "{}" },
      { type: "usage", usage: { inputTokens: 9, outputTokens: 6 } },
      {
        type: "done",
        response: {
          id: "msg_3",
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "reasoning", text: "hm", signature: "sig_z" },
            { type: "text", text: "ok" },
            { type: "toolCall", id: "toolu_5", name: "pick", arguments: "{}" }
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 9, outputTokens: 6 },
          warnings: []
        }
      }
    ]);
  });

  it("synthesizes a done event when the stream truncates before message_stop", async () => {
    const events = await collect(
      anthropicMessagesCodec.decodeStream(
        model,
        sse([
          { event: "message_start", data: '{"type":"message_start","message":{"id":"msg_t","usage":{"input_tokens":3}}}' },
          { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"par"}}' }
        ])
      )
    );
    const done = events.at(-1)!;
    expect(done).toEqual({
      type: "done",
      response: {
        id: "msg_t",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "par" }],
        finishReason: "error",
        usage: { inputTokens: 3, outputTokens: 0 },
        warnings: []
      }
    });
  });

  it("trusts a stop_reason captured before truncation (message_stop is just the envelope)", async () => {
    const events = await collect(
      anthropicMessagesCodec.decodeStream(
        model,
        sse([
          { event: "message_start", data: '{"type":"message_start","message":{"id":"msg_s","usage":{"input_tokens":2}}}' },
          { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done!"}}' },
          { event: "message_delta", data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}' }
        ])
      )
    );
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type === "done") expect(done.response.finishReason).toBe("stop");
  });

  it("ignores ping and throws on error events", async () => {
    await expect(
      collect(
        anthropicMessagesCodec.decodeStream(
          model,
          sse([
            { event: "ping", data: '{"type":"ping"}' },
            { event: "error", data: '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}' }
          ])
        )
      )
    ).rejects.toThrow(GatewayError);
  });
});
