import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { createGatewayHandler, type GatewayHandlerOptions, type GatewayHttpHandler } from "./handler.js";

export type GatewayPluginOptions = GatewayHandlerOptions;

/** Headers that don't survive the Node→Fetch Request conversion. */
const SKIP_REQUEST_HEADERS = new Set(["connection", "transfer-encoding", "content-length", "host", "expect", "keep-alive", "upgrade"]);

function toFetchHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (SKIP_REQUEST_HEADERS.has(name)) continue;
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  return headers;
}

/**
 * Mounts the gateway HTTP API on a Fastify instance (§4.6):
 *
 *   await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: lookupFn });
 *
 * fastify is an OPTIONAL peer dependency: this module only imports its types,
 * so importing `@waifucave/gateway/fastify` adds no runtime dependency.
 * Deliberately NOT wrapped in fastify-plugin — the scoped content-type parser
 * (raw string bodies; the handler parses JSON itself) must stay encapsulated.
 */
export async function gatewayPlugin(instance: FastifyInstance, options: GatewayPluginOptions): Promise<void> {
  const handler: GatewayHttpHandler = createGatewayHandler(options);
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (_request, payload, done) => {
    done(null, payload);
  });
  instance.all("/*", async (request, reply) => {
    const controller = new AbortController();
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded) controller.abort(new Error("client closed the connection"));
    });
    const path = request.url.slice(instance.prefix.length) || "/";
    const init: RequestInit = { method: request.method, headers: toFetchHeaders(request.headers), signal: controller.signal };
    if (typeof request.body === "string" && request.body !== "") init.body = request.body;
    const response = await handler.handle(new Request(`http://gateway.internal${path}`, init));
    reply.code(response.status);
    response.headers.forEach((value, name) => {
      reply.header(name, value);
    });
    if (!response.body) return reply.send("");
    return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
  });
}

export default gatewayPlugin;
