import { ProviderDef } from "./types.js";

export const PROVIDERS: ProviderDef[] = [
  { id: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", credentialEnv: "OPENROUTER_API_KEY", wire: "openai-chat" },
  { id: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com", credentialEnv: "ANTHROPIC_API_KEY", wire: "anthropic-messages" },
  { id: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", credentialEnv: "OPENAI_API_KEY", wire: "openai-responses" },
  { id: "google-ai-studio", displayName: "Google AI Studio", baseUrl: "https://generativelanguage.googleapis.com", credentialEnv: "GOOGLE_AI_STUDIO_API_KEY", wire: "google-generative-language" },
  { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", credentialEnv: "DEEPSEEK_API_KEY", wire: "openai-chat" },
  { id: "xai", displayName: "xAI", baseUrl: "https://api.x.ai/v1", credentialEnv: "XAI_API_KEY", wire: "openai-chat" },
  { id: "zai", displayName: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", credentialEnv: "ZAI_API_KEY", wire: "openai-chat" },
  { id: "moonshot", displayName: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", credentialEnv: "MOONSHOT_API_KEY", wire: "openai-chat" },
  { id: "qwen", displayName: "Qwen (DashScope Intl)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", credentialEnv: "DASHSCOPE_API_KEY", wire: "openai-chat" },
  { id: "minimax", displayName: "MiniMax", baseUrl: "https://api.minimax.io/v1", credentialEnv: "MINIMAX_API_KEY", wire: "openai-chat" },
  { id: "mistral", displayName: "Mistral", baseUrl: "https://api.mistral.ai/v1", credentialEnv: "MISTRAL_API_KEY", wire: "openai-chat" },
  { id: "nvidia", displayName: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", credentialEnv: "NVIDIA_API_KEY", wire: "openai-chat" },
  { id: "stepfun", displayName: "StepFun", baseUrl: "https://api.stepfun.ai/v1", credentialEnv: "STEPFUN_API_KEY", wire: "openai-chat" },
  { id: "xiaomi", displayName: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/v1", credentialEnv: "XIAOMI_API_KEY", wire: "openai-chat" }
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderDef | undefined {
  return byId.get(id);
}
