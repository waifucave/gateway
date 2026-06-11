import { afterEach, describe, expect, it } from "vitest";
import { serve, type RunningServer } from "../../src/server/node.js";
import { envCredentials } from "../../src/server/env.js";
import { jsonFetch, parseSseFrames, sseFetch } from "../helpers/http.js";

const OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("serve", () => {
  it("answers /v1/providers over a real socket on an ephemeral port", async () => {
    running = await serve({ port: 0, credentials: envCredentials({ DEEPSEEK_API_KEY: "sk-env" }) });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${running.url}/v1/providers`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: Array<{ id: string; credentialConfigured: boolean }> };
    expect(body.providers).toHaveLength(14);
    expect(body.providers.find((p) => p.id === "deepseek")?.credentialConfigured).toBe(true);
    expect(body.providers.find((p) => p.id === "anthropic")?.credentialConfigured).toBe(false);
  });

  it("answers non-streaming chat over a real socket", async () => {
    running = await serve({ port: 0, credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD) });
    const response = await fetch(`${running.url}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { "reasoning.enabled": false }
      })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "hello" }], finishReason: "stop" });
  });

  it("streams SSE over a real socket", async () => {
    running = await serve({
      port: 0,
      credentials: { deepseek: "sk-test" },
      fetchImpl: sseFetch([
        'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"y"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        ""
      ])
    });
    const response = await fetch(`${running.url}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { "reasoning.enabled": false },
        stream: true
      })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = parseSseFrames(await response.text());
    expect(frames.at(-1)).toBe("[DONE]");
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "text-delta",
      "text-delta",
      "done",
      "[DONE]"
    ]);
  });

  it("404s unknown paths", async () => {
    running = await serve({ port: 0 });
    expect((await fetch(`${running.url}/nope`)).status).toBe(404);
    expect((await fetch(`${running.url}/v1/nope`)).status).toBe(404);
  });

  it("aborts the upstream provider fetch when the client socket disconnects mid-stream", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n'));
          // never closes — stream stays open until aborted
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    running = await serve({ port: 0, credentials: { deepseek: "sk-test" }, fetchImpl });

    const controller = new AbortController();
    const response = await fetch(`${running.url}/v1/chat`, {
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
    });
    const reader = response.body!.getReader();
    await reader.read(); // first frame arrives
    expect(upstreamSignal?.aborted).toBe(false);
    controller.abort(); // tear down the client socket mid-stream
    // poll until the abort propagates: socket close → res 'close' → handler signal → upstream fetch
    const deadline = Date.now() + 2000;
    while (!upstreamSignal?.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(upstreamSignal?.aborted).toBe(true);
  });
});
