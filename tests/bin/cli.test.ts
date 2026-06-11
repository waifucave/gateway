import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/bin/cli.js";
import type { RunningServer } from "../../src/server/node.js";

function io(overrides: Partial<CliIo> = {}): CliIo & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { env: {}, log: (line) => logs.push(line), logError: (line) => errors.push(line), logs, errors, ...overrides };
}

describe("runCli", () => {
  it("prints usage and exits 2 with no command, 0 with --help", async () => {
    const noCommand = io();
    expect(await runCli([], noCommand)).toBe(2);
    expect(noCommand.errors.join("\n")).toContain("usage: gateway");
    const help = io();
    expect(await runCli(["--help"], help)).toBe(0);
    expect(help.logs.join("\n")).toContain("usage: gateway");
  });

  it("rejects unknown commands and bad flags with exit 2", async () => {
    const unknown = io();
    expect(await runCli(["frobnicate"], unknown)).toBe(2);
    expect(unknown.errors.join("\n")).toContain('unknown command "frobnicate"');
    expect(await runCli(["serve", "--port", "not-a-number"], io())).toBe(2);
    expect(await runCli(["serve", "--bogus"], io())).toBe(2);
  });

  it("serve starts a real server with env credentials and reports the url", async () => {
    let captured: RunningServer | undefined;
    const testIo = io({ env: { DEEPSEEK_API_KEY: "sk-env" }, onServer: (server) => (captured = server) });
    expect(await runCli(["serve", "--port", "0"], testIo)).toBe(0);
    expect(captured).toBeDefined();
    expect(testIo.logs.join("\n")).toContain(`gateway listening on ${captured!.url}`);
    const body = (await (await fetch(`${captured!.url}/v1/providers`)).json()) as {
      providers: Array<{ id: string; credentialConfigured: boolean }>;
    };
    expect(body.providers.find((p) => p.id === "deepseek")?.credentialConfigured).toBe(true);
    await captured!.close();
  });

  it("serve returns 1 when the port is unusable", async () => {
    const testIo = io();
    expect(await runCli(["serve", "--port", "0", "--host", "203.0.113.1"], testIo)).toBe(1);
    expect(testIo.errors.join("\n")).toContain("failed to start");
  });
});

const syncDataDir = join(import.meta.dirname, "../fixtures/sync");

function syncFetch(openrouterData: unknown) {
  return (async (input: string | URL | Request) =>
    String(input).includes("openrouter.ai")
      ? new Response(JSON.stringify(openrouterData), { status: 200 })
      : new Response("{}", { status: 500 })) as typeof fetch;
}

describe("runCli sync", () => {
  const CLEAN = {
    data: [{ id: "drift/drift-model", context_length: 100000, pricing: { prompt: "0.0000005", completion: "0.0000015" } }]
  };

  it("exits 0 and prints a clean report when nothing drifted", async () => {
    const testIo = io({ fetchImpl: syncFetch(CLEAN) });
    expect(await runCli(["sync", "--data-dir", syncDataDir, "--provider", "openrouter"], testIo)).toBe(0);
    expect(testIo.logs.join("\n")).toContain("drift check clean");
  });

  it("exits 1 and prints findings when the registry drifted", async () => {
    const testIo = io({ fetchImpl: syncFetch({ data: [] }) });
    expect(await runCli(["sync", "--data-dir", syncDataDir, "--provider", "openrouter"], testIo)).toBe(1);
    const output = testIo.logs.join("\n");
    expect(output).toContain("ERROR openrouter:drift/drift-model");
    expect(output).toContain("drift check FAILED");
  });

  it("emits machine-readable JSON with --json", async () => {
    const testIo = io({ fetchImpl: syncFetch(CLEAN) });
    expect(await runCli(["sync", "--data-dir", syncDataDir, "--provider", "openrouter", "--json"], testIo)).toBe(0);
    const parsed = JSON.parse(testIo.logs.join("\n")) as { ok: boolean; findings: unknown[]; providersChecked: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.providersChecked).toEqual(["openrouter"]);
  });

  it("rejects unknown sync flags with exit 2", async () => {
    expect(await runCli(["sync", "--bogus"], io())).toBe(2);
  });

  it("exits 1 with a clean message when the data dir is unreadable", async () => {
    const testIo = io();
    expect(await runCli(["sync", "--data-dir", "/nonexistent/gateway-data-dir"], testIo)).toBe(1);
    expect(testIo.errors.join("\n")).toContain("sync failed:");
    expect(testIo.logs).toEqual([]);
  });
});
