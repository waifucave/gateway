import { Registry, type ModelRef } from "../registry/loader.js";
import { getProvider } from "../registry/providers.js";
import type { ProviderDef } from "../registry/types.js";

export type SyncFinding = {
  level: "error" | "warning" | "info";
  providerId: string;
  modelId?: string;
  field?: string;
  registryValue?: unknown;
  remoteValue?: unknown;
  message: string;
};

export type SyncReport = {
  /** True when there are no error- or warning-level findings (info never fails the check). */
  ok: boolean;
  findings: SyncFinding[];
  providersChecked: string[];
  providersSkipped: Array<{ providerId: string; reason: string }>;
};

export type SyncOptions = {
  dataDir?: string;
  credentials?: Record<string, string> | ((providerId: string) => string | undefined);
  fetchImpl?: typeof fetch;
  /** Limit the check to these provider ids. */
  providers?: string[];
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
};

type RemoteModel = { id: string; contextLength?: number; promptPrice?: number; completionPrice?: number };
type RemoteList = { models: Map<string, RemoteModel> } | { failure: string };

function credentialFor(credentials: SyncOptions["credentials"], providerId: string): string | undefined {
  const value = typeof credentials === "function" ? credentials(providerId) : credentials?.[providerId];
  return value === undefined || value === "" ? undefined : value;
}

async function fetchJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** OpenRouter pricing is a per-token USD string ("0.0000007") — normalize to per-MTok at 6 decimal places. */
function parsePrice(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const perToken = Number(value);
  if (!Number.isFinite(perToken)) return undefined;
  return Number((perToken * 1_000_000).toFixed(6));
}

function priceDiffers(registryValue: number | null | undefined, remoteValue: number | undefined): boolean {
  if (registryValue === null || registryValue === undefined || remoteValue === undefined) return false;
  return Number(registryValue.toFixed(6)) !== remoteValue;
}

/**
 * Remote list shapes are documented conventions, NOT live-verified (see plan
 * header) — every failure or surprise becomes a `failure`, never a throw.
 */
async function fetchRemoteList(provider: ProviderDef, credential: string | undefined, fetchImpl: typeof fetch, timeoutMs: number): Promise<RemoteList> {
  try {
    if (provider.wire === "anthropic-messages") {
      const payload = (await fetchJson(
        `${provider.baseUrl}/v1/models?limit=1000`,
        { "x-api-key": credential ?? "", "anthropic-version": "2023-06-01" },
        fetchImpl,
        timeoutMs
      )) as { data?: unknown };
      const models = new Map<string, RemoteModel>();
      for (const entry of asArray(payload.data)) {
        const id = (entry as { id?: unknown }).id;
        if (typeof id === "string") models.set(id, { id });
      }
      return { models };
    }
    if (provider.wire === "google-generative-language") {
      const models = new Map<string, RemoteModel>();
      let pageToken: string | undefined;
      do {
        const url = `${provider.baseUrl}/v1beta/models?pageSize=1000${pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`;
        const payload = (await fetchJson(url, { "x-goog-api-key": credential ?? "" }, fetchImpl, timeoutMs)) as {
          models?: unknown;
          nextPageToken?: unknown;
        };
        for (const entry of asArray(payload.models)) {
          const name = (entry as { name?: unknown }).name;
          if (typeof name === "string") {
            const id = name.replace(/^models\//, "");
            models.set(id, { id });
          }
        }
        pageToken = typeof payload.nextPageToken === "string" && payload.nextPageToken !== "" ? payload.nextPageToken : undefined;
      } while (pageToken !== undefined);
      return { models };
    }
    // openai-chat and openai-responses providers both expose GET {base}/models;
    // OpenRouter's variant additionally carries context_length + pricing
    const headers: Record<string, string> = credential === undefined ? {} : { authorization: `Bearer ${credential}` };
    const payload = (await fetchJson(`${provider.baseUrl}/models`, headers, fetchImpl, timeoutMs)) as { data?: unknown };
    const models = new Map<string, RemoteModel>();
    for (const entry of asArray(payload.data)) {
      const record = entry as { id?: unknown; context_length?: unknown; pricing?: { prompt?: unknown; completion?: unknown } };
      if (typeof record.id !== "string") continue;
      models.set(record.id, {
        id: record.id,
        contextLength: typeof record.context_length === "number" ? record.context_length : undefined,
        promptPrice: parsePrice(record.pricing?.prompt),
        completionPrice: parsePrice(record.pricing?.completion)
      });
    }
    return { models };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/** §4.7 drift check: diff the registry against remote model lists. Read-only — reports, never mutates. */
export async function runSync(options: SyncOptions = {}): Promise<SyncReport> {
  const registry = Registry.load(options.dataDir);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const findings: SyncFinding[] = [];
  const providersChecked: string[] = [];
  const providersSkipped: Array<{ providerId: string; reason: string }> = [];

  for (const diagnostic of registry.diagnostics()) {
    findings.push({
      level: "info",
      providerId: diagnostic.providerId,
      field: "registry-diagnostic",
      message: `${diagnostic.family}: ${diagnostic.message}`
    });
  }

  const refsByProvider = new Map<string, ModelRef[]>();
  for (const ref of registry.listModels()) {
    const list = refsByProvider.get(ref.providerId) ?? [];
    list.push(ref);
    refsByProvider.set(ref.providerId, list);
  }

  for (const [providerId, refs] of refsByProvider) {
    if (options.providers !== undefined && !options.providers.includes(providerId)) continue;
    const provider = getProvider(providerId);
    if (!provider) {
      findings.push({ level: "warning", providerId, message: `routes reference unknown provider "${providerId}"` });
      continue;
    }
    const credential = credentialFor(options.credentials, providerId);
    // OpenRouter's /models is public; every other list endpoint needs a key
    if (providerId !== "openrouter" && credential === undefined) {
      providersSkipped.push({ providerId, reason: `no credential (${provider.credentialEnv} not set)` });
      continue;
    }
    const remote = await fetchRemoteList(provider, credential, fetchImpl, timeoutMs);
    if ("failure" in remote) {
      findings.push({ level: "warning", providerId, field: "model-list", message: `model list unavailable: ${remote.failure}` });
      continue;
    }
    providersChecked.push(providerId);
    for (const ref of refs) {
      const remoteModel = remote.models.get(ref.modelId);
      if (remoteModel === undefined) {
        findings.push({
          level: "error",
          providerId,
          modelId: ref.modelId,
          field: "presence",
          message: `${providerId}:${ref.modelId} is not in the provider model list (renamed, removed, or stale id)`
        });
        continue;
      }
      if (providerId !== "openrouter") continue; // only OpenRouter's list carries context/pricing
      const resolved = registry.resolve(providerId, ref.modelId);
      if (!resolved) continue;
      if (remoteModel.contextLength !== undefined && remoteModel.contextLength !== resolved.limits.contextTokens) {
        findings.push({
          level: "warning",
          providerId,
          modelId: ref.modelId,
          field: "contextTokens",
          registryValue: resolved.limits.contextTokens,
          remoteValue: remoteModel.contextLength,
          message: `${providerId}:${ref.modelId} contextTokens drift: registry ${resolved.limits.contextTokens}, OpenRouter ${remoteModel.contextLength}`
        });
      }
      if (priceDiffers(resolved.meta.pricing?.inputPerMTok, remoteModel.promptPrice)) {
        findings.push({
          level: "warning",
          providerId,
          modelId: ref.modelId,
          field: "pricing.inputPerMTok",
          registryValue: resolved.meta.pricing?.inputPerMTok,
          remoteValue: remoteModel.promptPrice,
          message: `${providerId}:${ref.modelId} input pricing drift: registry ${resolved.meta.pricing?.inputPerMTok}, OpenRouter ${remoteModel.promptPrice}`
        });
      }
      if (priceDiffers(resolved.meta.pricing?.outputPerMTok, remoteModel.completionPrice)) {
        findings.push({
          level: "warning",
          providerId,
          modelId: ref.modelId,
          field: "pricing.outputPerMTok",
          registryValue: resolved.meta.pricing?.outputPerMTok,
          remoteValue: remoteModel.completionPrice,
          message: `${providerId}:${ref.modelId} output pricing drift: registry ${resolved.meta.pricing?.outputPerMTok}, OpenRouter ${remoteModel.completionPrice}`
        });
      }
    }
  }

  return { ok: findings.every((finding) => finding.level === "info"), findings, providersChecked, providersSkipped };
}
