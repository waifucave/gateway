import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { openaiResponsesCodec } from "../../src/codecs/openaiResponses.js";
import type { ChatMessage, StreamEvent } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";

const registry = Registry.load();
const model = registry.resolve("openai", "gpt-5.5")!;

function goldenEncode(input: {
  params?: Record<string, unknown>;
  messages?: ChatMessage[];
  tools?: Parameters<typeof openaiResponsesCodec.encode>[1]["tools"];
  toolChoice?: Parameters<typeof openaiResponsesCodec.encode>[1]["toolChoice"];
  responseFormat?: Parameters<typeof openaiResponsesCodec.encode>[1]["responseFormat"];
  stream?: boolean;
}) {
  const validation = validateRequest(model, {
    params: input.params ?? {},
    toolChoice: input.toolChoice,
    responseFormat: input.responseFormat?.type,
    stream: input.stream ?? false
  });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return openaiResponsesCodec.encode(
    model,
    {
      messages: input.messages ?? [{ role: "user", content: "hi" }],
      tools: input.tools,
      toolChoice: input.toolChoice,
      responseFormat: input.responseFormat,
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

describe("openai-responses encode", () => {
  it("GOLDEN: reasoning effort + verbosity + max_output_tokens with developer role", () => {
    const encoded = goldenEncode({
      params: { "reasoning.effort": "high", verbosity: "low", maxOutputTokens: 4000 },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.body).toEqual({
      model: "gpt-5.5",
      max_output_tokens: 4000,
      reasoning: { effort: "high" },
      text: { verbosity: "low" },
      input: [
        { role: "developer", content: [{ type: "input_text", text: "Be terse." }] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] }
      ]
    });
    expect(encoded.url).toBe("https://api.openai.com/v1/responses");
    expect(encoded.headers).toEqual({ "content-type": "application/json", authorization: "Bearer TEST_KEY" });
  });

  it("sampling params stay rejected upstream (P1a pin re-asserted at the codec boundary)", () => {
    expect(validateRequest(model, { params: { temperature: 0.7 } }).ok).toBe(false);
  });

  it("encodes tool history as function_call / function_call_output items and named tool choice", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "calling" },
          { type: "toolCall", id: "call_1", name: "pick", arguments: '{"k":1}' }
        ]
      },
      { role: "tool", toolCallId: "call_1", content: "42" }
    ];
    const encoded = goldenEncode({
      messages,
      tools: [{ name: "pick", description: "pick one", parameters: { type: "object" }, strict: true }],
      toolChoice: { name: "pick" }
    });
    expect(encoded.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "q" }] },
      { role: "assistant", content: [{ type: "output_text", text: "calling" }] }, // reasoning NOT re-sent
      { type: "function_call", call_id: "call_1", name: "pick", arguments: '{"k":1}' },
      { type: "function_call_output", call_id: "call_1", output: "42" }
    ]);
    expect(encoded.body.tools).toEqual([{ type: "function", name: "pick", description: "pick one", parameters: { type: "object" }, strict: true }]);
    expect(encoded.body.tool_choice).toEqual({ type: "function", name: "pick" });
  });

  it("merges responseFormat into text.format alongside verbosity", () => {
    const schema = { type: "object", properties: {} };
    const encoded = goldenEncode({
      params: { verbosity: "low" },
      responseFormat: { type: "json_schema", name: "out", schema, strict: true }
    });
    expect(encoded.body.text).toEqual({ verbosity: "low", format: { type: "json_schema", name: "out", schema, strict: true } });
  });

  it("encodes image input and the stream flag", () => {
    const encoded = goldenEncode({
      messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAA=" }] }],
      stream: true
    });
    expect(encoded.body.input).toEqual([{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAA=" }] }]);
    expect(encoded.body.stream).toBe(true);
  });
});

describe("openai-responses decodeResponse", () => {
  it("decodes reasoning summaries, message text, function calls and usage", () => {
    const response = openaiResponsesCodec.decodeResponse(model, {
      id: "resp_1",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
        { type: "function_call", call_id: "call_2", name: "pick", arguments: "{}" }
      ],
      usage: { input_tokens: 20, output_tokens: 9, output_tokens_details: { reasoning_tokens: 6 }, input_tokens_details: { cached_tokens: 11 } }
    });
    expect(response).toEqual({
      id: "resp_1",
      provider: "openai",
      model: "gpt-5.5",
      content: [
        { type: "reasoning", text: "thought" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call_2", name: "pick", arguments: "{}" }
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 20, outputTokens: 9, reasoningTokens: 6, cachedInputTokens: 11 },
      warnings: []
    });
  });

  it("maps statuses to finish reasons", () => {
    const decode = (status: string, reason?: string) =>
      openaiResponsesCodec.decodeResponse(model, { status, incomplete_details: reason ? { reason } : undefined, output: [] }).finishReason;
    expect(decode("completed")).toBe("stop");
    expect(decode("incomplete", "max_output_tokens")).toBe("length");
    expect(decode("incomplete", "content_filter")).toBe("content_filter");
    expect(decode("failed")).toBe("error");
  });
});

describe("openai-responses decodeStream", () => {
  it("yields deltas keyed by output_index and a done decoded from response.completed", async () => {
    const completed = {
      id: "resp_2",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi!" }] }],
      usage: { input_tokens: 3, output_tokens: 2 }
    };
    const events = await collect(
      openaiResponsesCodec.decodeStream(
        model,
        sse([
          { event: "response.output_text.delta", data: '{"type":"response.output_text.delta","output_index":0,"delta":"hi"}' },
          { event: "response.output_text.delta", data: '{"type":"response.output_text.delta","output_index":0,"delta":"!"}' },
          { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: completed }) }
        ])
      )
    );
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "text-delta", text: "!" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
      {
        type: "done",
        response: {
          id: "resp_2",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "hi!" }],
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 2 },
          warnings: []
        }
      }
    ]);
  });

  it("emits tool-call deltas from output_item.added + function_call_arguments.delta", async () => {
    const completed = {
      id: "resp_3",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_7", name: "pick", arguments: '{"k":1}' }],
      usage: { input_tokens: 1, output_tokens: 1 }
    };
    const events = await collect(
      openaiResponsesCodec.decodeStream(
        model,
        sse([
          {
            event: "response.output_item.added",
            data: '{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_7","name":"pick"}}'
          },
          {
            event: "response.function_call_arguments.delta",
            data: '{"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"k\\":1}"}'
          },
          { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: completed }) }
        ])
      )
    );
    expect(events[0]).toEqual({ type: "tool-call-delta", index: 0, id: "call_7", name: "pick", argumentsDelta: "" });
    expect(events[1]).toEqual({ type: "tool-call-delta", index: 0, argumentsDelta: '{"k":1}' });
    expect(events.at(-1)!.type).toBe("done");
  });

  it("throws GatewayError on response.failed and error events", async () => {
    await expect(
      collect(
        openaiResponsesCodec.decodeStream(
          model,
          sse([{ event: "response.failed", data: '{"type":"response.failed","response":{"error":{"message":"boom"}}}' }])
        )
      )
    ).rejects.toThrow(GatewayError);
    await expect(
      collect(openaiResponsesCodec.decodeStream(model, sse([{ event: "error", data: '{"type":"error","message":"bad"}' }])))
    ).rejects.toThrow(GatewayError);
  });

  it("yields reasoning-delta for reasoning summary text", async () => {
    const events = await collect(
      openaiResponsesCodec.decodeStream(
        model,
        sse([
          { event: "response.reasoning_summary_text.delta", data: '{"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"hm"}' }
        ])
      )
    );
    expect(events[0]).toEqual({ type: "reasoning-delta", text: "hm" });
  });

  it("synthesizes a done event with finishReason error when the stream truncates before response.completed", async () => {
    const events = await collect(
      openaiResponsesCodec.decodeStream(
        model,
        sse([
          { event: "response.created", data: '{"type":"response.created","response":{"id":"resp_t"}}' },
          { event: "response.output_text.delta", data: '{"type":"response.output_text.delta","output_index":0,"delta":"par"}' }
        ])
      )
    );
    const done = events.at(-1)!;
    expect(done).toEqual({
      type: "done",
      response: {
        id: "resp_t",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "par" }],
        finishReason: "error",
        usage: { inputTokens: 0, outputTokens: 0 },
        warnings: []
      }
    });
  });
});
