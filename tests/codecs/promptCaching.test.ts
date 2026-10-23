import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { anthropicMessagesCodec } from "../../src/codecs/anthropicMessages.js";
import { openaiChatCodec } from "../../src/codecs/openaiChat.js";
import { openaiResponsesCodec } from "../../src/codecs/openaiResponses.js";
import { googleGenerativeLanguageCodec } from "../../src/codecs/googleGenerativeLanguage.js";
import { createGateway } from "../../src/client/gateway.js";
import type { ChatMessage } from "../../src/client/types.js";
import type { Codec } from "../../src/codecs/types.js";

const registry = Registry.load();

function encodeWith(codec: Codec, providerId: string, modelId: string, messages: ChatMessage[], promptCacheKey?: string) {
  const model = registry.resolve(providerId, modelId)!;
  return codec.encode(model, { messages, effectiveParams: {}, stream: false, promptCacheKey }, "K");
}

const EPHEMERAL = { type: "ephemeral" } as const;

describe("prompt caching — anthropic-messages (cache_control breakpoints)", () => {
  const encode = (messages: ChatMessage[]) => encodeWith(anthropicMessagesCodec, "anthropic", "claude-sonnet-4-6", messages);

  it("GOLDEN: system (1h) + epoch header + rolling tail breakpoints", () => {
    const encoded = encode([
      { role: "system", content: "harness + persona", cacheControl: { type: "ephemeral", ttl: "1h" } },
      { role: "user", content: "<conversation_summary>…</conversation_summary>", cacheControl: { type: "ephemeral" } },
      { role: "assistant", content: "hey" },
      { role: "user", content: "[14:02 #k3] Kevin: hi", cacheControl: { type: "ephemeral" } },
      { role: "user", content: "Write Aria's next message." }
    ]);
    expect(encoded.body.system).toEqual([{ type: "text", text: "harness + persona", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "<conversation_summary>…</conversation_summary>", cache_control: EPHEMERAL }] },
      { role: "assistant", content: [{ type: "text", text: "hey" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "[14:02 #k3] Kevin: hi", cache_control: EPHEMERAL },
          { type: "text", text: "Write Aria's next message." }
        ]
      }
    ]);
    expect(encoded.warnings).toEqual([]);
  });

  it("system content blocks can carry their own breakpoint; unmarked systems stay a plain string", () => {
    const blocks = encode([
      { role: "system", content: [{ type: "text", text: "static", cacheControl: { type: "ephemeral" } }, { type: "text", text: "volatile" }] },
      { role: "user", content: "hi" }
    ]);
    expect(blocks.body.system).toEqual([
      { type: "text", text: "static", cache_control: EPHEMERAL },
      { type: "text", text: "volatile" }
    ]);
    const plain = encode([{ role: "system", content: "a" }, { role: "system", content: "b" }, { role: "user", content: "hi" }]);
    expect(plain.body.system).toBe("a\n\nb");
  });

  it("keeps at most 4 breakpoints, dropping the EARLIEST extras with a warning", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: "user", content: `u${i}`, cacheControl: { type: "ephemeral" } }, { role: "assistant", content: `a${i}` });
    }
    const encoded = encode(messages);
    const marked = (encoded.body.messages as Array<{ content: Array<Record<string, unknown>> }>)
      .flatMap((m) => m.content)
      .filter((b) => b.cache_control)
      .map((b) => b.text);
    expect(marked).toEqual(["u2", "u3", "u4", "u5"]);
    expect(encoded.warnings).toEqual([
      { code: "cache_ignored", param: "cacheControl", message: "anthropic allows at most 4 cache breakpoints; dropped the 2 earliest" }
    ]);
  });

  it("downgrades a 1h breakpoint that follows a 5m one (longer TTLs must come first)", () => {
    const encoded = encode([
      { role: "system", content: "s", cacheControl: { type: "ephemeral" } },
      { role: "user", content: "u", cacheControl: { type: "ephemeral", ttl: "1h" } }
    ]);
    expect((encoded.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!.cache_control).toEqual(EPHEMERAL);
    expect(encoded.warnings.map((w) => w.code)).toEqual(["cache_ignored"]);
  });

  it("never marks a thinking block — the breakpoint moves to the last markable block of that message", () => {
    const encoded = encode([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "f", arguments: "{}" },
          { type: "reasoning", text: "", signature: "sig" }
        ],
        cacheControl: { type: "ephemeral" }
      },
      { role: "tool", toolCallId: "t1", content: "42", cacheControl: { type: "ephemeral" } }
    ]);
    const wire = encoded.body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(wire[1]!.content).toEqual([
      { type: "tool_use", id: "t1", name: "f", input: {}, cache_control: EPHEMERAL },
      { type: "thinking", thinking: "", signature: "sig" }
    ]);
    expect(wire[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "42", cache_control: EPHEMERAL }]);
  });

  it("ignores promptCacheKey (no such field on this wire)", () => {
    const encoded = encodeWith(anthropicMessagesCodec, "anthropic", "claude-sonnet-4-6", [{ role: "user", content: "hi" }], "waifu:1:chan");
    expect(JSON.stringify(encoded.body)).not.toContain("waifu:1");
  });
});

describe("prompt caching — OpenRouter cache hints on content parts", () => {
  it("GOLDEN: Anthropic-backed route converts marked messages to content-part arrays", () => {
    const encoded = encodeWith(openaiChatCodec, "openrouter", "anthropic/claude-sonnet-4.5", [
      { role: "system", content: "persona", cacheControl: { type: "ephemeral", ttl: "1h" } },
      { role: "user", content: "header", cacheControl: { type: "ephemeral" } },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "AA" }], cacheControl: { type: "ephemeral" } },
      { role: "user", content: "tail" }
    ]);
    expect(encoded.body.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "persona", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      { role: "user", content: [{ type: "text", text: "header", cache_control: EPHEMERAL }] },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [
          { type: "text", text: "a", cache_control: EPHEMERAL },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }
        ]
      },
      { role: "user", content: "tail" }
    ]);
  });

  it("Gemini-backed route gets hints too", () => {
    const encoded = encodeWith(openaiChatCodec, "openrouter", "google/gemini-2.5-flash", [
      { role: "system", content: "persona", cacheControl: { type: "ephemeral" } },
      { role: "user", content: "hi" }
    ]);
    expect((encoded.body.messages as Array<Record<string, unknown>>)[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "persona", cache_control: EPHEMERAL }]
    });
  });

  it("other OpenRouter routes and native openai-chat providers ignore the markers", () => {
    for (const [provider, modelId] of [["openrouter", "deepseek/deepseek-v4-pro"], ["deepseek", "deepseek-v4-pro"]] as const) {
      const encoded = encodeWith(openaiChatCodec, provider, modelId, [{ role: "system", content: "persona", cacheControl: { type: "ephemeral" } }]);
      expect(encoded.body.messages).toEqual([{ role: "system", content: "persona" }]);
    }
  });
});

describe("prompt caching — OpenAI prompt_cache_key", () => {
  it("openai-responses sends prompt_cache_key; markers are a no-op (implicit caching)", () => {
    const encoded = encodeWith(
      openaiResponsesCodec,
      "openai",
      "gpt-5.5",
      [{ role: "system", content: "persona", cacheControl: { type: "ephemeral" } }, { role: "user", content: "hi" }],
      "waifu:aria:chan-1"
    );
    expect(encoded.body.prompt_cache_key).toBe("waifu:aria:chan-1");
    expect(JSON.stringify(encoded.body)).not.toContain("cache_control");
  });

  it("prompt_cache_key goes only to the OpenAI provider itself (not OpenRouter, not other openai-chat providers)", () => {
    expect(encodeWith(openaiChatCodec, "openrouter", "openai/gpt-5.5", [{ role: "user", content: "hi" }], "k1").body).not.toHaveProperty("prompt_cache_key");
    expect(encodeWith(openaiChatCodec, "deepseek", "deepseek-v4-pro", [{ role: "user", content: "hi" }], "k1").body).not.toHaveProperty("prompt_cache_key");
    // a responses-wire route on another provider (synthetic) must not get it either
    const gpt = registry.resolve("openai", "gpt-5.5")!;
    const foreign = { ...gpt, providerId: "someone-else" };
    expect(openaiResponsesCodec.encode(foreign, { messages: [{ role: "user", content: "hi" }], effectiveParams: {}, stream: false, promptCacheKey: "k1" }, "K").body).not.toHaveProperty(
      "prompt_cache_key"
    );
  });
});

describe("prompt caching — google (implicit caching: no-op)", () => {
  it("drops markers and joins system blocks", () => {
    const encoded = encodeWith(googleGenerativeLanguageCodec, "google-ai-studio", "gemini-2.5-flash", [
      { role: "system", content: [{ type: "text", text: "a", cacheControl: { type: "ephemeral" } }, { type: "text", text: "b" }] },
      { role: "user", content: "hi", cacheControl: { type: "ephemeral" } }
    ]);
    expect(encoded.body.systemInstruction).toEqual({ parts: [{ text: "a\n\nb" }] });
    expect(JSON.stringify(encoded.body)).not.toMatch(/cache/i);
  });
});

describe("prompt caching — capability gating (features.promptCaching)", () => {
  const MARKED: ChatMessage[] = [{ role: "system", content: "s", cacheControl: { type: "ephemeral" } }, { role: "user", content: "hi" }];

  it("validate(): markers on a model without prompt caching are a violation", () => {
    const none = registry.resolve("openrouter", "deepseek/deepseek-v3.2")!;
    expect(none.features.promptCaching.kind).toBe("none");
    const result = validateRequest(none, { params: {}, messages: MARKED });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("unsupported_prompt_caching");
    const explicit = registry.resolve("anthropic", "claude-sonnet-4-6")!;
    expect(validateRequest(explicit, { params: {}, messages: MARKED }).ok).toBe(true);
  });

  it("chat(): markers on a no-caching model are stripped with one cache_ignored warning", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] })));
    const gateway = createGateway({ credentials: { openrouter: "k" }, fetchImpl });
    const response = await gateway.chat({ provider: "openrouter", model: "deepseek/deepseek-v3.2", messages: MARKED, promptCacheKey: "k" });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.stringify(body)).not.toContain("cache");
    expect(response.warnings.filter((w) => w.code === "cache_ignored")).toHaveLength(1);
  });

  it("chat(): Anthropic request carries the breakpoints end to end", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "m", stop_reason: "end_turn", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } }))
    );
    const gateway = createGateway({ credentials: { anthropic: "k" }, fetchImpl });
    await gateway.chat({ provider: "anthropic", model: "claude-sonnet-4-6", messages: MARKED });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.system).toEqual([{ type: "text", text: "s", cache_control: EPHEMERAL }]);
  });
});
