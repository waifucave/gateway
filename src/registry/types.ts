export type WireProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-language";

export type ParamType = "number" | "int" | "boolean" | "enum" | "string" | "string[]" | "map";

export type Confidence = "verified" | "partial" | "unverified" | "conflicting";

export type ParamDescriptor = {
  type: ParamType;
  min?: number;
  max?: number;
  step?: number;
  values?: string[];
  maxItems?: number;
  default?: unknown;
  wireName?: string;
  confidence?: Extract<Confidence, "verified" | "unverified">;
};

export type ConstraintCondition = {
  param?: string;
  eq?: unknown;
  neq?: unknown;
  gt?: number;
  lt?: number;
  in?: unknown[];
  allOf?: ConstraintCondition[];
  anyOf?: ConstraintCondition[];
};

export type ConstraintAction = {
  forbid?: string[]; // "paramName" or "paramName:value"
  drop?: string[];
  force?: Record<string, unknown>;
  clamp?: Record<string, { min?: number; max?: number }>;
};

export type ConstraintRule = {
  id: string;
  when: ConstraintCondition;
  then: ConstraintAction;
  source?: string;
};

export type Pricing = {
  inputPerMTok?: number | null;
  outputPerMTok?: number | null;
  cachedInputPerMTok?: number | null;
};

export type RouteOverrides = {
  baseUrl?: string;
  endpoint?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  pricing?: Pricing;
  modalities?: string[];
  supportedParameters?: string[];
  status?: string;
  source?: string;
  note?: string;
  mode?: string;
  aliases?: string[];
  alternateChinaBaseUrl?: string;
  anthropicEndpoint?: string;
};

export type RouteDef = {
  providerId: string;
  modelId: string;
  wire: WireProtocol;
  overrides?: RouteOverrides;
};

export type ToolFeatures = {
  supported: boolean;
  toolChoice?: Array<"auto" | "none" | "required" | "named">;
  parallel?: boolean;
  parallelDisable?: boolean;
  strict?: boolean;
};

export type Features = {
  streaming: boolean;
  streamingUsage?: boolean;
  tools: ToolFeatures;
  structuredOutput: { jsonMode?: boolean; jsonSchema?: boolean; strict?: boolean };
  promptCaching: { kind: "none" | "implicit" | "explicit" };
  assistantPrefill?: boolean;
  systemRole: "system" | "developer" | "top-level" | "systemInstruction";
  multipleSystemMessages?: boolean;
  reasoningRoundTrip?: boolean;
};

export type CapabilityDoc = {
  schema: "starlight.capability-doc.v1";
  family: string;
  displayName: string;
  company: string;
  routes: RouteDef[];
  limits: { contextTokens: number; maxOutputTokens: number };
  modalities: { input: string[]; output: string[] };
  features: Features;
  params: Record<string, ParamDescriptor>;
  constraints?: ConstraintRule[];
  meta: {
    pricing?: Pricing;
    knowledgeCutoff?: string;
    deprecated?: boolean;
    availability?: string;
    sources: string[];
    verifiedAt?: string;
    confidence: Confidence;
  };
};

export type ProviderDef = {
  id: string;
  displayName: string;
  baseUrl: string;
  credentialEnv: string;
  wire: WireProtocol;
};

/** A (providerId, modelId) route with all overlays applied. What codecs consume. */
export type ResolvedModel = {
  providerId: string;
  modelId: string;
  wire: WireProtocol;
  family: string;
  displayName: string;
  company: string;
  baseUrl: string;
  endpoint: string;
  limits: { contextTokens: number; maxOutputTokens: number };
  modalities: { input: string[]; output: string[] };
  features: Features;
  params: Record<string, ParamDescriptor>;
  constraints: ConstraintRule[];
  meta: CapabilityDoc["meta"] & { routeStatus?: string; routeNote?: string };
};

export type RegistryDiagnostic = {
  level: "warning";
  family: string;
  providerId: string;
  message: string;
};
