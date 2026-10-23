# @waifucave/gateway

Provider-agnostic LLM normalization layer: a curated capability registry for 76 model families (146 routes) across 20 companies, per-model parameter validation with declarative quirk constraints, a unified chat API over OpenRouter + 14 direct providers, an HTTP gateway server, and a drift-sync CLI.

**Status: P1c complete.** Registry, validation engine, the four wire codecs, transport, and the client are complete. HTTP server (`createGatewayHandler`, `serve`), Fastify plugin (`@waifucave/gateway/fastify`), and the `gateway serve` / `gateway sync` CLI commands are all shipped.

```ts
import { Registry, validateRequest } from "@waifucave/gateway";

const registry = Registry.load();
const model = registry.resolve("deepseek", "deepseek-v4-pro");

// DeepSeek V4 rejects forced tool choice while thinking is enabled
// (and thinking defaults ON) — the registry knows:
validateRequest(model, { params: {}, toolChoice: "required" });
// → { ok: false, violations: [{ ruleId: "thinking-no-forced-tools", ... }] }
```

- `data/` — capability docs: per-`(provider, model)` parameter descriptors, limits, modalities, feature flags, and constraint rules (`forbid` / `drop` / `force` / `clamp`), each cell source-backed.
- `src/registry/` — loader with per-route overlays (base URLs, context limits, OpenRouter `supportedParameters` filtering).
- `src/validate/` — pure constraint engine + request validator.

The published npm package ships the compiled build (`dist/`) plus `data/` — not the TypeScript source. Build from source with `npm install && npm run build`; test with `npm test`.

## Client usage

### Meta Muse Spark

The direct `meta` provider uses `https://api.meta.ai/v1` and `MODEL_API_KEY`
(or the `meta` credential entry). Models: `muse-spark-1.1`, `muse-spark-1.2`,
`muse-spark-1.3`, `muse-spark-1.2-contributor`, and `muse-spark-1.3-contributor`.
Contributor models permit Meta to train on prompts and completions; they are
explicit selections, never automatic replacements for Standard models.

Use `reasoning.effort` (`minimal`, `low`, `medium`, `high`, `xhigh`; `max` only
on Standard 1.3). Reasoning cannot be disabled and is not exposed/replayed by
the Chat Completions API. `maxOutputTokens` maps to `max_completion_tokens` and
includes hidden reasoning tokens. Tool choice supports only `auto`; use JSON
schema output for mandatory structured decisions. This adapter supports text
and image inputs, not the vendor's full audio/video/PDF surface.

Sources checked 2026-10-12: [models](https://dev.meta.ai/docs/models),
[reasoning](https://dev.meta.ai/docs/reasoning),
[tool calling](https://dev.meta.ai/docs/tool-calling), and
[Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions).
Coverage is documentation-backed and fake-transport tested, not a live-key test.

```ts
import { createGateway } from "@waifucave/gateway";

const gateway = createGateway({
  credentials: { deepseek: process.env.DEEPSEEK_API_KEY! }
});

const response = await gateway.chat({
  provider: "deepseek",
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "hi" }],
  params: { "reasoning.enabled": true }
});
console.log(response.content, response.usage, response.warnings);

for await (const event of gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] })) {
  if (event.type === "text-delta") process.stdout.write(event.text);
}
```

Validation runs before any network call: unsupported parameters throw
`GatewayError("unsupported_parameter")` naming the violated rule; constraint
`drop`/`force`/`clamp` adjustments surface as `response.warnings`.

**Content gating.** `gateway.validate(provider, model, { params, messages })`
reports image blocks sent to a model whose input modalities lack `image`
(`unsupported_modality`) and cache breakpoints on a model with
`promptCaching.kind: "none"` (`unsupported_prompt_caching`). The chat path is
lenient for the same cases: images are stripped (`content_dropped` warning; an
emptied user turn becomes `"[image omitted]"`) and cache hints are not sent
(`cache_ignored` warning) — mirroring how constraint `drop`s are warnings.

**Passthrough** keys are merged raw into the wire body (one `passthrough`
warning each). Object values deep-merge into what the codec wrote; core keys
each codec owns (`model`, `messages`/`input`/`contents`, `system`, `tools`,
`tool_choice`, `stream`, `response_format`, …) are rejected with
`invalid_request` — see `CORE_BODY_KEYS`.

**`reasoning.exclude`** hides reasoning text gateway-side (no `reasoning-delta`
events, empty `text` on reasoning blocks). Signed thinking must replay
unmodified, so the original text moves to the opaque `replay` field (never
display it) and signatures / redacted data / OpenRouter `details` stay as-is.
On OpenRouter it is also sent as `reasoning.exclude`. Pass reasoning blocks
back unchanged on tool loops.

### Usage and cost

One convention for every provider (`Usage`):

| Field | Meaning |
|-------|---------|
| `inputTokens` | the whole prompt, **including** cache reads and writes (Anthropic: `input_tokens + cache_read + cache_creation`) |
| `outputTokens` | all generated tokens, **including** reasoning (Gemini: candidates + thoughts) |
| `cacheReadTokens` / `cacheWriteTokens` / `cacheWrite1hTokens` | subsets of `inputTokens` (1h = Anthropic 1-hour TTL writes) |
| `reasoningTokens` | subset of `outputTokens` when the provider reports it |
| `costUsd` | OpenRouter's reported `usage.cost`, else computed from catalog pricing (`computeCostUsd`); absent when pricing is unknown |
| `cachedInputTokens` | deprecated alias of `cacheReadTokens` |

Pricing (`meta.pricing` / route `overrides.pricing`, USD per MTok) carries
`inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok` (cache read),
`cacheWritePerMTok` and `cacheWrite1hPerMTok`; a cache tier without a price is
costed at the input price.

### Prompt caching

```ts
await gateway.chat({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  promptCacheKey: "waifu:aria:chan-123",            // OpenAI prompt_cache_key
  messages: [
    { role: "system", content: harness, cacheControl: { type: "ephemeral", ttl: "1h" } }, // A
    { role: "user", content: epochHeader, cacheControl: { type: "ephemeral" } },         // B
    ...transcript.slice(0, -1),
    { ...transcript.at(-1)!, cacheControl: { type: "ephemeral" } },                     // C (rolling)
    { role: "user", content: ephemeralTail }
  ]
});
```

`cacheControl` on a message marks its last block; `TextBlock.cacheControl`
marks one block (system content may be `TextBlock[]`). Per wire:

| Wire / route | Effect |
|--------------|--------|
| Anthropic | `cache_control` on the marked block (never on thinking blocks); max 4 — the earliest extras are dropped with a `cache_ignored` warning; a 1h breakpoint after a 5m one is downgraded |
| OpenRouter → Anthropic / Gemini models | `cache_control` on content parts (string content becomes a one-part array) |
| OpenRouter → other models, native OpenAI-compatible providers | markers ignored (implicit caching) |
| OpenAI Responses, OpenAI models on openai-chat | `prompt_cache_key` = `promptCacheKey`; markers ignored |
| Google | no-op (implicit caching) |

`features.promptCaching.kind` (also `promptCaching` in `/v1/models`) says which
applies: `explicit` honours breakpoints, `implicit` caches automatically,
`none` ignores hints (and `validate()` flags them).

### Errors

`GatewayError` carries `kind`, `retryable`, `status`, `provider`. Kinds:
`auth`, `rate_limit`, `quota` (usage quota exhausted: `insufficient_quota`,
Gemini per-day quota), `billing` (HTTP 402, credit balance too low),
`context_overflow` (prompt exceeds the context window — compact and retry),
`invalid_request`, `unsupported_parameter`, `content_filter`, `timeout`,
`server`, `network`. Quota/billing 429s are classified from the body before the
retry decision and never retried.

**Streams** abort with a `timeout` error event when no bytes arrive for
`streamIdleTimeoutMs` (default 60 000; `0` disables). Finish reasons:
`stop`, `length` (token limit — including OpenAI `response.incomplete`),
`tool_calls`, `content_filter`, `error`.

**Abort contract:** `chat()` rejects with the raw abort reason (not a `GatewayError`) when `request.signal` fires — user aborts stay distinguishable from provider failures. `stream()` differs: mid-stream aborts arrive as a final `error` event of kind `"network"`. The HTTP layer normalizes both to a 499 response.

## HTTP API

### Standalone server

```bash
# install globally or use npx
npx gateway serve
# credentials via env vars — never persisted
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... npx gateway serve
```

Defaults to `http://127.0.0.1:8787`. Override with `GATEWAY_PORT` / `GATEWAY_HOST`.

### Programmatic usage (framework-agnostic)

```ts
import { createGatewayHandler, serve } from "@waifucave/gateway";

// Framework-agnostic: Fetch Request in, Response out
const handler = createGatewayHandler({ credentials: { openai: process.env.OPENAI_API_KEY } });
const response = await handler.handle(request);

// Standalone node:http server
const server = await serve({ port: 8787 });
// server.url, server.gateway, server.close()
```

### Fastify plugin

`gatewayPlugin` is exported only from the `@waifucave/gateway/fastify` subpath, keeping the optional peer boundary explicit — the main entry point has no fastify dependency.

```ts
import gatewayPlugin from "@waifucave/gateway/fastify";
await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: (id) => lookupKey(id) });
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/providers` | All providers with credential-configured status |
| GET | `/v1/models` | All routes with summary flags (streaming, tools, reasoning, etc.) |
| GET | `/v1/models/:provider/:model` | Full capability doc for one model; slash-bearing OpenRouter ids supported |
| POST | `/v1/chat` | Unified completion; set `stream: true` for SSE |
| POST | `/v1/validate` | Dry-run validation — returns violations and effectiveParams without a network call (optional `messages` are checked for modalities / cache support) |

### SSE framing

Streaming responses (`POST /v1/chat` with `stream: true`) use Server-Sent Events:

- Each frame: `data: <StreamEvent JSON>\n\n`
- Error events carry serialized `GatewayError` objects (kind, message, provider, retryable)
- Stream ends with `data: [DONE]\n\n`
- `timeoutMs` bounds time-to-first-headers only; long streams are not cut off, but a stream that stalls (no bytes for `streamIdleTimeoutMs`, default 60s) ends with a `timeout` error event

### Error status codes

| Status | Cause |
|--------|-------|
| 400 | `invalid_request`, `unsupported_parameter` or `context_overflow` |
| 401 | `auth` — missing or rejected credential |
| 402 | `quota` / `billing` — provider quota or credit exhausted |
| 422 | `content_filter` |
| 429 | `rate_limit` |
| 499 | client abort (both `chat()` and mid-stream `stream()`) |
| 502 | `server` or `network` — provider or transport failure |
| 504 | `timeout` |

## Drift sync

Check whether the registry is in sync with live provider model lists:

```bash
npx gateway sync                        # check all providers
npx gateway sync --provider openrouter  # one provider
npx gateway sync --json                 # machine-readable JSON output
npx gateway sync --data-dir ./data      # custom data directory
```

Exit codes: `0` = clean, `1` = drift (error or warning findings), `2` = usage error.

OpenRouter is checked credential-free (its `/models` endpoint is public). All other providers are skipped without an API key configured — the sync is always read-only and never mutates anything.
