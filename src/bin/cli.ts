import { parseArgs } from "node:util";
import { envCredentials } from "../server/env.js";
import { serve, type RunningServer } from "../server/node.js";
import { runSync } from "../sync/sync.js";
import { formatSyncReport } from "../sync/report.js";

export type CliIo = {
  env?: Record<string, string | undefined>;
  log: (line: string) => void;
  logError: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Test hook: receives the running server (production leaves it running forever). */
  onServer?: (server: RunningServer) => void;
};

const USAGE = [
  "usage: gateway <command>",
  "",
  "  gateway serve [--port 8787] [--host 127.0.0.1]",
  "      start the standalone HTTP server; credentials come from env vars",
  "      (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ... — see GET /v1/providers)",
  "",
  "  gateway sync [--provider <id>]... [--json] [--data-dir <path>]",
  "      drift-check the capability registry against OpenRouter /models and",
  "      native provider model lists; exits 1 when drift is found"
].join("\n");

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    io.log(USAGE);
    return 0;
  }
  if (command === "serve") return runServe(rest, io);
  if (command === "sync") return runSyncCommand(rest, io);
  io.logError(command === undefined ? USAGE : `unknown command "${command}"\n${USAGE}`);
  return 2;
}

async function runSyncCommand(args: string[], io: CliIo): Promise<number> {
  let values: { provider?: string[]; json?: boolean; "data-dir"?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        provider: { type: "string", multiple: true },
        json: { type: "boolean" },
        "data-dir": { type: "string" }
      }
    }));
  } catch (error) {
    io.logError(`invalid arguments: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const report = await runSync({
    credentials: envCredentials(io.env ?? process.env),
    ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
    ...(values.provider !== undefined ? { providers: values.provider } : {}),
    ...(values["data-dir"] !== undefined ? { dataDir: values["data-dir"] } : {})
  });
  io.log(values.json === true ? JSON.stringify(report, null, 2) : formatSyncReport(report));
  return report.ok ? 0 : 1;
}

async function runServe(args: string[], io: CliIo): Promise<number> {
  let values: { port?: string; host?: string };
  try {
    ({ values } = parseArgs({ args, options: { port: { type: "string" }, host: { type: "string" } } }));
  } catch (error) {
    io.logError(`invalid arguments: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const port = values.port === undefined ? 8787 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    io.logError(`invalid --port "${values.port}"`);
    return 2;
  }
  try {
    const running = await serve({
      port,
      host: values.host ?? "127.0.0.1",
      credentials: envCredentials(io.env ?? process.env),
      ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {})
    });
    io.log(`gateway listening on ${running.url} (endpoints under /v1)`);
    io.onServer?.(running);
    return 0;
  } catch (error) {
    io.logError(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
