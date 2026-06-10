# Findings

Verified at: 2026-06-10

This file lists unverified cells, source conflicts, unconfirmed model/slug existence, and unconfirmed first-party endpoint availability from the capability-doc research pass.

## conflicting

- **Anthropic - Claude Fable 5 / Claude Mythos 5 - alias**: Official Anthropic docs identify Fable 5 and Mythos 5 as separate models, not aliases; Fable 5 is generally available while Mythos 5 is limited availability.
  Sources: https://platform.claude.com/docs/en/about-claude/models/overview
- **Arcee AI - Trinity Large - native model id**: Models overview/pricing identify trinity-large-preview, while a quickstart still emphasizes trinity-mini as current production. Used trinity-large-preview and marked confidence conflicting.
  Sources: https://docs.arcee.ai/get-started/models-overview, https://docs.arcee.ai/api-reference/chat-completion
- **Mistral AI - Mistral Small 4 - modelId/pricing**: Official model-selection/changelog identify mistral-small-2603, while model-card rendering includes mistral-small-2603+1. Pricing also conflicts between model card/selection guide and public pricing page.
  Sources: https://docs.mistral.ai/models/model-selection-guide, https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03, https://mistral.ai/pricing/
- **Moonshot AI - Kimi K2.5/K2.6 - maxOutputTokens default**: Generic Chat API default text conflicts with model-specific guidance that uses 32768. JSON uses model-specific guidance where a default is recorded.
  Sources: https://platform.kimi.ai/docs/api/chat, https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart
- **OpenAI - GPT-OSS 20B / GPT-OSS 120B - OpenAI API availability**: OpenAI Help Center says gpt-oss models are not served through the OpenAI API, while model detail pages were inconsistent. JSON records OpenRouter routes only for gpt-oss.
  Sources: https://help.openai.com/en/articles/11870455-openai-open-weight-models-gpt-oss, https://platform.openai.com/docs/api-reference/responses/create, https://developers.openai.com/api/docs/models/gpt-oss-20b, https://developers.openai.com/api/docs/models/gpt-oss-120b
- **StepFun - Step 3.5 Flash / Step 3.7 Flash - international API base**: Global docs use platform.stepfun.ai/api.stepfun.ai, while api.stepfun.com is the China route. JSON uses api.stepfun.ai as international native route and notes China alternate.
  Sources: https://platform.stepfun.ai/docs/en/api-reference/chat/chat-completion-create, https://platform.stepfun.ai/docs/en/guides/developer/openai
- **xAI - Grok 4.20 non-reasoning - features.reasoning**: The exact native slug/page title identifies a non-reasoning variant, but the same page's capability block still lists Reasoning.
  Sources: https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning
- **Xiaomi - MiMo V2 Pro - native endpoint**: Xiaomi lists mimo-v2-pro, but docs say it auto-routes to V2.5 from June 1, 2026 and deprecates by June 30, 2026.
  Sources: https://platform.xiaomimimo.com/docs/en-US/quick-start/model

## unverified

- **Anthropic - Claude Sonnet 4.5 - limits.maxOutputTokens**: Native model id was confirmed, but synchronous max output was not found in the checked first-party English table.
  Sources: https://platform.claude.com/docs/en/about-claude/models/overview, https://platform.claude.com/docs/en/api/messages/create
- **Anthropic - Claude Fable 5 - features.structuredOutput**: Structured Outputs page did not list Fable 5 in the checked supported-model set.
  Sources: https://platform.claude.com/docs/en/build-with-claude/structured-outputs, https://platform.claude.com/docs/en/about-claude/models/overview
- **Google - Gemini 2.0 Flash - OpenRouter route**: OpenRouter /api/v1/models did not include a matching Gemini 2.0 Flash row.
  Sources: https://openrouter.ai/api/v1/models
- **Google - Gemini 3 Flash - non-preview route**: Native and OpenRouter sources confirmed gemini-3-flash-preview, not an exact non-preview Gemini 3 Flash id.
  Sources: https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview, https://openrouter.ai/api/v1/models
- **Google - Gemma 4 26B A4B IT - maxOutputTokens/tools/structuredOutput/promptCaching**: Gemma-on-Gemini docs confirm availability and 256K context, but checked sources did not expose output-token cap or exact Gemini API tool/structured-output/caching support cells.
  Sources: https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
- **Google - Gemma 4 31B IT - maxOutputTokens/tools/structuredOutput/promptCaching**: Gemma-on-Gemini docs confirm availability and 256K context, but checked sources did not expose output-token cap or exact Gemini API tool/structured-output/caching support cells.
  Sources: https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
- **MiniMax - M2.7 - reasoning disable behavior**: MiniMax docs report M2.x thinking cannot be disabled; exact rejected-vs-ignored behavior for disabling was not fully verified.
  Sources: https://platform.minimax.io/docs/api-reference/text-openai-api
- **Mistral AI - Mistral Small 3.2 24B - current native availability**: Changelog confirms earlier API availability but model card marks deprecated April 30, 2026; authenticated /v1/models was not available to confirm post-deprecation serving.
  Sources: https://docs.mistral.ai/models/model-cards/mistral-small-3-2-25-06, https://docs.mistral.ai/api/endpoint/models
- **Moonshot AI - Kimi K2.5 - reasoning.keep/tool_choice required/named/logprobs/seed/top_k/min_p/top_a/repetition_penalty/parallel disable/strict subset/audio/pdf/TTL**: Checked first-party Moonshot docs did not confirm these native-route cells.
  Sources: https://platform.kimi.ai/docs/api/chat, https://platform.kimi.ai/docs/api/tool-use
- **Moonshot AI - Kimi K2.6 - tool_choice required/named/logprobs/seed/top_k/min_p/top_a/repetition_penalty/parallel disable/strict subset/audio/pdf/TTL**: Checked first-party Moonshot docs did not confirm these native-route cells.
  Sources: https://platform.kimi.ai/docs/api/chat, https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart
- **NVIDIA - Nemotron 3 Super - OpenRouter maxOutputTokens**: Native NIM docs confirm max_tokens range; OpenRouter did not publish max output for this route.
  Sources: https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer, https://openrouter.ai/api/v1/models
- **OpenAI - GPT-5 Nano - OpenRouter maxOutputTokens**: OpenRouter route was confirmed but did not publish max output tokens.
  Sources: https://openrouter.ai/api/v1/models
- **OpenRouter - Owl Alpha - owner/stability**: OpenRouter API identifies owner/slug/status, but alpha-model churn and external owner details beyond OpenRouter were not independently confirmed.
  Sources: https://openrouter.ai/api/v1/models, https://openrouter.ai/api/v1/models/openrouter/owl-alpha/endpoints
- **Qwen - Qwen3.7 Max - native openai-chat route**: Existence was supported by official Qwen/Model Studio sources, but compatible-mode /chat/completions listing was not confirmed.
  Sources: https://www.alibabacloud.com/help/en/model-studio/text-generation-model, https://openrouter.ai/api/v1/models
- **StepFun - Step 3.5 Flash - reasoning.effort base enum**: Base model docs did not explicitly enumerate reasoning efforts; variant docs mention low/high.
  Sources: https://platform.stepfun.ai/docs/en/guides/models/step-3.5-flash
- **xAI - Grok 4.20 / Grok 4.3 - maxOutputTokens/tool_choice enum**: Official xAI docs confirmed context and tool_choice field, but not per-request max output cap or exact tool_choice enum for these model ids.
  Sources: https://docs.x.ai/developers/models/grok-4.20, https://docs.x.ai/developers/models/grok-4.3, https://docs.x.ai/developers/model-capabilities/legacy/chat-completions
- **xAI - Grok 4.20 - variant set**: Reasoning and non-reasoning slugs were confirmed; a separate multi-agent model also exists but was excluded as distinct beta Responses-only behavior.
  Sources: https://docs.x.ai/developers/models/grok-4.20, https://docs.x.ai/developers/model-capabilities/text/multi-agent
- **Z.AI - GLM 5 - maxOutputTokens**: First-party quickstart/release/pricing confirmed model and route, but checked sources did not expose a max output token cap for GLM 5.
  Sources: https://docs.z.ai/guides/llm/glm-5, https://docs.z.ai/api-reference/llm/chat-completion
- **Z.AI - all requested GLM models - tool_choice enum/parallel tool calls/strict schema/logprobs ranges**: First-party sources confirmed general chat route and model availability, but did not verify these detailed capability cells per exact model.
  Sources: https://docs.z.ai/api-reference/llm/chat-completion, https://docs.z.ai/guides/develop/openai/python

## not_found

- **DeepSeek - DeepSeek V3.2 - native route**: Current first-party DeepSeek model listing did not confirm a V3.2 native id; OpenRouter slug deepseek/deepseek-v3.2 is confirmed.
  Sources: https://api-docs.deepseek.com/api/list-models, https://openrouter.ai/api/v1/models
- **Google - Gemini 3.1 Pro - stable native modelId**: Only gemini-3.1-pro-preview and custom-tools preview variants were confirmed; stable gemini-3.1-pro was not confirmed.
  Sources: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview, https://ai.google.dev/gemini-api/docs/deprecations
- **Mistral AI - Mistral Small 3.2 24B - pricing/maxOutputTokens/knowledgeCutoff**: No current first-party pricing, output-token cap, or knowledge cutoff was found for exact modelId mistral-small-2506.
  Sources: https://docs.mistral.ai/models/model-cards/mistral-small-3-2-25-06, https://docs.mistral.ai/api/endpoint/chat
- **Mistral AI - Mistral Small 4 - maxOutputTokens/knowledgeCutoff**: Official chat docs define max_tokens but did not publish a per-model output cap or knowledge cutoff.
  Sources: https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03, https://docs.mistral.ai/api/endpoint/chat
- **Qwen - Qwen3.6 Max - exact non-preview native/OpenRouter id**: Official and OpenRouter sources confirmed qwen3.6-max-preview, not exact qwen3.6-max.
  Sources: https://www.alibabacloud.com/help/en/model-studio/text-generation-model, https://openrouter.ai/api/v1/models
- **Qwen - Qwen3.7 Plus - native model id**: No official DashScope/Qwen source found for native Qwen3.7 Plus, though OpenRouter lists qwen/qwen3.7-plus.
  Sources: https://www.alibabacloud.com/help/en/model-studio/text-generation-model, https://openrouter.ai/api/v1/models
- **Xiaomi - MiMo V2 Pro - OpenRouter slug/open weights**: OpenRouter did not list exact MiMo V2 Pro, and first-party V2 Pro weights were not found; V2.5 series weights were confirmed instead.
  Sources: https://platform.xiaomimimo.com/docs/en-US/news/v2.5-open-sourced, https://openrouter.ai/api/v1/models
