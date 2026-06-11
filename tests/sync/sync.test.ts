import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSync, type SyncReport } from "../../src/sync/sync.js";

const dataDir = join(import.meta.dirname, "../fixtures/sync");

type Responder = (url: string) => unknown | Response;

/** Routes fake fetches by URL substring; unmatched URLs 500. */
function fakeFetch(responders: Record<string, Responder>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    for (const [needle, responder] of Object.entries(responders)) {
      if (!url.includes(needle)) continue;
      const result = responder(url);
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
}

const OPENROUTER_CLEAN = {
  data: [{ id: "drift/drift-model", context_length: 100000, pricing: { prompt: "0.0000005", completion: "0.0000015" } }]
};
const DEEPSEEK_CLEAN = { data: [{ id: "drift-native" }] };
const ANTHROPIC_CLEAN = { data: [{ id: "claude-drift-1" }] };
const GOOGLE_CLEAN = { models: [{ name: "models/gemini-drift-1" }] };

const ALL_CREDS = { deepseek: "sk-d", anthropic: "sk-a", "google-ai-studio": "sk-g" };

function cleanFetch() {
  return fakeFetch({
    "openrouter.ai": () => OPENROUTER_CLEAN,
    "api.deepseek.com/models": () => DEEPSEEK_CLEAN,
    "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
    "generativelanguage.googleapis.com/v1beta/models": () => GOOGLE_CLEAN
  });
}

function levels(report: SyncReport): string[] {
  return report.findings.map((f) => f.level);
}

describe("runSync", () => {
  it("reports clean when every remote list matches (pricing strings round-trip exactly)", async () => {
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl: cleanFetch() });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.providersChecked.sort()).toEqual(["anthropic", "deepseek", "google-ai-studio", "openrouter"]);
    expect(report.providersSkipped).toEqual([]);
  });

  it("flags a registry model missing from the remote list as an error", async () => {
    const fetchImpl = fakeFetch({
      "openrouter.ai": () => ({ data: [] }),
      "api.deepseek.com/models": () => DEEPSEEK_CLEAN,
      "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
      "generativelanguage.googleapis.com/v1beta/models": () => GOOGLE_CLEAN
    });
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      {
        level: "error",
        providerId: "openrouter",
        modelId: "drift/drift-model",
        field: "presence",
        message: "openrouter:drift/drift-model is not in the provider model list (renamed, removed, or stale id)"
      }
    ]);
  });

  it("flags OpenRouter context and pricing drift as warnings with both values", async () => {
    const fetchImpl = fakeFetch({
      "openrouter.ai": () => ({
        data: [{ id: "drift/drift-model", context_length: 65536, pricing: { prompt: "0.0000007", completion: "0.0000015" } }]
      }),
      "api.deepseek.com/models": () => DEEPSEEK_CLEAN,
      "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
      "generativelanguage.googleapis.com/v1beta/models": () => GOOGLE_CLEAN
    });
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({
      level: "warning",
      providerId: "openrouter",
      modelId: "drift/drift-model",
      field: "contextTokens",
      registryValue: 100000,
      remoteValue: 65536,
      message: "openrouter:drift/drift-model contextTokens drift: registry 100000, OpenRouter 65536"
    });
    expect(report.findings).toContainEqual({
      level: "warning",
      providerId: "openrouter",
      modelId: "drift/drift-model",
      field: "pricing.inputPerMTok",
      registryValue: 0.5,
      remoteValue: 0.7,
      message: "openrouter:drift/drift-model input pricing drift: registry 0.5, OpenRouter 0.7"
    });
    expect(levels(report)).not.toContain("error");
  });

  it("skips providers without credentials but always checks public OpenRouter", async () => {
    const report = await runSync({ dataDir, credentials: {}, fetchImpl: cleanFetch() });
    expect(report.providersChecked).toEqual(["openrouter"]);
    expect(report.providersSkipped).toEqual([
      { providerId: "deepseek", reason: "no credential (DEEPSEEK_API_KEY not set)" },
      { providerId: "anthropic", reason: "no credential (ANTHROPIC_API_KEY not set)" },
      { providerId: "google-ai-studio", reason: "no credential (GOOGLE_AI_STUDIO_API_KEY not set)" }
    ]);
    expect(report.ok).toBe(true);
  });

  it("reports unreachable/broken provider lists as warnings, not crashes", async () => {
    const fetchImpl = fakeFetch({
      "openrouter.ai": () => new Response("upstream exploded", { status: 503 }),
      "api.deepseek.com/models": () => {
        throw new Error("ECONNREFUSED");
      },
      "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
      "generativelanguage.googleapis.com/v1beta/models": () => GOOGLE_CLEAN
    });
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl });
    expect(report.ok).toBe(false);
    const warningProviders = report.findings.filter((f) => f.field === "model-list").map((f) => f.providerId);
    expect(warningProviders.sort()).toEqual(["deepseek", "openrouter"]);
    expect(report.providersChecked.sort()).toEqual(["anthropic", "google-ai-studio"]);
  });

  it("follows google pagination and strips the models/ prefix", async () => {
    const fetchImpl = fakeFetch({
      "openrouter.ai": () => OPENROUTER_CLEAN,
      "api.deepseek.com/models": () => DEEPSEEK_CLEAN,
      "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
      "generativelanguage.googleapis.com/v1beta/models": (url) =>
        url.includes("pageToken=page2")
          ? { models: [{ name: "models/gemini-drift-1" }] }
          : { models: [{ name: "models/something-else" }], nextPageToken: "page2" }
    });
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl });
    expect(report.findings).toEqual([]);
  });

  it("honors the providers filter without marking the rest skipped", async () => {
    const fetchImpl = cleanFetch();
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl, providers: ["openrouter"] });
    expect(report.providersChecked).toEqual(["openrouter"]);
    expect(report.providersSkipped).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces registry diagnostics as info findings that do not fail the check", async () => {
    // the REAL registry has 14 unmapped-supportedParameters diagnostics; run sync
    // against it with no creds and a fake OpenRouter that contains every id
    const { Registry } = await import("../../src/registry/loader.js");
    const ids = Registry.load()
      .listModels()
      .filter((m) => m.providerId === "openrouter")
      .map((m) => ({ id: m.modelId }));
    const fetchImpl = fakeFetch({ "openrouter.ai": () => ({ data: ids }) });
    const report = await runSync({ credentials: {}, fetchImpl, providers: ["openrouter"] });
    const infos = report.findings.filter((f) => f.level === "info" && f.field === "registry-diagnostic");
    expect(infos).toHaveLength(14);
    // ids all match and pricing/context comparisons are skipped (no remote values in this fixture)
    expect(report.findings.filter((f) => f.level !== "info")).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
