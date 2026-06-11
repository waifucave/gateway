import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Gateway } from "../client/gateway.js";
import { createGatewayHandler, type GatewayHandlerOptions } from "./handler.js";

export type ServeOptions = GatewayHandlerOptions & {
  /** Default 8787. Pass 0 for an ephemeral port (tests). */
  port?: number;
  /** Default 127.0.0.1 — the standalone server is local tooling, not a public face. */
  host?: string;
};

export type RunningServer = {
  url: string;
  server: Server;
  gateway: Gateway;
  close: () => Promise<void>;
};

const SKIP_REQUEST_HEADERS = new Set(["connection", "transfer-encoding", "content-length", "host", "expect", "keep-alive", "upgrade"]);

function toFetchHeaders(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (SKIP_REQUEST_HEADERS.has(name)) continue;
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  return headers;
}

async function readBody(message: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Standalone `gateway serve` server (§4.6): node:http ↔ the framework-agnostic handler. */
export async function serve(options: ServeOptions = {}): Promise<RunningServer> {
  const { port = 8787, host = "127.0.0.1", ...handlerOptions } = options;
  const handler = createGatewayHandler(handlerOptions);

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort(new Error("client closed the connection"));
    });
    try {
      const method = request.method ?? "GET";
      const init: RequestInit = { method, headers: toFetchHeaders(request), signal: controller.signal };
      if (method !== "GET" && method !== "HEAD") init.body = await readBody(request);
      const result = await handler.handle(new Request(`http://${request.headers.host ?? "gateway.internal"}${request.url ?? "/"}`, init));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]), response);
      else response.end();
    } catch (error) {
      if (controller.signal.aborted) return; // client went away mid-stream — nothing left to tell it
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { kind: "server", message: `unexpected error: ${String(error)}`, retryable: false } }));
    }
  }

  const server = createServer((request, response) => {
    void dispatch(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    server,
    gateway: handler.gateway,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}
