import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import {
  applyPassthrough,
  authHeaders,
  buildUrl,
  mapNativeParams,
  mapOpenRouterParams,
  parseArguments,
  pruneUndefined,
  setPath
} from "../../src/codecs/shared.js";
import type { Warning } from "../../src/client/types.js";

const registry = Registry.load();

function effective(providerId: string, modelId: string, params: Record<string, unknown>): Record<string, unknown> {
  const model = registry.resolve(providerId, modelId)!;
  const validation = validateRequest(model, { params });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return validation.effectiveParams;
}

describe("setPath", () => {
  it("creates nested objects from dotted paths and merges siblings", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "thinking.type", "enabled");
    setPath(target, "thinking.budget_tokens", 1500);
    setPath(target, "temperature", 0.5);
    expect(target).toEqual({ thinking: { type: "enabled", budget_tokens: 1500 }, temperature: 0.5 });
  });

  it("replaces non-object intermediates instead of crashing", () => {
    const target: Record<string, unknown> = { a: 3 };
    setPath(target, "a.b", 1);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it("rejects prototype-polluting paths (wireNames are registry-controlled)", () => {
    expect(() => setPath({}, "__proto__.polluted", true)).toThrow(/unsafe wire path/);
    expect(() => setPath({}, "constructor.prototype.x", 1)).toThrow(/unsafe wire path/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("pruneUndefined", () => {
  it("removes undefined keys deeply without mutating the input", () => {
    const input = { a: 1, b: undefined, c: { d: undefined, e: 2 }, f: [{ g: undefined, h: 3 }] };
    const out = pruneUndefined(input);
    expect(out).toEqual({ a: 1, c: { e: 2 }, f: [{ h: 3 }] });
    expect(Object.keys(input.c)).toContain("d"); // input untouched
  });

  it("preserves null values (only undefined is dropped)", () => {
    expect(pruneUndefined({ a: null, b: undefined })).toEqual({ a: null });
  });
});

describe("applyPassthrough", () => {
  it("merges keys last-write-wins and warns per key", () => {
    const body: Record<string, unknown> = { temperature: 1 };
    const warnings: Warning[] = [];
    applyPassthrough(body, { temperature: 0.2, service_tier: "flex" }, warnings);
    expect(body).toEqual({ temperature: 0.2, service_tier: "flex" });
    expect(warnings).toEqual([
      { code: "passthrough", param: "temperature", message: "temperature sent unvalidated via passthrough" },
      { code: "passthrough", param: "service_tier", message: "service_tier sent unvalidated via passthrough" }
    ]);
  });

  it("is a no-op for undefined passthrough", () => {
    const body: Record<string, unknown> = {};
    const warnings: Warning[] = [];
    applyPassthrough(body, undefined, warnings);
    expect(body).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe("mapNativeParams", () => {
  it("maps deepseek thinking via the thinking.type string transform", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const mapped = mapNativeParams(model, effective("deepseek", "deepseek-v4-pro", { temperature: 0.7, "reasoning.enabled": true }));
    expect(mapped.wire).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(mapped.warnings).toEqual([]);
  });

  it("maps reasoning.enabled=false to thinking.type disabled, keeping sampling", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const mapped = mapNativeParams(model, effective("deepseek", "deepseek-v4-pro", { temperature: 0.7, "reasoning.enabled": false }));
    expect(mapped.wire).toEqual({ temperature: 0.7, top_p: 1, thinking: { type: "disabled" }, reasoning_effort: "high" });
  });

  it("keeps qwen enable_thinking a plain boolean (transform is scoped to thinking.type)", () => {
    const model = registry.resolve("qwen", "qwen3.6-flash")!;
    const mapped = mapNativeParams(model, effective("qwen", "qwen3.6-flash", { "reasoning.enabled": true }));
    expect(mapped.wire).toEqual({ enable_thinking: true });
  });

  it("maps gemini dotted generationConfig wireNames and top-level safetySettings", () => {
    const model = registry.resolve("google-ai-studio", "gemini-2.5-flash")!;
    const mapped = mapNativeParams(
      model,
      effective("google-ai-studio", "gemini-2.5-flash", { temperature: 1.2, "reasoning.budgetTokens": 1024, "google.safetySettings": { x: 1 } })
    );
    expect(mapped.wire).toEqual({
      generationConfig: { temperature: 1.2, thinkingConfig: { thinkingBudget: 1024 } },
      safetySettings: { x: 1 }
    });
  });

  it("skips the reasoningRoundTrip directive and warns on unknown params", () => {
    const model = registry.resolve("anthropic", "claude-fable-5")!;
    const mapped = mapNativeParams(model, { reasoningRoundTrip: true, bogus: 1, "reasoning.budgetTokens": 1500 });
    expect(mapped.wire).toEqual({ thinking: { budget_tokens: 1500 } });
    expect(mapped.warnings).toEqual([
      { code: "unmapped_param", param: "bogus", message: "bogus has no descriptor on anthropic:claude-fable-5; not sent" }
    ]);
  });
});

describe("mapOpenRouterParams", () => {
  it("maps reasoning.* onto OpenRouter's normalized reasoning object", () => {
    const model = registry.resolve("openrouter", "anthropic/claude-fable-5")!;
    const mapped = mapOpenRouterParams(
      model,
      effective("openrouter", "anthropic/claude-fable-5", { "reasoning.enabled": true, "reasoning.budgetTokens": 2000 })
    );
    expect(mapped.wire).toEqual({ reasoning: { enabled: true, max_tokens: 2000 } });
    expect(mapped.warnings).toEqual([]);
  });

  it("uses OpenAI-standard names, never native wireNames", () => {
    const model = registry.resolve("openrouter", "deepseek/deepseek-v4-pro")!;
    const mapped = mapOpenRouterParams(
      model,
      effective("openrouter", "deepseek/deepseek-v4-pro", { temperature: 0.7, "reasoning.enabled": false, maxOutputTokens: 100, stopSequences: ["x"] })
    );
    expect(mapped.wire).toEqual({
      temperature: 0.7,
      top_p: 1,
      max_tokens: 100,
      stop: ["x"],
      reasoning: { enabled: false, effort: "high" }
    });
  });

  it("warns and skips params with no OpenRouter mapping", () => {
    const model = registry.resolve("openrouter", "deepseek/deepseek-v4-pro")!;
    const mapped = mapOpenRouterParams(model, { "google.safetySettings": { x: 1 } });
    expect(mapped.wire).toEqual({});
    expect(mapped.warnings).toHaveLength(1);
    expect(mapped.warnings[0]).toMatchObject({ code: "unmapped_param", param: "google.safetySettings" });
  });
});

describe("buildUrl (carryover #1: google seam)", () => {
  it("builds google generate/stream URLs with the model id in the path", () => {
    const model = registry.resolve("google-ai-studio", "gemini-2.5-flash")!;
    expect(buildUrl(model, false)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(buildUrl(model, true)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
  });

  it("concatenates baseUrl + endpoint for the other wires", () => {
    expect(buildUrl(registry.resolve("deepseek", "deepseek-v4-pro")!, false)).toBe("https://api.deepseek.com/chat/completions");
    expect(buildUrl(registry.resolve("anthropic", "claude-fable-5")!, true)).toBe("https://api.anthropic.com/v1/messages");
    expect(buildUrl(registry.resolve("openai", "gpt-5.5")!, false)).toBe("https://api.openai.com/v1/responses");
    expect(buildUrl(registry.resolve("openrouter", "deepseek/deepseek-v4-pro")!, false)).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

describe("authHeaders", () => {
  it("emits per-wire auth headers", () => {
    expect(authHeaders(registry.resolve("deepseek", "deepseek-v4-pro")!, "K")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer K"
    });
    expect(authHeaders(registry.resolve("anthropic", "claude-fable-5")!, "K")).toEqual({
      "content-type": "application/json",
      "x-api-key": "K",
      "anthropic-version": "2023-06-01"
    });
    expect(authHeaders(registry.resolve("google-ai-studio", "gemini-2.5-flash")!, "K")).toEqual({
      "content-type": "application/json",
      "x-goog-api-key": "K"
    });
  });
});

describe("parseArguments", () => {
  it("parses JSON objects, treats empty as {}, rejects non-objects", () => {
    expect(parseArguments("p", "f", '{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("p", "f", "")).toEqual({});
    expect(() => parseArguments("p", "f", "not json")).toThrow(GatewayError);
    expect(() => parseArguments("p", "f", "[1,2]")).toThrow(GatewayError);
  });
});
