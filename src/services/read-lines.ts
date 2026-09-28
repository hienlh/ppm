/**
 * Streaming line reader for the JSONL transcripts.
 *
 * Its own module because two readers need it — the full message parser and the
 * compaction scan — and having the second import it from the first would make the
 * two files a cycle.
 */

/**
 * Yield a file's lines without holding the file in memory.
 *
 * `Bun.file().text()` plus `split("\n")` costs the whole transcript twice over —
 * 277MB resident for a 77MB file, which is what forced a cap low enough to
 * reject real sessions. Peak here is one chunk plus one line.
 *
 * `fromByte` reads a tail window instead of the whole file, for the callers that
 * have to bound what they parse. See `fullParseWindow` in
 * `jsonl-transcript-parser.ts` for why a bound is a window rather than a refusal.
 */
export async function* readLines(filePath: string, fromByte = 0): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  // Explicit reader rather than `for await` over the stream: the DOM lib's
  // ReadableStream is not typed as async-iterable, and the `finally` is what
  // releases it when a caller breaks early on `beforeUuid`.
  // One byte *before* the offset, so the first line the split produces is
  // always the tail of the record the offset fell inside — the empty string
  // when it fell exactly on a newline. That makes the drop below unconditional
  // instead of a boundary case, and a boundary case here silently costs a whole
  // record rather than a fragment.
  const file = fromByte > 0 ? Bun.file(filePath).slice(fromByte - 1) : Bun.file(filePath);
  const reader = file.stream().getReader();
  // A fragment is not always unparseable — the tail of one record is sometimes
  // a complete smaller document — so it has to go by position rather than be
  // left for `JSON.parse` to reject, or it enters as an invented message.
  let dropPartial = fromByte > 0;
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (dropPartial) { dropPartial = false; continue; }
        yield line;
      }
    }
  } finally {
    reader.releaseLock();
  }
  buffered += decoder.decode();
  if (buffered && !dropPartial) yield buffered;
}
