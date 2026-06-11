import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PSEUDO_PARAMS = ["toolChoice", "responseFormat"];
const dataDir = join(import.meta.dirname, "../../data");

describe("constraint rules vs injected pseudo-params", () => {
  it("no rule force/drop/clamps toolChoice or responseFormat (shadow-restore would discard it)", () => {
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith(".json"))) {
      for (const doc of JSON.parse(readFileSync(join(dataDir, file), "utf8"))) {
        for (const rule of doc.constraints ?? []) {
          const touched = [
            ...Object.keys(rule.then.force ?? {}),
            ...(rule.then.drop ?? []),
            ...Object.keys(rule.then.clamp ?? {})
          ].filter((p) => PSEUDO_PARAMS.includes(p));
          expect(
            touched,
            `${file}/${doc.family} rule "${rule.id}" force/drop/clamps ${touched.join(", ")} — ` +
              `validateRequest's shadow-restore discards this; extend the pseudo-param handling in validateRequest.ts before shipping this rule`
          ).toEqual([]);
        }
      }
    }
  });
});
