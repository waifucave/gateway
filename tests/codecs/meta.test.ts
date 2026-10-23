import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { createGateway } from "../../src/client/gateway.js";

const registry = Registry.load();
const versions = ["1.1", "1.2", "1.2-contributor", "1.3", "1.3-contributor"];

describe("Meta Muse Spark direct API", () => {
  it.each(versions)("registers and encodes %s without changing tiers", async (version) => {
    const modelId = `muse-spark-${version}`;
    const model = registry.resolve("meta", modelId)!;
    expect(model.limits.contextTokens).toBe(1048576);
    expect(model.features.reasoningRoundTrip).toBe(false);
    expect(model.params["reasoning.effort"].values).not.toContain("none");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "test", choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } }
    })));
    const gateway = createGateway({ credentials: { meta: "TEST_KEY" }, fetchImpl });
    const response = await gateway.chat({ provider: "meta", model: modelId,
      messages: [{ role: "user", content: "hello" }],
      params: { "reasoning.effort": "high", maxOutputTokens: 4096 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toEqual({ model: modelId,
      messages: [{ role: "user", content: "hello" }], reasoning_effort: "high", max_completion_tokens: 4096 });
    expect(response.usage.reasoningTokens).toBe(3);
    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    if (version.includes("contributor")) {
      expect(model.displayName).toContain("training enabled");
      expect(model.meta.pricing?.inputPerMTok).toBe(0.1);
    }
  });

  it.each(versions)("enforces effort and tool limits for %s", (version) => {
    const model = registry.resolve("meta", `muse-spark-${version}`)!;
    expect(validateRequest(model, { params: { "reasoning.effort": "max" } }).ok).toBe(version === "1.3");
    for (const params of [{ "reasoning.effort": "none" }, { "reasoning.enabled": false }, { topP: 0 }, { maxOutputTokens: 0 }, { logprobs: true }]) {
      expect(validateRequest(model, { params }).ok).toBe(false);
    }
    expect(validateRequest(model, { params: {}, toolChoice: "required" }).ok).toBe(false);
    expect(validateRequest(model, { params: {}, toolChoice: { name: "decision" } }).ok).toBe(false);
    expect(validateRequest(model, { params: {}, toolChoice: "auto", responseFormat: "json_schema", stream: true }).ok).toBe(true);
  });

  it("preserves the existing OpenRouter route", () => {
    expect(registry.resolve("openrouter", "meta/muse-spark-1.1")?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("serves Muse Spark 1.1 as ONE family with both routes (model ids unchanged)", () => {
    const direct = registry.resolve("meta", "muse-spark-1.1")!;
    const viaOpenRouter = registry.resolve("openrouter", "meta/muse-spark-1.1")!;
    expect(direct.family).toBe("muse-spark-1-1");
    expect(viaOpenRouter.family).toBe("muse-spark-1-1");
    const metaFamilies = registry.listFamilies().filter((doc) => doc.company === "Meta");
    expect(metaFamilies.map((doc) => doc.family).sort()).toEqual([
      "muse-spark-1-1",
      "muse-spark-1-2",
      "muse-spark-1-2-contributor",
      "muse-spark-1-3",
      "muse-spark-1-3-contributor"
    ]);
    // the OpenRouter route keeps its own modalities/pricing overlay
    expect(viaOpenRouter.modalities.input).toContain("image");
    expect(viaOpenRouter.meta.pricing?.inputPerMTok).toBe(1.25);
    expect(Object.keys(viaOpenRouter.params).sort()).toEqual(["maxOutputTokens", "reasoning.effort", "temperature", "topP"]);
  });
});
