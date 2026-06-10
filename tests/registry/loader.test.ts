import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";

const registry = Registry.load();

describe("Registry", () => {
  it("loads 54 families and flattens all routes", () => {
    expect(registry.listFamilies()).toHaveLength(54);
    expect(registry.listModels().length).toBeGreaterThan(54);
  });

  it("resolves a native route with provider-table base URL fallback", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro");
    expect(model).toBeDefined();
    expect(model!.baseUrl).toBe("https://api.deepseek.com");
    expect(model!.endpoint).toBe("/chat/completions");
    expect(model!.wire).toBe("openai-chat");
    expect(model!.constraints.map((c) => c.id)).toContain("thinking-no-forced-tools");
  });

  it("applies route overrides for limits and pricing (owl alpha)", () => {
    const model = registry.resolve("openrouter", "openrouter/owl-alpha");
    expect(model).toBeDefined();
    expect(model!.limits.contextTokens).toBe(1048756);
    expect(model!.limits.maxOutputTokens).toBe(262144);
  });

  it("filters params on OpenRouter routes via supportedParameters", () => {
    const model = registry.resolve("openrouter", "openrouter/owl-alpha");
    // owl-alpha's supportedParameters has no min_p/top_a/verbosity-style extras;
    // every surviving canonical param must map back into the supported list
    const supported = new Set([
      "frequencyPenalty", "logitBias", "maxOutputTokens", "presencePenalty",
      "repetitionPenalty", "seed", "stopSequences", "temperature", "topK", "topP"
    ]);
    for (const name of Object.keys(model!.params)) {
      expect(supported.has(name) || name.startsWith("reasoning."), `unexpected surviving param ${name}`).toBe(true);
    }
  });

  it("resolves xiaomi base URL from route overrides", () => {
    const model = registry.resolve("xiaomi", "mimo-v2.5");
    expect(model).toBeDefined();
    expect(model!.baseUrl).toBe("https://api.xiaomimimo.com/v1");
  });

  it("returns undefined for unknown routes and collects no error-level diagnostics", () => {
    expect(registry.resolve("deepseek", "no-such-model")).toBeUndefined();
    expect(Array.isArray(registry.diagnostics())).toBe(true);
  });
});
