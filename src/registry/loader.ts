import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getProvider } from "./providers.js";
import {
  CapabilityDoc,
  ParamDescriptor,
  RegistryDiagnostic,
  ResolvedModel,
  RouteDef,
  WireProtocol
} from "./types.js";

const WIRE_DEFAULT_ENDPOINT: Record<WireProtocol, string> = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages",
  "google-generative-language": ":generateContent"
};

/** OpenRouter/native wire parameter names → canonical param names. */
const WIRE_PARAM_TO_CANONICAL: Record<string, string> = {
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  min_p: "minP",
  top_a: "topA",
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
  repetition_penalty: "repetitionPenalty",
  logit_bias: "logitBias",
  seed: "seed",
  logprobs: "logprobs",
  top_logprobs: "topLogprobs",
  max_tokens: "maxOutputTokens",
  stop: "stopSequences",
  verbosity: "verbosity"
};

/** supportedParameters entries that gate features/params indirectly, not 1:1. */
const NON_PARAM_WIRE_NAMES = new Set([
  "tools", "tool_choice", "response_format", "structured_outputs", "reasoning", "include_reasoning"
]);

export type ModelRef = {
  providerId: string;
  modelId: string;
  family: string;
  displayName: string;
  company: string;
  wire: WireProtocol;
};

export class Registry {
  private constructor(
    private readonly docs: CapabilityDoc[],
    private readonly routeIndex: Map<string, { doc: CapabilityDoc; route: RouteDef }>,
    private readonly diags: RegistryDiagnostic[]
  ) {}

  static load(dataDir?: string): Registry {
    const dir = dataDir ?? fileURLToPath(new URL("../../data", import.meta.url));
    const docs: CapabilityDoc[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      docs.push(...(JSON.parse(readFileSync(join(dir, file), "utf8")) as CapabilityDoc[]));
    }
    const routeIndex = new Map<string, { doc: CapabilityDoc; route: RouteDef }>();
    const diags: RegistryDiagnostic[] = [];
    for (const doc of docs) {
      for (const route of doc.routes) {
        routeIndex.set(`${route.providerId} ${route.modelId}`, { doc, route });
        for (const wireName of route.overrides?.supportedParameters ?? []) {
          if (!(wireName in WIRE_PARAM_TO_CANONICAL) && !NON_PARAM_WIRE_NAMES.has(wireName)) {
            diags.push({
              level: "warning",
              family: doc.family,
              providerId: route.providerId,
              message: `unmapped supportedParameters entry "${wireName}"`
            });
          }
        }
      }
    }
    return new Registry(docs, routeIndex, diags);
  }

  listFamilies(): CapabilityDoc[] {
    return this.docs.map((d) => structuredClone(d));
  }

  listModels(): ModelRef[] {
    return this.docs.flatMap((doc) =>
      doc.routes.map((route) => ({
        providerId: route.providerId,
        modelId: route.modelId,
        family: doc.family,
        displayName: doc.displayName,
        company: doc.company,
        wire: route.wire
      }))
    );
  }

  diagnostics(): RegistryDiagnostic[] {
    return [...this.diags];
  }

  resolve(providerId: string, modelId: string): ResolvedModel | undefined {
    const entry = this.routeIndex.get(`${providerId} ${modelId}`);
    if (!entry) return undefined;
    const { doc, route } = entry;
    const o = route.overrides ?? {};
    const provider = getProvider(providerId);
    const baseUrl = o.baseUrl ?? provider?.baseUrl;
    if (!baseUrl) return undefined;

    let params: Record<string, ParamDescriptor> = structuredClone(doc.params);
    if (o.supportedParameters) {
      const canonical = new Set(
        o.supportedParameters
          .map((w) => WIRE_PARAM_TO_CANONICAL[w])
          .filter((c): c is string => c !== undefined)
      );
      const reasoningAllowed =
        o.supportedParameters.includes("reasoning") || o.supportedParameters.includes("include_reasoning");
      params = Object.fromEntries(
        Object.entries(params).filter(
          ([name]) =>
            canonical.has(name) ||
            (reasoningAllowed && name.startsWith("reasoning.")) ||
            (name.includes(".") && !name.startsWith("reasoning."))
        )
      );
    }

    return {
      providerId,
      modelId,
      wire: route.wire,
      family: doc.family,
      displayName: doc.displayName,
      company: doc.company,
      baseUrl,
      endpoint: o.endpoint ?? WIRE_DEFAULT_ENDPOINT[route.wire],
      limits: {
        contextTokens: o.contextTokens ?? doc.limits.contextTokens,
        maxOutputTokens: o.maxOutputTokens ?? doc.limits.maxOutputTokens
      },
      modalities: o.modalities ? { input: [...o.modalities], output: doc.modalities.output } : structuredClone(doc.modalities),
      features: structuredClone(doc.features),
      params,
      constraints: structuredClone(doc.constraints ?? []),
      meta: {
        ...structuredClone(doc.meta),
        ...(o.pricing ? { pricing: o.pricing } : {}),
        ...(o.status ? { routeStatus: o.status } : {}),
        ...(o.note ? { routeNote: o.note } : {})
      }
    };
  }
}
