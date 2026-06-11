import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { anthropicMessagesCodec } from "../../src/codecs/anthropicMessages.js";
import type { ChatMessage, StreamEvent } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";

const registry = Registry.load();
const model = registry.resolve("anthropic", "claude-fable-5")!;

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
      model: "claude-fable-5",
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

  it("throws invalid_request for responseFormat (not implemented on this wire)", () => {
    expect(() =>
      anthropicMessagesCodec.encode(
        model,
        { messages: [{ role: "user", content: "hi" }], responseFormat: { type: "json_object" }, effectiveParams: {}, stream: false },
        "TEST_KEY"
      )
    ).toThrow(GatewayError);
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
      model: "claude-fable-5",
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
          model: "claude-fable-5",
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
        model: "claude-fable-5",
        content: [{ type: "text", text: "par" }],
        finishReason: "error",
        usage: { inputTokens: 3, outputTokens: 0 },
        warnings: []
      }
    });
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
