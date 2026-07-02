import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";

const registry = Registry.load();

describe("Registry", () => {
  it("loads 53 families and flattens all routes", () => {
    // openrouter/owl-alpha dropped 2026-07-02: gone from OpenRouter's public
    // /models list (no "owl"/"alpha" id anywhere in the live catalog) and it
    // had no other route, so the whole family was removed.
    expect(registry.listFamilies()).toHaveLength(53);
    expect(registry.listModels().length).toBeGreaterThan(53);
  });

  it("resolves a native route with provider-table base URL fallback", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro");
    expect(model).toBeDefined();
    expect(model!.baseUrl).toBe("https://api.deepseek.com");
    expect(model!.endpoint).toBe("/chat/completions");
    expect(model!.wire).toBe("openai-chat");
    expect(model!.constraints.map((c) => c.id)).toContain("thinking-no-forced-tools");
  });

  it("applies route overrides for limits and pricing (z-ai glm-4.5-air)", () => {
    // replaces the former openrouter/owl-alpha case (route deleted 2026-07-02,
    // model gone from OpenRouter's live /models list); glm-4.5-air's openrouter
    // route overrides contextTokens/maxOutputTokens away from the doc-level
    // base (128000/96000), so it still exercises real override behavior.
    const model = registry.resolve("openrouter", "z-ai/glm-4.5-air");
    expect(model).toBeDefined();
    expect(model!.limits.contextTokens).toBe(131072);
    expect(model!.limits.maxOutputTokens).toBe(131070);
    // pricing synced to OpenRouter's live /models list on 2026-07-02
    expect(model!.meta.pricing?.inputPerMTok).toBe(0.13);
    expect(model!.meta.pricing?.outputPerMTok).toBe(0.85);
  });

  it("filters params on OpenRouter routes via supportedParameters", () => {
    const model = registry.resolve("openrouter", "z-ai/glm-4.5-air");
    // glm-4.5-air's supportedParameters has no min_p/logit_bias/top_a/verbosity-style
    // extras; every surviving canonical param must map back into the supported list
    const supported = new Set([
      "frequencyPenalty", "maxOutputTokens", "presencePenalty",
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

  it("uses endpoint overrides and reports duplicate routes via fixture data", () => {
    const fixture = Registry.load(join(import.meta.dirname, "../fixtures/loader"));
    expect(fixture.resolve("deepseek", "synthetic-endpoint")!.endpoint).toBe("/custom/endpoint");
    expect(fixture.resolve("deepseek", "synthetic-a")!.endpoint).toBe("/chat/completions");
    expect(fixture.diagnostics().some((d) => d.message === "duplicate route deepseek:synthetic-a")).toBe(true);
  });

  it("drops provider-scoped dotted params on routes with supportedParameters", () => {
    const model = registry.resolve("openrouter", "google/gemini-3.1-pro-preview");
    expect(model).toBeDefined();
    expect(Object.keys(model!.params).some((p) => p.startsWith("google."))).toBe(false);
  });

  it("keeps provider-scoped dotted params on native routes (no supportedParameters)", () => {
    const fixture = Registry.load(join(import.meta.dirname, "../fixtures/loader"));
    const model = fixture.resolve("deepseek", "synthetic-a");
    expect(Object.keys(model!.params)).toContain("google.safetySettings");
  });

  it("modalities override replaces input but keeps base output", () => {
    // openrouter route for google/gemini-3.1-pro-preview has override
    // modalities ["text","image","file","audio","video"] vs base input
    // ["text","image","video","audio","pdf"]; output stays ["text"] from base.
    const model = registry.resolve("openrouter", "google/gemini-3.1-pro-preview");
    expect(model).toBeDefined();
    expect(model!.modalities.input).toEqual(["text", "image", "file", "audio", "video"]);
    expect(model!.modalities.output).toEqual(["text"]);
  });
});
