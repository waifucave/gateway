import { Gateway, type GatewayOptions } from "../client/gateway.js";
import { PROVIDERS } from "../registry/providers.js";
import { GatewayError } from "../errors.js";
import { jsonResponse } from "./shared.js";

export type GatewayHandlerOptions = GatewayOptions;

export type ModelSummary = {
  providerId: string;
  modelId: string;
  family: string;
  displayName: string;
  company: string;
  wire: string;
  contextTokens: number;
  maxOutputTokens: number;
  streaming: boolean;
  tools: boolean;
  reasoning: boolean;
  jsonMode: boolean;
  jsonSchema: boolean;
  imageInput: boolean;
  deprecated: boolean;
  confidence: string;
  routeStatus?: string;
};

export type GatewayHttpHandler = {
  /** Framework-agnostic entry point (§4.6): plain Fetch Request in, Response out. */
  handle: (request: Request) => Promise<Response>;
  gateway: Gateway;
};

const NOT_FOUND_BODY = { error: { kind: "invalid_request", message: "not found", retryable: false } };

function methodNotAllowed(allow: string): Response {
  return new Response(
    JSON.stringify({ error: { kind: "invalid_request", message: `method not allowed; use ${allow}`, retryable: false } }),
    { status: 405, headers: { "content-type": "application/json", allow } }
  );
}

function pathSegments(url: string): string[] {
  return new URL(url).pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // undecodable segment can't match a route → 404
      }
    });
}

function buildCredentialCheck(credentials: GatewayOptions["credentials"]): (providerId: string) => boolean {
  return (providerId) => {
    const value = typeof credentials === "function" ? credentials(providerId) : credentials?.[providerId];
    return value !== undefined && value !== "";
  };
}

function buildModelSummaries(gateway: Gateway): ModelSummary[] {
  const summaries: ModelSummary[] = [];
  for (const ref of gateway.listModels()) {
    const model = gateway.getCapabilities(ref.providerId, ref.modelId);
    if (!model) continue; // unresolvable route — registry diagnostics cover it
    summaries.push({
      providerId: model.providerId,
      modelId: model.modelId,
      family: model.family,
      displayName: model.displayName,
      company: model.company,
      wire: model.wire,
      contextTokens: model.limits.contextTokens,
      maxOutputTokens: model.limits.maxOutputTokens,
      streaming: model.features.streaming,
      tools: model.features.tools.supported,
      reasoning: Object.keys(model.params).some((name) => name.startsWith("reasoning.")),
      jsonMode: model.features.structuredOutput.jsonMode ?? false,
      jsonSchema: model.features.structuredOutput.jsonSchema ?? false,
      imageInput: model.modalities.input.includes("image"),
      deprecated: model.meta.deprecated ?? false,
      confidence: model.meta.confidence,
      ...(model.meta.routeStatus !== undefined ? { routeStatus: model.meta.routeStatus } : {})
    });
  }
  return summaries;
}

export function createGatewayHandler(options: GatewayHandlerOptions = {}): GatewayHttpHandler {
  const gateway = new Gateway(options);
  const credentialConfigured = buildCredentialCheck(options.credentials);
  const modelSummaries = buildModelSummaries(gateway);

  function handleProviders(): Response {
    return jsonResponse(200, {
      providers: PROVIDERS.map((provider) => ({ ...provider, credentialConfigured: credentialConfigured(provider.id) }))
    });
  }

  function handleModelDetail(provider: string, model: string): Response {
    const resolved = gateway.getCapabilities(provider, model);
    if (!resolved) {
      return jsonResponse(404, { error: { kind: "invalid_request", message: `unknown model ${provider}:${model}`, retryable: false } });
    }
    return jsonResponse(200, resolved);
  }

  async function handleChat(request: Request): Promise<Response> {
    throw new GatewayError("server", `not implemented: ${request.url}`); // Task 3/4
  }

  async function handleValidate(request: Request): Promise<Response> {
    throw new GatewayError("server", `not implemented: ${request.url}`); // Task 3
  }

  async function handle(request: Request): Promise<Response> {
    const segments = pathSegments(request.url);
    if (segments[0] !== "v1") return jsonResponse(404, NOT_FOUND_BODY);
    const route = segments[1];

    if (route === "providers" && segments.length === 2) {
      return request.method === "GET" ? handleProviders() : methodNotAllowed("GET");
    }
    if (route === "models" && segments.length === 2) {
      return request.method === "GET" ? jsonResponse(200, { models: modelSummaries }) : methodNotAllowed("GET");
    }
    if (route === "models" && segments.length >= 4) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return handleModelDetail(segments[2]!, segments.slice(3).join("/"));
    }
    if (route === "chat" && segments.length === 2) {
      return request.method === "POST" ? handleChat(request) : methodNotAllowed("POST");
    }
    if (route === "validate" && segments.length === 2) {
      return request.method === "POST" ? handleValidate(request) : methodNotAllowed("POST");
    }
    return jsonResponse(404, NOT_FOUND_BODY);
  }

  return { handle, gateway };
}
