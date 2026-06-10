import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, getProvider } from "../../src/registry/providers.js";

describe("provider table", () => {
  it("contains the 14 v1 providers with unique ids", () => {
    expect(PROVIDERS).toHaveLength(14);
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(14);
    expect(getProvider("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(getProvider("xiaomi")?.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(getProvider("nope")).toBeUndefined();
  });

  it("every route providerId in the data exists in the table", () => {
    const dataDir = join(import.meta.dirname, "../../data");
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith(".json"))) {
      for (const doc of JSON.parse(readFileSync(join(dataDir, file), "utf8"))) {
        for (const route of doc.routes) {
          expect(getProvider(route.providerId), `${file}/${doc.family}: unknown provider ${route.providerId}`).toBeDefined();
        }
      }
    }
  });
});
