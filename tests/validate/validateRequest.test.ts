import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";

const registry = Registry.load();

describe("validateRequest", () => {
  it("rejects forced tool choice when DeepSeek thinking is enabled (live-validated 2026-06-10)", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const result = validateRequest(model, { params: { "reasoning.enabled": true }, toolChoice: "required" });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "forbidden_value" && v.param === "toolChoice")).toBe(true);
  });

  it("DeepSeek thinking defaults ON, so forced tool choice fails even without explicit reasoning param", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-flash")!;
    const result = validateRequest(model, { params: {}, toolChoice: "required" });
    expect(result.ok).toBe(false);
  });

  it("DeepSeek forced tool choice passes with thinking explicitly disabled", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-flash")!;
    const result = validateRequest(model, { params: { "reasoning.enabled": false }, toolChoice: "required" });
    expect(result.ok).toBe(true);
  });

  it("enforces Gemini's 5-stop-sequence cap", () => {
    const model = registry.resolve("google-ai-studio", "gemini-2.5-flash")!;
    const result = validateRequest(model, { params: { stopSequences: ["a", "b", "c", "d", "e", "f"] } });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "max_items" && v.param === "stopSequences")).toBe(true);
    expect(validateRequest(model, { params: { stopSequences: ["a", "b", "c", "d", "e"] } }).ok).toBe(true);
  });

  it("rejects unknown params (GPT-5.5 has no temperature)", () => {
    const model = registry.resolve("openai", "gpt-5.5")!;
    const result = validateRequest(model, { params: { temperature: 0.7 } });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "unknown_param" && v.param === "temperature")).toBe(true);
  });

  it("rejects out-of-range, wrong-type, and bad-enum values", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    expect(validateRequest(model, { params: { temperature: 99 } }).violations[0]?.code).toBe("out_of_range");
    expect(validateRequest(model, { params: { temperature: "hot" } }).violations[0]?.code).toBe("wrong_type");
    expect(validateRequest(model, { params: { "reasoning.effort": "ludicrous" } }).violations[0]?.code).toBe("bad_enum");
  });

  it("rejects unsupported toolChoice modes per features", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const supported = model.features.tools.toolChoice ?? [];
    expect(supported).toContain("required"); // sanity: rejection below comes from constraints, not features
    const fake = { ...model, features: { ...model.features, tools: { ...model.features.tools, toolChoice: ["auto", "none"] as Array<"auto" | "none"> } } };
    const result = validateRequest(fake, { params: {}, toolChoice: "required" });
    expect(result.violations.some((v) => v.code === "unsupported_tool_choice")).toBe(true);
  });

  it("returns effective params with defaults merged", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const result = validateRequest(model, { params: { "reasoning.enabled": false, temperature: 0.5 } });
    expect(result.ok).toBe(true);
    expect(result.effectiveParams["temperature"]).toBe(0.5);
    expect(result.effectiveParams["reasoning.enabled"]).toBe(false);
  });

  it("preserves a real responseFormat model param in effectiveParams (gpt-5.5 carries one)", () => {
    const model = registry.resolve("openai", "gpt-5.5")!;
    const value = { type: "json_schema", schema: { type: "object" } };
    const result = validateRequest(model, { params: { responseFormat: value } });
    expect(result.ok).toBe(true);
    expect(result.effectiveParams["responseFormat"]).toEqual(value);
  });

  it("restores a shadowed real param after pseudo responseFormat rule matching", () => {
    // gpt-5.5 has features.structuredOutput.jsonSchema=true, so result.ok is true
    const model = registry.resolve("openai", "gpt-5.5")!;
    const value = { type: "json_schema", schema: { type: "object" } };
    const result = validateRequest(model, { params: { responseFormat: value }, responseFormat: "json_schema" });
    expect(result.ok).toBe(true);
    expect(result.effectiveParams["responseFormat"]).toEqual(value);
  });
});
