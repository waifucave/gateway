import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityDocSchema } from "../helpers/capabilityDocSchema.js";

const dataDir = join(import.meta.dirname, "../../data");
const files = readdirSync(dataDir).filter((f) => f.endsWith(".json"));

describe("capability data files", () => {
  it("has 15 company files", () => {
    expect(files).toHaveLength(15);
  });

  it("every doc validates against the schema", () => {
    for (const file of files) {
      const docs = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
      expect(Array.isArray(docs), `${file} must be an array`).toBe(true);
      for (const doc of docs) {
        const result = CapabilityDocSchema.safeParse(doc);
        expect(
          result.success,
          `${file}/${doc.family}: ${result.success ? "" : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        ).toBe(true);
      }
    }
  });

  it("has 54 docs with unique families and unique (provider, model) routes", () => {
    const families = new Set<string>();
    const routes = new Set<string>();
    let count = 0;
    for (const file of files) {
      for (const doc of JSON.parse(readFileSync(join(dataDir, file), "utf8"))) {
        count++;
        expect(families.has(doc.family), `duplicate family ${doc.family}`).toBe(false);
        families.add(doc.family);
        for (const route of doc.routes) {
          const key = `${route.providerId}:${route.modelId}`;
          expect(routes.has(key), `duplicate route ${key}`).toBe(false);
          routes.add(key);
        }
      }
    }
    expect(count).toBe(54);
  });
});
