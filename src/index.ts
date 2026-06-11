export { Registry, type ModelRef } from "./registry/loader.js";
export { PROVIDERS, getProvider } from "./registry/providers.js";
export type {
  CapabilityDoc,
  Confidence,
  ConstraintAction,
  ConstraintCondition,
  ConstraintRule,
  Features,
  ParamDescriptor,
  ParamType,
  Pricing,
  ProviderDef,
  RegistryDiagnostic,
  ResolvedModel,
  RouteDef,
  RouteOverrides,
  ToolFeatures,
  WireProtocol
} from "./registry/types.js";
export { applyConstraints, type ConstraintResult, type ConstraintViolation, type ConstraintWarning } from "./validate/constraints.js";
export { validateRequest, type ValidateInput, type ValidationResult, type ValidationViolation } from "./validate/validateRequest.js";
export { GatewayError, extractErrorMessage, kindForStatus, type GatewayErrorKind } from "./errors.js";
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  FinishReason,
  ImageBlock,
  ReasoningBlock,
  ResponseFormat,
  StreamEvent,
  TextBlock,
  ToolCallBlock,
  ToolChoice,
  ToolDef,
  Usage,
  Warning
} from "./client/types.js";
export { Gateway, createGateway, type GatewayOptions } from "./client/gateway.js";
export { codecFor } from "./codecs/index.js";
export { openaiChatCodec } from "./codecs/openaiChat.js";
export { openaiResponsesCodec } from "./codecs/openaiResponses.js";
export { anthropicMessagesCodec } from "./codecs/anthropicMessages.js";
export { googleGenerativeLanguageCodec } from "./codecs/googleGenerativeLanguage.js";
export type { Codec, CodecRequest, EncodedRequest } from "./codecs/types.js";
export { authHeaders, buildUrl } from "./codecs/shared.js";
export { parseSse, type SseEvent } from "./transport/sse.js";
export { fetchWithRetry, type HttpOptions, type HttpRequest } from "./transport/http.js";
