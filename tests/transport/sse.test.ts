import { describe, expect, it } from "vitest";
import { parseSse, type SseEvent } from "../../src/transport/sse.js";

const encoder = new TextEncoder();

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

async function collect(iter: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("parseSse", () => {
  it("parses simple data events", async () => {
    expect(await collect(parseSse(chunks('data: {"a":1}\n\ndata: [DONE]\n\n')))).toEqual([
      { data: '{"a":1}' },
      { data: "[DONE]" }
    ]);
  });

  it("captures event names and joins multi-line data with newlines", async () => {
    expect(await collect(parseSse(chunks("event: message_start\ndata: line1\ndata: line2\n\n")))).toEqual([
      { event: "message_start", data: "line1\nline2" }
    ]);
  });

  it("ignores comment lines and id/retry fields", async () => {
    expect(await collect(parseSse(chunks(": keep-alive\nid: 7\nretry: 100\ndata: x\n\n")))).toEqual([{ data: "x" }]);
  });

  it("handles chunk boundaries mid-line and mid-CRLF", async () => {
    expect(await collect(parseSse(chunks("da", "ta: he", "llo\r", "\n\r\n")))).toEqual([{ data: "hello" }]);
  });

  it("handles CR, LF and CRLF line endings", async () => {
    expect(await collect(parseSse(chunks("data: a\r\rdata: b\r\n\r\ndata: c\n\n")))).toEqual([
      { data: "a" },
      { data: "b" },
      { data: "c" }
    ]);
  });

  it("flushes a trailing event missing the final blank line", async () => {
    expect(await collect(parseSse(chunks("data: tail")))).toEqual([{ data: "tail" }]);
  });

  it("strips only one leading space after the colon", async () => {
    expect(await collect(parseSse(chunks("data:  padded\n\n")))).toEqual([{ data: " padded" }]);
  });

  it("reads from a ReadableStream too", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: rs\n\n"));
        controller.close();
      }
    });
    expect(await collect(parseSse(stream))).toEqual([{ data: "rs" }]);
  });
});
