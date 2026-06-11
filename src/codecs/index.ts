import type { WireProtocol } from "../registry/types.js";
import type { Codec } from "./types.js";
import { openaiChatCodec } from "./openaiChat.js";
import { openaiResponsesCodec } from "./openaiResponses.js";
import { anthropicMessagesCodec } from "./anthropicMessages.js";
import { googleGenerativeLanguageCodec } from "./googleGenerativeLanguage.js";

const CODECS: Record<WireProtocol, Codec> = {
  "openai-chat": openaiChatCodec,
  "openai-responses": openaiResponsesCodec,
  "anthropic-messages": anthropicMessagesCodec,
  "google-generative-language": googleGenerativeLanguageCodec
};

export function codecFor(wire: WireProtocol): Codec {
  return CODECS[wire];
}
