export type SseEvent = { event?: string; data: string };

async function* toByteIterable(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Incremental text/event-stream parser. Handles multi-line `data:` fields,
 * `event:` names, comments, and CR / LF / CRLF line endings split across chunks.
 */
export async function* parseSse(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  function* flush(): Generator<SseEvent> {
    if (dataLines.length > 0) {
      yield eventName === undefined ? { data: dataLines.join("\n") } : { event: eventName, data: dataLines.join("\n") };
    }
    eventName = undefined;
    dataLines = [];
  }

  function* handleLine(line: string): Generator<SseEvent> {
    if (line === "") {
      yield* flush();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // id and retry are irrelevant for one-shot completion streams
  }

  for await (const chunk of toByteIterable(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match) break;
      // a lone CR at the buffer's end may be half of a CRLF split across chunks
      if (match[0] === "\r" && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* handleLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") {
    for (const line of buffer.split(/\r\n|\n|\r/)) yield* handleLine(line);
  }
  yield* flush();
}
