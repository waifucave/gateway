# @waifucave/gateway

Provider-agnostic LLM normalization layer: a curated capability registry for 54 model families (100 routes) across 15 companies, per-model parameter validation with declarative quirk constraints, a unified chat API over OpenRouter + 13 direct providers, an HTTP gateway server, and a drift-sync CLI.

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
| POST | `/v1/validate` | Dry-run validation — returns violations and effectiveParams without a network call |

### SSE framing

Streaming responses (`POST /v1/chat` with `stream: true`) use Server-Sent Events:

- Each frame: `data: <StreamEvent JSON>\n\n`
- Error events carry serialized `GatewayError` objects (kind, message, provider, retryable)
- Stream ends with `data: [DONE]\n\n`
- `timeoutMs` bounds time-to-first-headers only; the body is deliberately unbounded so long streams are not cut off

### Error status codes

| Status | Cause |
|--------|-------|
| 400 | `invalid_request` or `unsupported_parameter` |
| 401 | `auth` — missing or rejected credential |
| 402 | `quota` — provider quota exceeded |
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
