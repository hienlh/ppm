/**
 * Streaming line reader for the JSONL transcripts.
 *
 * Its own module because two readers need it — the full message parser and the
 * compaction scan — and having the second import it from the first would make the
 * two files a cycle.
 */
import { readFileChunks } from "./file-chunks.ts";

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
 *
 * `toByte` ends the read there, exclusive. It is meant to be a line start (the
 * record that begins there is not read) or omitted for the end of the file —
 * `compactSegmentWindow` in `compact-segment.ts` is what computes one.
 *
 * The bytes come from `readFileChunks`, not `Bun.file().stream()`: that stream
 * keeps about the file's size in native memory per full read and never returns
 * it (see `file-chunks.ts`), and its sliced form never finishes when it has to
 * stop well short of EOF (Bun 1.3.11: on a 4MB file `slice(0, 259).stream()`
 * hung).
 */
export async function* readLines(filePath: string, fromByte = 0, toByte?: number): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  // One byte *before* the offset, so the first line the split produces is
  // always the tail of the record the offset fell inside — the empty string
  // when it fell exactly on a newline. That makes the drop below unconditional
  // instead of a boundary case, and a boundary case here silently costs a whole
  // record rather than a fragment.
  // A fragment is not always unparseable — the tail of one record is sometimes
  // a complete smaller document — so it has to go by position rather than be
  // left for `JSON.parse` to reject, or it enters as an invented message.
  let dropPartial = fromByte > 0;
  let buffered = "";
  // A caller that stops early (`beforeUuid`) ends this loop, which closes the file.
  for await (const chunk of readFileChunks(filePath, { fromByte: Math.max(0, fromByte - 1), toByte })) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (dropPartial) { dropPartial = false; continue; }
      yield line;
    }
  }
  buffered += decoder.decode();
  if (buffered && !dropPartial) yield buffered;
}
