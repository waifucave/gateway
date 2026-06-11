import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { googleGenerativeLanguageCodec } from "../../src/codecs/googleGenerativeLanguage.js";
import type { ChatMessage, StreamEvent } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";

const registry = Registry.load();
const model = registry.resolve("google-ai-studio", "gemini-2.5-flash")!;

function goldenEncode(input: {
  params?: Record<string, unknown>;
  messages?: ChatMessage[];
  tools?: Parameters<typeof googleGenerativeLanguageCodec.encode>[1]["tools"];
  toolChoice?: Parameters<typeof googleGenerativeLanguageCodec.encode>[1]["toolChoice"];
  responseFormat?: Parameters<typeof googleGenerativeLanguageCodec.encode>[1]["responseFormat"];
  stream?: boolean;
}) {
  const validation = validateRequest(model, {
    params: input.params ?? {},
    toolChoice: input.toolChoice,
    responseFormat: input.responseFormat?.type,
    stream: input.stream ?? false
  });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return googleGenerativeLanguageCodec.encode(
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

describe("google encode — generationConfig & quirks", () => {
  it("GOLDEN: ≤5 stop sequences nest under generationConfig; safetySettings top-level; systemInstruction", () => {
    const encoded = goldenEncode({
      params: { stopSequences: ["a", "b", "c", "d", "e"], temperature: 1.2, "google.safetySettings": { x: 1 } },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.body).toEqual({
      generationConfig: { temperature: 1.2, stopSequences: ["a", "b", "c", "d", "e"] },
      safetySettings: { x: 1 },
      systemInstruction: { parts: [{ text: "Be terse." }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }]
    });
    expect(encoded.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(encoded.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": "TEST_KEY" });
  });

  it("a 6th stop sequence is rejected upstream by validation (Gemini cap, Table A row 13)", () => {
    const validation = validateRequest(model, { params: { stopSequences: ["a", "b", "c", "d", "e", "f"] } });
    expect(validation.ok).toBe(false);
    expect(validation.violations.some((v) => v.code === "max_items" && v.param === "stopSequences")).toBe(true);
  });

  it("maps thinking budget and (on gemini-3) thinking level into thinkingConfig", () => {
    const budget = goldenEncode({ params: { "reasoning.budgetTokens": 1024 } });
    expect(budget.body.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 1024 } });

    const g3 = registry.resolve("google-ai-studio", "gemini-3-flash-preview")!;
    const validation = validateRequest(g3, { params: { "reasoning.effort": "low" } });
    expect(validation.ok).toBe(true);
    const encoded = googleGenerativeLanguageCodec.encode(
      g3,
      { messages: [{ role: "user", content: "hi" }], effectiveParams: validation.effectiveParams, stream: false },
      "TEST_KEY"
    );
    expect(encoded.body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "low" } });
  });

  it("the stream method lives in the URL, not the body", () => {
    const encoded = goldenEncode({ stream: true });
    expect(encoded.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(encoded.body).not.toHaveProperty("stream");
  });
});

describe("google encode — contents & tools", () => {
  it("encodes a tool loop: model functionCall, then functionResponse matched by NAME", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "lookup", arguments: '{"q":"x"}' }] },
      { role: "tool", toolCallId: "call_0", content: '{"answer":42}' }
    ];
    const encoded = goldenEncode({ messages, tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }] });
    expect(encoded.body.contents).toEqual([
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "lookup", response: { answer: 42 } } }] }
    ]);
    expect(encoded.body.tools).toEqual([{ functionDeclarations: [{ name: "lookup", description: "d", parameters: { type: "object" } }] }]);
  });

  it("wraps non-JSON tool results as {result} and throws on unknown toolCallId", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "lookup", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_0", content: "plain text" }
    ];
    const encoded = goldenEncode({ messages });
    const contents = encoded.body.contents as Array<{ parts: unknown[] }>;
    expect(contents[2]!.parts).toEqual([{ functionResponse: { name: "lookup", response: { result: "plain text" } } }]);

    expect(() => goldenEncode({ messages: [{ role: "tool", toolCallId: "ghost", content: "x" }] })).toThrow(GatewayError);
  });

  it("encodes reasoning blocks as thought parts with thoughtSignature, images as inlineData, merges same-role turns", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "look:" }] },
      { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAA=" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "hm", signature: "ts_1" }, { type: "text", text: "ok" }] }
    ];
    const encoded = goldenEncode({ messages });
    expect(encoded.body.contents).toEqual([
      { role: "user", parts: [{ text: "look:" }, { inlineData: { mimeType: "image/png", data: "AAA=" } }] },
      { role: "model", parts: [{ text: "hm", thought: true, thoughtSignature: "ts_1" }, { text: "ok" }] }
    ]);
  });

  it("drops empty text parts and empty turns (mirrors the empty-content lesson)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "ok" }] }
    ];
    const encoded = goldenEncode({ messages });
    expect(encoded.body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "ok" }] }
    ]);
  });

  it("maps toolChoice auto→AUTO and (unit-level) required/named→ANY", () => {
    const auto = goldenEncode({ toolChoice: "auto", tools: [{ name: "f", parameters: { type: "object" } }] });
    expect(auto.body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });

    // features.toolChoice for Gemini is [auto, none], so required/named are validator-rejected today;
    // the codec mapping is still pinned (unit-level, bypassing validation) for when data evolves.
    const named = googleGenerativeLanguageCodec.encode(
      model,
      { messages: [{ role: "user", content: "hi" }], toolChoice: { name: "f" }, effectiveParams: {}, stream: false },
      "TEST_KEY"
    );
    expect(named.body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] } });
    const required = googleGenerativeLanguageCodec.encode(
      model,
      { messages: [{ role: "user", content: "hi" }], toolChoice: "required", effectiveParams: {}, stream: false },
      "TEST_KEY"
    );
    expect(required.body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  });

  it("maps responseFormat to responseMimeType (+ responseJsonSchema for schemas)", () => {
    const schema = { type: "object", properties: {} };
    const encoded = goldenEncode({ responseFormat: { type: "json_schema", schema } });
    expect(encoded.body.generationConfig).toEqual({ responseMimeType: "application/json", responseJsonSchema: schema });

    const jsonObject = goldenEncode({ responseFormat: { type: "json_object" } });
    expect(jsonObject.body.generationConfig).toEqual({ responseMimeType: "application/json" });
  });
});

describe("google decodeResponse", () => {
  it("decodes thought parts, text, functionCall (synthesized ids) and usageMetadata", () => {
    const response = googleGenerativeLanguageCodec.decodeResponse(model, {
      responseId: "r1",
      candidates: [
        {
          content: {
            parts: [
              { text: "hm", thought: true, thoughtSignature: "ts_9" },
              { text: "calling" },
              { functionCall: { name: "lookup", args: { q: "x" } } }
            ]
          },
          finishReason: "STOP"
        }
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 3 }
    });
    expect(response).toEqual({
      id: "r1",
      provider: "google-ai-studio",
      model: "gemini-2.5-flash",
      content: [
        { type: "reasoning", text: "hm", signature: "ts_9" },
        { type: "text", text: "calling" },
        { type: "toolCall", id: "call_0", name: "lookup", arguments: '{"q":"x"}' }
      ],
      finishReason: "tool_calls", // STOP + functionCall present
      usage: { inputTokens: 8, outputTokens: 4, reasoningTokens: 2, cachedInputTokens: 3 },
      warnings: []
    });
  });

  it("maps finish reasons", () => {
    const decode = (finishReason: string) =>
      googleGenerativeLanguageCodec.decodeResponse(model, { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason }] }).finishReason;
    expect(decode("STOP")).toBe("stop");
    expect(decode("MAX_TOKENS")).toBe("length");
    expect(decode("SAFETY")).toBe("content_filter");
    expect(decode("MALFORMED_FUNCTION_CALL")).toBe("error");
  });

  it("throws GatewayError server when candidates are missing", () => {
    expect(() => googleGenerativeLanguageCodec.decodeResponse(model, { promptFeedback: {} })).toThrow(GatewayError);
  });
});

describe("google decodeStream", () => {
  it("yields deltas per chunk and assembles done from the final chunk", async () => {
    const events = await collect(
      googleGenerativeLanguageCodec.decodeStream(
        model,
        sse([
          { data: '{"responseId":"r2","candidates":[{"content":{"parts":[{"text":"hm","thought":true}]}}]}' },
          { data: '{"candidates":[{"content":{"parts":[{"text":"he"}]}}]}' },
          {
            data: '{"candidates":[{"content":{"parts":[{"text":"llo"},{"functionCall":{"name":"lookup","args":{"q":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}'
          }
        ])
      )
    );
    expect(events).toEqual([
      { type: "reasoning-delta", text: "hm" },
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "tool-call-delta", index: 0, id: "call_0", name: "lookup", argumentsDelta: '{"q":1}' },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        type: "done",
        response: {
          id: "r2",
          provider: "google-ai-studio",
          model: "gemini-2.5-flash",
          content: [
            { type: "reasoning", text: "hm" },
            { type: "text", text: "hello" },
            { type: "toolCall", id: "call_0", name: "lookup", arguments: '{"q":1}' }
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 5, outputTokens: 3 },
          warnings: []
        }
      }
    ]);
  });

  it("throws GatewayError on malformed chunks", async () => {
    await expect(collect(googleGenerativeLanguageCodec.decodeStream(model, sse([{ data: "{bad" }])))).rejects.toThrow(GatewayError);
  });
});
