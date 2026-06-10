import { ParamDescriptor, ResolvedModel } from "../registry/types.js";
import { applyConstraints, ConstraintViolation, ConstraintWarning } from "./constraints.js";

export type ValidateInput = {
  params: Record<string, unknown>;
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: "json_object" | "json_schema";
  stream?: boolean;
};

export type ValidationViolation =
  | ConstraintViolation
  | {
      ruleId?: undefined;
      param: string;
      code: "unknown_param" | "wrong_type" | "out_of_range" | "bad_enum" | "max_items" | "unsupported_tool_choice" | "unsupported_response_format" | "unsupported_stream";
      message: string;
    };

export type ValidationResult = {
  ok: boolean;
  violations: ValidationViolation[];
  warnings: ConstraintWarning[];
  /** Only meaningful when `ok` is true — may contain the rejected values otherwise. */
  effectiveParams: Record<string, unknown>;
};

function checkDescriptor(name: string, value: unknown, d: ParamDescriptor): ValidationViolation | undefined {
  const wrong = (expected: string): ValidationViolation => ({
    param: name, code: "wrong_type", message: `${name} must be ${expected}`
  });
  switch (d.type) {
    case "number":
    case "int": {
      if (typeof value !== "number" || Number.isNaN(value)) return wrong("a number");
      if (d.type === "int" && !Number.isInteger(value)) return wrong("an integer");
      if ((d.min !== undefined && value < d.min) || (d.max !== undefined && value > d.max)) {
        return { param: name, code: "out_of_range", message: `${name} must be in [${d.min ?? "-inf"}, ${d.max ?? "inf"}]` };
      }
      return undefined;
    }
    case "boolean":
      return typeof value === "boolean" ? undefined : wrong("a boolean");
    case "enum":
      if (typeof value !== "string") return wrong("a string");
      if (d.values && !d.values.includes(value)) {
        return { param: name, code: "bad_enum", message: `${name} must be one of ${d.values.join(", ")}` };
      }
      return undefined;
    case "string":
      return typeof value === "string" ? undefined : wrong("a string");
    case "string[]": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return wrong("an array of strings");
      if (d.maxItems !== undefined && value.length > d.maxItems) {
        return { param: name, code: "max_items", message: `${name} allows at most ${d.maxItems} items` };
      }
      return undefined;
    }
    case "map":
      return value !== null && typeof value === "object" && !Array.isArray(value) ? undefined : wrong("an object");
  }
}

export function validateRequest(model: ResolvedModel, input: ValidateInput): ValidationResult {
  const violations: ValidationViolation[] = [];

  // 1. unknown params + descriptor checks
  for (const [name, value] of Object.entries(input.params)) {
    if (value === undefined) continue;
    const descriptor = model.params[name];
    if (!descriptor) {
      violations.push({ param: name, code: "unknown_param", message: `${name} is not supported by ${model.providerId}:${model.modelId}` });
      continue;
    }
    const issue = checkDescriptor(name, value, descriptor);
    if (issue) violations.push(issue);
  }

  // 2. feature-level checks
  const toolChoiceMode = typeof input.toolChoice === "object" ? "named" : input.toolChoice;
  if (toolChoiceMode && toolChoiceMode !== "auto") {
    const supported = model.features.tools.supported ? (model.features.tools.toolChoice ?? ["auto"]) : [];
    if (!supported.includes(toolChoiceMode)) {
      violations.push({ param: "toolChoice", code: "unsupported_tool_choice", message: `toolChoice ${toolChoiceMode} is not supported` });
    }
  }
  if (input.responseFormat === "json_object" && !model.features.structuredOutput.jsonMode) {
    violations.push({ param: "responseFormat", code: "unsupported_response_format", message: "json_object mode is not supported" });
  }
  if (input.responseFormat === "json_schema" && !model.features.structuredOutput.jsonSchema) {
    violations.push({ param: "responseFormat", code: "unsupported_response_format", message: "json_schema mode is not supported" });
  }
  if (input.stream && !model.features.streaming) {
    violations.push({ param: "stream", code: "unsupported_stream", message: "streaming is not supported" });
  }

  // 3. effective params = defaults ∪ user params (+ normalized toolChoice/responseFormat for rules)
  const effective: Record<string, unknown> = {};
  const userProvided = new Set<string>();
  for (const [name, descriptor] of Object.entries(model.params)) {
    if (descriptor.default !== undefined) effective[name] = descriptor.default;
  }
  for (const [name, value] of Object.entries(input.params)) {
    if (value === undefined) continue;
    effective[name] = value;
    userProvided.add(name);
  }

  // 3b. pseudo-params for constraint matching: track injection so a real model
  // param with the same canonical name (e.g. OpenAI's responseFormat map) is
  // restored after rule evaluation instead of being silently stripped.
  const injectedPseudo: Array<{ key: string; had: boolean; prior: unknown }> = [];
  const injectPseudo = (key: string, value: unknown) => {
    injectedPseudo.push({ key, had: key in effective, prior: effective[key] });
    effective[key] = value;
    userProvided.add(key);
  };
  if (toolChoiceMode) injectPseudo("toolChoice", toolChoiceMode);
  if (input.responseFormat) injectPseudo("responseFormat", input.responseFormat);

  // 4. constraint rules
  const constraintResult = applyConstraints(model.constraints, effective, userProvided);
  violations.push(...constraintResult.violations);

  // 5. remove injected pseudo-params, restoring any real param they shadowed
  const effectiveParams = { ...constraintResult.effective };
  for (const { key, had, prior } of injectedPseudo) {
    if (had) effectiveParams[key] = prior;
    else delete effectiveParams[key];
  }

  return { ok: violations.length === 0, violations, warnings: constraintResult.warnings, effectiveParams };
}
