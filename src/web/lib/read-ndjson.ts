/**
 * Newline-delimited JSON read off a response body as it arrives: each value is handed over as soon
 * as its line ends, so what a long run has done so far shows while the rest is still coming.
 *
 * A line can be one large result — a hundred thousand rows — arriving in hundreds of chunks, so a
 * chunk is searched for its line breaks alone: searching the whole line again for every chunk
 * would make reading it quadratic in its length.
 */
export async function readNdjson<T>(body: ReadableStream<Uint8Array>, onValue: (value: T) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  /** The start of the line the next chunk continues. */
  let pending = "";
  const take = (text: string) => {
    let from = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", from)) {
      const line = pending + text.slice(from, newline);
      pending = "";
      from = newline + 1;
      if (line.trim()) onValue(JSON.parse(line) as T);
    }
    pending += text.slice(from);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      take(decoder.decode(value, { stream: true }));
    }
    take(decoder.decode());
    if (pending.trim()) onValue(JSON.parse(pending) as T);
  } finally {
    reader.releaseLock();
  }
}
