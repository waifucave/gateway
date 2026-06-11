import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../../src/client/gateway.js";
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

  it("throws (does not yield) for validation failures", async () => {
    const fetchImpl = vi.fn();
    const gateway = createGateway({ ...CREDS, fetchImpl });
    await expect(
      collect(gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [], toolChoice: "required" }))
    ).rejects.toMatchObject({ kind: "unsupported_parameter" });
    expect(fetchImpl).not.toHaveBeenCalled();
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
