import { vi } from "vitest";

/** fetch fake returning one JSON payload. */
export function jsonFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
}

/** fetch fake returning an SSE body (joined with \n). */
export function sseFetch(lines: string[], status = 200) {
  return vi.fn(async () => new Response(lines.join("\n"), { status, headers: { "content-type": "text/event-stream" } }));
}

/** Split an SSE body into parsed JSON frames; the [DONE] sentinel stays a string. */
export function parseSseFrames(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => frame.replace(/^data: /, ""))
    .map((data) => (data === "[DONE]" ? "[DONE]" : (JSON.parse(data) as unknown)));
}
