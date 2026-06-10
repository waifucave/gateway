import { describe, expect, it } from "vitest";
import { applyConstraints } from "../../src/validate/constraints.js";
import { ConstraintRule } from "../../src/registry/types.js";

const thinkingNoForcedTools: ConstraintRule = {
  id: "thinking-no-forced-tools",
  when: { param: "reasoning.enabled", eq: true },
  then: { forbid: ["toolChoice:required", "toolChoice:named"] }
};

const thinkingDropsSampling: ConstraintRule = {
  id: "thinking-drops-sampling",
  when: { param: "reasoning.enabled", eq: true },
  then: { drop: ["temperature", "topP"] }
};

describe("applyConstraints", () => {
  it("forbid with value qualifier: violation when matching", () => {
    const result = applyConstraints([thinkingNoForcedTools], { "reasoning.enabled": true, toolChoice: "required" }, new Set(["toolChoice"]));
    expect(result.violations).toEqual([
      { ruleId: "thinking-no-forced-tools", param: "toolChoice", code: "forbidden_value", value: "required" }
    ]);
  });

  it("forbid: no violation when when-clause does not match", () => {
    const result = applyConstraints([thinkingNoForcedTools], { "reasoning.enabled": false, toolChoice: "required" }, new Set(["toolChoice"]));
    expect(result.violations).toEqual([]);
  });

  it("forbid bare param: violation only when user-provided, dropped when defaulted", () => {
    const rule: ConstraintRule = { id: "r", when: { param: "reasoning.enabled", eq: true }, then: { forbid: ["presencePenalty"] } };
    const userProvided = applyConstraints([rule], { "reasoning.enabled": true, presencePenalty: 0.5 }, new Set(["presencePenalty"]));
    expect(userProvided.violations).toHaveLength(1);
    const defaulted = applyConstraints([rule], { "reasoning.enabled": true, presencePenalty: 0.5 }, new Set());
    expect(defaulted.violations).toEqual([]);
    expect(defaulted.effective).not.toHaveProperty("presencePenalty");
    expect(defaulted.warnings).toHaveLength(1);
  });

  it("drop removes the param and records a warning", () => {
    const result = applyConstraints([thinkingDropsSampling], { "reasoning.enabled": true, temperature: 0.7 }, new Set(["temperature"]));
    expect(result.violations).toEqual([]);
    expect(result.effective).not.toHaveProperty("temperature");
    expect(result.warnings).toEqual([
      { ruleId: "thinking-drops-sampling", param: "temperature", code: "dropped" }
    ]);
  });

  it("force overwrites and clamp narrows", () => {
    const rules: ConstraintRule[] = [
      { id: "f", when: { param: "reasoning.enabled", eq: true }, then: { force: { temperature: 1 } } },
      { id: "c", when: { param: "reasoning.enabled", eq: true }, then: { clamp: { topP: { max: 0.9 } } } }
    ];
    const result = applyConstraints(rules, { "reasoning.enabled": true, temperature: 0.2, topP: 0.95 }, new Set(["temperature", "topP"]));
    expect(result.effective["temperature"]).toBe(1);
    expect(result.effective["topP"]).toBe(0.9);
    expect(result.warnings.map((w) => w.code).sort()).toEqual(["clamped", "forced"]);
  });

  it("supports gt/neq/in and allOf/anyOf combinators", () => {
    const rule: ConstraintRule = {
      id: "combo",
      when: { allOf: [{ param: "a", gt: 5 }, { anyOf: [{ param: "b", neq: "x" }, { param: "c", in: [1, 2] }] }] },
      then: { drop: ["d"] }
    };
    expect(applyConstraints([rule], { a: 6, b: "y", d: 1 }, new Set(["d"])).effective).not.toHaveProperty("d");
    expect(applyConstraints([rule], { a: 4, b: "y", d: 1 }, new Set(["d"])).effective).toHaveProperty("d");
  });
});
