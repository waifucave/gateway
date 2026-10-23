import { describe, expect, it, vi } from "vitest";
import { computeCostUsd } from "../src/client/usage.js";
import { createGateway } from "../src/client/gateway.js";
import type { StreamEvent } from "../src/client/types.js";

describe("computeCostUsd (catalog pricing)", () => {
  const pricing = { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1, cacheWritePerMTok: 1.25, cacheWrite1hPerMTok: 2 };

  it("prices uncached input, cache reads, 5m/1h cache writes and output (reasoning inside output)", () => {
    // 130 prompt = 10 uncached + 100 read + 20 written (15 of them at 1h); 7 output
    const cost = computeCostUsd(pricing, {
      inputTokens: 130,
      outputTokens: 7,
      reasoningTokens: 3,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      cacheWrite1hTokens: 15
    });
    expect(cost).toBeCloseTo((10 * 1 + 100 * 0.1 + 5 * 1.25 + 15 * 2 + 7 * 5) / 1e6, 12);
  });

  it("falls back to the input price for cache tiers without a catalog price", () => {
    expect(computeCostUsd({ inputPerMTok: 2, outputPerMTok: 4 }, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 4, cacheWriteTokens: 2 })).toBeCloseTo(
      (10 * 2 + 1 * 4) / 1e6,
      12
    );
  });

  it("is undefined when input or output pricing is unknown", () => {
    expect(computeCostUsd(undefined, { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
    expect(computeCostUsd({ inputPerMTok: null, outputPerMTok: 1 }, { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });
});

describe("gateway usage.costUsd", () => {
  async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const event of iter) out.push(event);
    return out;
  }

  it("chat(): computes cost from catalog pricing (Anthropic incl. cache write premium)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "m",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "x" }],
            usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 7 }
          })
        )
    );
    const gateway = createGateway({ credentials: { anthropic: "k" }, fetchImpl });
    const response = await gateway.chat({ provider: "anthropic", model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hi" }] });
    // haiku 4.5: $1 in / $5 out / $0.10 cache read / $1.25 cache write (5m)
    expect(response.usage.costUsd).toBeCloseTo((10 * 1 + 100 * 0.1 + 20 * 1.25 + 7 * 5) / 1e6, 12);
  });

  it("chat(): OpenRouter's reported usage.cost wins over catalog pricing", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.5 } }))
    );
    const gateway = createGateway({ credentials: { openrouter: "k" }, fetchImpl });
    const response = await gateway.chat({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] });
    expect(response.usage.costUsd).toBe(0.5);
  });

  it("chat(): costUsd is undefined when the route has no pricing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
    );
    const gateway = createGateway({ credentials: { qwen: "k" }, fetchImpl });
    const response = await gateway.chat({ provider: "qwen", model: "qwen3.7-max", messages: [{ role: "user", content: "hi" }] });
    expect(response.usage).not.toHaveProperty("costUsd");
  });

  it("stream(): usage and done events both carry costUsd", async () => {
    const body = [
      'data: {"id":"c1","choices":[{"delta":{"content":"he"},"finish_reason":"stop"}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":0}}',
      "",
      "data: [DONE]",
      ""
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(body));
    const gateway = createGateway({ credentials: { deepseek: "k" }, fetchImpl });
    const events = await collect(
      gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    );
    const usage = events.find((e) => e.type === "usage");
    const done = events.at(-1);
    const inputPrice = gateway.getCapabilities("deepseek", "deepseek-v4-pro")!.meta.pricing!.inputPerMTok!;
    expect(usage?.type === "usage" && usage.usage.costUsd).toBeCloseTo(inputPrice, 9);
    expect(done?.type === "done" && done.response.usage.costUsd).toBeCloseTo(inputPrice, 9);
  });
});
