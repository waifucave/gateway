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
