import type { SyncFinding, SyncReport } from "./sync.js";

const LEVEL_TAG: Record<SyncFinding["level"], string> = { error: "ERROR", warning: "WARN ", info: "info " };

export function formatSyncReport(report: SyncReport): string {
  const lines: string[] = [];
  for (const finding of report.findings) {
    const target = finding.modelId === undefined ? finding.providerId : `${finding.providerId}:${finding.modelId}`;
    lines.push(`${LEVEL_TAG[finding.level]} ${target} — ${finding.message}`);
  }
  if (report.providersChecked.length > 0) lines.push(`checked: ${report.providersChecked.join(", ")}`);
  for (const skipped of report.providersSkipped) lines.push(`skipped: ${skipped.providerId} — ${skipped.reason}`);
  const errors = report.findings.filter((finding) => finding.level === "error").length;
  const warnings = report.findings.filter((finding) => finding.level === "warning").length;
  lines.push(report.ok ? "drift check clean" : `drift check FAILED: ${errors} error(s), ${warnings} warning(s)`);
  return lines.join("\n");
}
