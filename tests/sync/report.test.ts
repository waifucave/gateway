import { describe, expect, it } from "vitest";
import { formatSyncReport } from "../../src/sync/report.js";
import type { SyncReport } from "../../src/sync/sync.js";

describe("formatSyncReport", () => {
  it("formats findings, checked/skipped lists and a failure summary", () => {
    const report: SyncReport = {
      ok: false,
      findings: [
        { level: "error", providerId: "openrouter", modelId: "a/b", field: "presence", message: "openrouter:a/b is not in the provider model list (renamed, removed, or stale id)" },
        { level: "warning", providerId: "openrouter", modelId: "a/b", field: "contextTokens", registryValue: 1, remoteValue: 2, message: "openrouter:a/b contextTokens drift: registry 1, OpenRouter 2" },
        { level: "info", providerId: "openrouter", field: "registry-diagnostic", message: "fam: unmapped supportedParameters entry \"x\"" }
      ],
      providersChecked: ["openrouter"],
      providersSkipped: [{ providerId: "anthropic", reason: "no credential (ANTHROPIC_API_KEY not set)" }]
    };
    expect(formatSyncReport(report)).toBe(
      [
        "ERROR openrouter:a/b — openrouter:a/b is not in the provider model list (renamed, removed, or stale id)",
        "WARN  openrouter:a/b — openrouter:a/b contextTokens drift: registry 1, OpenRouter 2",
        "info  openrouter — fam: unmapped supportedParameters entry \"x\"",
        "checked: openrouter",
        "skipped: anthropic — no credential (ANTHROPIC_API_KEY not set)",
        "drift check FAILED: 1 error(s), 1 warning(s)"
      ].join("\n")
    );
  });

  it("reports clean runs", () => {
    const report: SyncReport = { ok: true, findings: [], providersChecked: ["openrouter"], providersSkipped: [] };
    expect(formatSyncReport(report)).toBe(["checked: openrouter", "drift check clean"].join("\n"));
  });
});
