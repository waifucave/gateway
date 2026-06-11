# @waifucave/gateway

Provider-agnostic LLM normalization layer: a curated capability registry for 54 model families (100 routes) across 15 companies, per-model parameter validation with declarative quirk constraints, and a unified chat API over OpenRouter + 13 direct providers.

**Status: pre-release.** Registry, validation engine, the four wire codecs, transport, and the client are complete; the HTTP server and drift sync are in development.

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
