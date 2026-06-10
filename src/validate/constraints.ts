import { ConstraintCondition, ConstraintRule } from "../registry/types.js";

export type ConstraintViolation = {
  ruleId: string;
  param: string;
  code: "forbidden_param" | "forbidden_value";
  value?: unknown;
};

export type ConstraintWarning = {
  ruleId: string;
  param: string;
  code: "dropped" | "forced" | "clamped";
};

export type ConstraintResult = {
  effective: Record<string, unknown>;
  violations: ConstraintViolation[];
  warnings: ConstraintWarning[];
};

function matches(condition: ConstraintCondition, params: Record<string, unknown>): boolean {
  if (condition.allOf) return condition.allOf.every((c) => matches(c, params));
  if (condition.anyOf) return condition.anyOf.some((c) => matches(c, params));
  if (condition.param === undefined) return false;
  const value = params[condition.param];
  if ("eq" in condition) return value === condition.eq;
  if ("neq" in condition) return value !== condition.neq;
  if ("gt" in condition) return typeof value === "number" && value > condition.gt!;
  if ("lt" in condition) return typeof value === "number" && value < condition.lt!;
  if ("in" in condition) return condition.in!.some((v) => v === value);
  return value !== undefined;
}

/**
 * Apply constraint rules to effective params (defaults already merged in).
 * `userProvided` lists params the caller explicitly set: forbidding a
 * user-provided param is a violation; forbidding a defaulted one drops it
 * with a warning instead.
 */
export function applyConstraints(
  rules: ConstraintRule[],
  params: Record<string, unknown>,
  userProvided: ReadonlySet<string>
): ConstraintResult {
  const effective = { ...params };
  const violations: ConstraintViolation[] = [];
  const warnings: ConstraintWarning[] = [];

  for (const rule of rules) {
    if (!matches(rule.when, effective)) continue;

    for (const entry of rule.then.forbid ?? []) {
      const sep = entry.indexOf(":");
      if (sep >= 0) {
        const param = entry.slice(0, sep);
        // value is always a string slice; value-qualified forbids are only
        // meaningful for string-valued params (e.g. "toolChoice:required")
        const value = entry.slice(sep + 1);
        if (effective[param] === value) {
          violations.push({ ruleId: rule.id, param, code: "forbidden_value", value });
        }
      } else if (effective[entry] !== undefined) {
        if (userProvided.has(entry)) {
          violations.push({ ruleId: rule.id, param: entry, code: "forbidden_param" });
        } else {
          delete effective[entry];
          warnings.push({ ruleId: rule.id, param: entry, code: "dropped" });
        }
      }
    }

    for (const param of rule.then.drop ?? []) {
      if (effective[param] !== undefined) {
        delete effective[param];
        warnings.push({ ruleId: rule.id, param, code: "dropped" });
      }
    }

    for (const [param, value] of Object.entries(rule.then.force ?? {})) {
      if (effective[param] !== value) {
        effective[param] = value;
        warnings.push({ ruleId: rule.id, param, code: "forced" });
      }
    }

    for (const [param, range] of Object.entries(rule.then.clamp ?? {})) {
      const current = effective[param];
      if (typeof current !== "number") continue;
      const clamped = Math.min(range.max ?? Infinity, Math.max(range.min ?? -Infinity, current));
      if (clamped !== current) {
        effective[param] = clamped;
        warnings.push({ ruleId: rule.id, param, code: "clamped" });
      }
    }
  }

  return { effective, violations, warnings };
}
