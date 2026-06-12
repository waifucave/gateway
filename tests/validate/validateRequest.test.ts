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

describe("unverified descriptors and placeholder caps (found live in Discord Waifus P2 smoke)", () => {
  it("skips range enforcement for unverified descriptors — a P0 placeholder max=0 must not reject requests (§4.2)", () => {
    const model = registry.resolve("xai", "grok-4.3")!;
    expect(model.params["maxOutputTokens"]?.confidence).toBe("unverified");
    const result = validateRequest(model, { params: { maxOutputTokens: 4096 } });
    expect(result.violations.filter((v) => v.param === "maxOutputTokens")).toEqual([]);
  });

  it("still type-checks unverified params", () => {
    const model = registry.resolve("xai", "grok-4.3")!;
    const result = validateRequest(model, { params: { maxOutputTokens: "lots" } });
    expect(result.violations.some((v) => v.param === "maxOutputTokens" && v.code === "wrong_type")).toBe(true);
  });

  it("Sonnet 4.5 carries its documented 64000 output cap (native cell was a verified placeholder 0; the OpenRouter route override already had 64000)", () => {
    const model = registry.resolve("anthropic", "claude-sonnet-4-5-20250929")!;
    expect(model.limits.maxOutputTokens).toBe(64000);
    expect(
      validateRequest(model, { params: { maxOutputTokens: 64000 } }).violations.filter(
        (v) => v.param === "maxOutputTokens"
      )
    ).toEqual([]);
    const over = validateRequest(model, { params: { maxOutputTokens: 64001 } });
    expect(over.violations.some((v) => v.param === "maxOutputTokens" && v.code === "out_of_range")).toBe(true);
  });

  it("Gemma output caps are unverified per P0 findings, so a cap request passes through", () => {
    for (const id of ["gemma-4-26b-a4b-it", "gemma-4-31b-it"]) {
      const model = registry.resolve("google-ai-studio", id)!;
      expect(model.params["maxOutputTokens"]?.confidence).toBe("unverified");
      expect(
        validateRequest(model, { params: { maxOutputTokens: 2048 } }).violations.filter(
          (v) => v.param === "maxOutputTokens"
        )
      ).toEqual([]);
    }
  });

  it("Gemini/Gemma forced and named tool choice pass validation (live-probed via mode ANY, 2026-06-12)", () => {
    const probed = [
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite",
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it"
    ];
    for (const id of probed) {
      const model = registry.resolve("google-ai-studio", id)!;
      expect(validateRequest(model, { params: {}, toolChoice: "required" }).ok, id).toBe(true);
      expect(validateRequest(model, { params: {}, toolChoice: { name: "x" } }).ok, id).toBe(true);
    }
    // gemini-2.5-pro was probed too: mode ANY is accepted but does NOT force a
    // call, so its conservative ["auto","none"] cell stands.
    const pro = registry.resolve("google-ai-studio", "gemini-2.5-pro")!;
    expect(validateRequest(pro, { params: {}, toolChoice: "required" }).ok).toBe(false);
  });
});
