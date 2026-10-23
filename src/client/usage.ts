import type { Pricing, ResolvedModel } from "../registry/types.js";
import type { Usage } from "./types.js";

/** Raw counts as a codec extracted them; `inputTokens` must already be the TOTAL prompt. */
export type UsageCounts = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  costUsd?: number;
};

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Build a Usage in the normalized convention (see Usage); zero/absent subsets are omitted. */
export function normalizeUsage(counts: UsageCounts): Usage {
  const usage: Usage = { inputTokens: finite(counts.inputTokens) ?? 0, outputTokens: finite(counts.outputTokens) ?? 0 };
  const reasoning = finite(counts.reasoningTokens);
  const cacheRead = finite(counts.cacheReadTokens);
  const cacheWrite = finite(counts.cacheWriteTokens);
  const cacheWrite1h = finite(counts.cacheWrite1hTokens);
  const cost = finite(counts.costUsd);
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  if (cacheRead !== undefined) {
    usage.cacheReadTokens = cacheRead;
    usage.cachedInputTokens = cacheRead;
  }
  if (cacheWrite !== undefined && cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
  if (cacheWrite1h !== undefined && cacheWrite1h > 0) usage.cacheWrite1hTokens = cacheWrite1h;
  if (cost !== undefined) usage.costUsd = cost;
  return usage;
}

/**
 * USD cost from catalog pricing (per million tokens):
 *   (input − cacheRead − cacheWrite) × inputPerMTok
 *   + cacheRead × cachedInputPerMTok
 *   + (cacheWrite − cacheWrite1h) × cacheWritePerMTok + cacheWrite1h × cacheWrite1hPerMTok
 *   + output × outputPerMTok            (reasoning is billed as output)
 * A cache tier without its own price falls back to inputPerMTok (1h writes fall
 * back to cacheWritePerMTok first). Undefined when input/output prices are unknown.
 */
export function computeCostUsd(pricing: Pricing | undefined, usage: Usage): number | undefined {
  const input = finite(pricing?.inputPerMTok);
  const output = finite(pricing?.outputPerMTok);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheWrite1h = Math.min(usage.cacheWrite1hTokens ?? 0, cacheWrite);
  const uncached = Math.max(usage.inputTokens - cacheRead - cacheWrite, 0);
  const readPrice = finite(pricing?.cachedInputPerMTok) ?? input;
  const writePrice = finite(pricing?.cacheWritePerMTok) ?? input;
  const write1hPrice = finite(pricing?.cacheWrite1hPerMTok) ?? writePrice;
  const micros =
    uncached * input + cacheRead * readPrice + (cacheWrite - cacheWrite1h) * writePrice + cacheWrite1h * write1hPrice + usage.outputTokens * output;
  return micros / 1_000_000;
}

/** Fill `costUsd` from the route's catalog pricing unless the provider reported one. Mutates and returns `usage`. */
export function withCost(model: ResolvedModel, usage: Usage): Usage {
  if (usage.costUsd === undefined) {
    const cost = computeCostUsd(model.meta.pricing, usage);
    if (cost !== undefined) usage.costUsd = cost;
  }
  return usage;
}
