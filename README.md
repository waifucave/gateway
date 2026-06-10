# @waifucave/gateway

Provider-agnostic LLM normalization layer: a curated capability registry for 54 models across 15 companies, per-model parameter validation with declarative quirk constraints, and (upcoming) a unified chat API over OpenRouter + 13 direct providers.

**Status: pre-release.** The registry and validation engine are complete; codecs/transport/client and the HTTP server are in development.

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
