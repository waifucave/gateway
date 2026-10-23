import { describe, expect, it, vi } from "vitest";
import { createGateway, streamIdleTimeoutFor } from "../../src/client/gateway.js";
import { Registry } from "../../src/registry/loader.js";
import { GatewayError } from "../../src/errors.js";
import type { StreamEvent } from "../../src/client/types.js";

const OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

function jsonFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

const CREDS = { credentials: { deepseek: "sk-test", openrouter: "sk-or" } };

describe("gateway.chat", () => {
  it("sends the encoded body and returns the normalized response with merged warnings", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const response = await gateway.chat({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.7, "reasoning.enabled": true }
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.finishReason).toBe("stop");
    // the DeepSeek sampling-drop quirk surfaces as warnings end to end
    expect(response.warnings).toContainEqual({
      code: "param_dropped",
      param: "temperature",
      ruleId: "thinking-drops-sampling",
      message: "temperature was dropped by constraint rule thinking-drops-sampling"
    });
    expect(response.raw).toBeUndefined();
  });

  it("gates on validation BEFORE any I/O (carryover #5)", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const error = await gateway
      .chat({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], toolChoice: "required" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.kind).toBe("unsupported_parameter");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws invalid_request for unknown models and auth for missing credentials", async () => {
    const gateway = createGateway({ ...CREDS, fetchImpl: jsonFetch(OK_PAYLOAD) });
    await expect(gateway.chat({ provider: "deepseek", model: "nope", messages: [] })).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(
      gateway.chat({ provider: "anthropic", model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("supports credential lookup functions and includeRaw", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const gateway = createGateway({ credentials: (id) => (id === "deepseek" ? "sk-fn" : undefined), fetchImpl, includeRaw: true });
    const response = await gateway.chat({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false }
    });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-fn" });
    expect(response.raw).toEqual(OK_PAYLOAD);
  });

  it("maps provider HTTP errors through the taxonomy", async () => {
    const fetchImpl = jsonFetch({ error: { message: "invalid api key" } }, 401);
    const gateway = createGateway({ ...CREDS, fetchImpl });
    await expect(
      gateway.chat({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("strips images for text-only models with a content_dropped warning (lenient chat path, G9)", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const response = await gateway.chat({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
        { role: "user", content: [{ type: "image", mimeType: "image/png", data: "BBBB" }] }
      ],
      params: { "reasoning.enabled": false }
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.stringify(body.messages)).not.toContain("image_url");
    expect(body.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "look" }] });
    expect(response.warnings.filter((w) => w.code === "content_dropped")).toEqual([
      { code: "content_dropped", param: "messages[0].content[1]", message: "image input is not supported by deepseek:deepseek-v4-pro; image dropped" },
      { code: "content_dropped", param: "messages[1].content[0]", message: "image input is not supported by deepseek:deepseek-v4-pro; image dropped" }
    ]);
  });

  it("throws server for non-JSON success bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    const gateway = createGateway({ ...CREDS, fetchImpl });
    await expect(
      gateway.chat({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    ).rejects.toMatchObject({ kind: "server" });
  });

  it("throws server (not a raw TypeError) for a literal JSON null body", async () => {
    const fetchImpl = vi.fn(async () => new Response("null", { status: 200 }));
    const gateway = createGateway({ ...CREDS, fetchImpl });
    await expect(
      gateway.chat({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    ).rejects.toMatchObject({ kind: "server" });
  });

  it("integrates the anthropic-messages wire end to end", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_1",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "salut" }],
            usage: { input_tokens: 2, output_tokens: 1 }
          }),
          { status: 200 }
        )
    );
    const gateway = createGateway({ credentials: { anthropic: "sk-ant" }, fetchImpl });
    const response = await gateway.chat({
      provider: "anthropic",
      model: "claude-fable-5",
      messages: [{ role: "user", content: "hi" }],
      params: { maxOutputTokens: 2048 }
    });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "claude-fable-5",
      max_tokens: 2048,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
    expect(response.content).toEqual([{ type: "text", text: "salut" }]);
    expect(response.finishReason).toBe("stop");
  });
});

describe("gateway reasoning.exclude (G1: hidden gateway-side, signatures kept)", () => {
  const THINKING_PAYLOAD = {
    id: "msg_2",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "secret plan", signature: "sig_1" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "answer" }
    ],
    usage: { input_tokens: 2, output_tokens: 9 }
  };

  it("chat(): hides thinking text but keeps it opaque (replay) with the signature for byte-exact round-trip", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(THINKING_PAYLOAD), { status: 200 }));
    const gateway = createGateway({ credentials: { anthropic: "sk-ant" }, fetchImpl });
    const response = await gateway.chat({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": true, "reasoning.exclude": true }
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(response.content).toEqual([
      { type: "reasoning", text: "", signature: "sig_1", replay: "secret plan" },
      { type: "reasoning", text: "", redacted: true, data: "opaque" },
      { type: "text", text: "answer" }
    ]);
    // Anthropic rejects MODIFIED thinking blocks: replaying the hidden block re-sends the original text
    const second = await gateway.chat({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: response.content as never },
        { role: "user", content: "and?" }
      ],
      params: { "reasoning.enabled": true, "reasoning.exclude": true }
    });
    expect(second.content.at(-1)).toEqual({ type: "text", text: "answer" });
    const replayed = JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string);
    expect(replayed.messages[1].content[0]).toEqual({ type: "thinking", thinking: "secret plan", signature: "sig_1" });
  });

  it("chat(): without exclude the thinking text is surfaced", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(THINKING_PAYLOAD), { status: 200 }));
    const gateway = createGateway({ credentials: { anthropic: "sk-ant" }, fetchImpl });
    const response = await gateway.chat({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": true }
    });
    expect(response.content[0]).toEqual({ type: "reasoning", text: "secret plan", signature: "sig_1" });
  });

  it("stream(): suppresses reasoning-delta events and blanks reasoning text in done", async () => {
    const lines = [
      { type: "message_start", message: { id: "msg_3", usage: { input_tokens: 2 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_s" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" }
    ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const fetchImpl = vi.fn(async () => new Response(lines.join(""), { status: 200 }));
    const gateway = createGateway({ credentials: { anthropic: "sk-ant" }, fetchImpl });
    const events = await collect(
      gateway.stream({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "hi" }],
        params: { "reasoning.enabled": true, "reasoning.exclude": true }
      })
    );
    expect(events.some((e) => e.type === "reasoning-delta")).toBe(false);
    const done = events.at(-1)!;
    if (done.type !== "done") throw new Error("no done");
    expect(done.response.content).toEqual([
      { type: "reasoning", text: "", signature: "sig_s", replay: "secret" },
      { type: "text", text: "ok" }
    ]);
  });
});

describe("gateway.stream", () => {
  const SSE_BODY = [
    'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"y"},"finish_reason":"stop"}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    "",
    "data: [DONE]",
    ""
  ].join("\n");

  it("streams normalized events; done carries merged warnings", async () => {
    const fetchImpl = vi.fn(async () => new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const events = await collect(
      gateway.stream({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { temperature: 0.7, "reasoning.enabled": true }
      })
    );
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "usage", "done"]);
    const done = events.at(-1)!;
    if (done.type === "done") {
      expect(done.response.content).toEqual([{ type: "text", text: "hey" }]);
      expect(done.response.warnings.some((w) => w.code === "param_dropped" && w.param === "temperature")).toBe(true);
    }
  });

  it("yields an error event for mid-stream failures instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("data: {broken\n\n", { status: 200 }));
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const events = await collect(
      gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    if (events[0]!.type === "error") expect(events[0]!.error).toBeInstanceOf(GatewayError);
  });

  it("aborts a stalled stream with a timeout error after streamIdleTimeoutMs without data (G11)", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n'));
            // …and then nothing, forever
          },
          cancel() {
            cancelled = true;
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );
    const gateway = createGateway({ ...CREDS, fetchImpl, streamIdleTimeoutMs: 30 });
    const started = Date.now();
    const events = await collect(
      gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "error"]);
    const last = events.at(-1)!;
    if (last.type === "error") {
      expect(last.error.kind).toBe("timeout");
      expect(last.error.message).toMatch(/stalled/);
    }
    expect(cancelled).toBe(true);
  });

  it("throws (does not yield) for validation failures", async () => {
    const fetchImpl = vi.fn();
    const gateway = createGateway({ ...CREDS, fetchImpl });
    await expect(
      collect(gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [], toolChoice: "required" }))
    ).rejects.toMatchObject({ kind: "unsupported_parameter" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("streamIdleTimeoutFor (stall-guard defaults)", () => {
  const registry = Registry.load();
  const deepseek = registry.resolve("deepseek", "deepseek-v4-pro")!;
  const fable = registry.resolve("anthropic", "claude-fable-5")!;
  const haiku = registry.resolve("anthropic", "claude-haiku-4-5-20251001")!;

  it("defaults to 60s without reasoning and 180s when reasoning is active", () => {
    expect(streamIdleTimeoutFor(haiku, {}, undefined)).toBe(60_000);
    expect(streamIdleTimeoutFor(haiku, { "reasoning.enabled": true }, undefined)).toBe(180_000);
    expect(streamIdleTimeoutFor(deepseek, { "reasoning.enabled": false }, undefined)).toBe(60_000);
    expect(streamIdleTimeoutFor(deepseek, { "reasoning.effort": "high" }, undefined)).toBe(180_000);
    expect(streamIdleTimeoutFor(deepseek, { "reasoning.effort": "none" }, undefined)).toBe(60_000);
    // always-on thinking families count as reasoning even with no params
    expect(streamIdleTimeoutFor(fable, {}, undefined)).toBe(180_000);
  });

  it("an explicit streamIdleTimeoutMs always wins (0 disables)", () => {
    expect(streamIdleTimeoutFor(haiku, { "reasoning.enabled": true }, 5_000)).toBe(5_000);
    expect(streamIdleTimeoutFor(haiku, {}, 0)).toBe(0);
  });
});

describe("gateway registry surface", () => {
  it("exposes listModels, getCapabilities and validate", () => {
    const gateway = createGateway();
    expect(gateway.listModels().length).toBeGreaterThan(54);
    expect(gateway.getCapabilities("deepseek", "deepseek-v4-pro")?.wire).toBe("openai-chat");
    expect(gateway.getCapabilities("deepseek", "nope")).toBeUndefined();
    expect(gateway.validate("deepseek", "deepseek-v4-pro", { params: { temperature: 99 } }).ok).toBe(false);
    expect(() => gateway.validate("deepseek", "nope", { params: {} })).toThrow(GatewayError);
  });
});
