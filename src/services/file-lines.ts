/**
 * Line-oriented reads of a file that may be enormous, without holding it.
 *
 * Both functions here replace a `readFileSync(path, "utf-8")` that was correct
 * when the files were small and became a stall when they were not. Measured on
 * this machine:
 *
 *   - `~/.ppm/ppm.log` at 276 MB: 264 ms to read + 92 ms to `split("\n")` =
 *     **356 ms** of blocked event loop and a 644 MB resident spike, to answer
 *     with the last 30 lines. The route doing it (`/api/logs/recent`) is
 *     registered *before* `authMiddleware`.
 *   - A 35 MB transcript: 34 ms to read as a string + 18 ms to walk it with
 *     `charCodeAt`, to arrive at a line count.
 *
 * Neither cost was bounded: both grow with the file, and both were paid on the
 * one thread that also serves every other request.
 */

/** How much of the end of a file is read to find the last few lines. */
export const DEFAULT_TAIL_BYTES = 64 * 1024;

/**
 * The last `count` lines out of a slice taken from the end of a file.
 *
 * `startedMidFile` is what makes this safe to call on a slice: the first line
 * of one is the tail of a line whose beginning was never read, so a report
 * would open mid-sentence. It is dropped. That also absorbs the other hazard
 * of slicing at an arbitrary byte — a cut through a multi-byte character
 * decodes to U+FFFD, and the replacement character is inside the line being
 * discarded.
 */
export function lastLinesFromTail(tail: string, count: number, startedMidFile: boolean): string {
  const lines = tail.split("\n");
  if (startedMidFile && lines.length > 0) lines.shift();
  // A file that ends in a newline splits to a trailing empty string, and it
  // counts against `count` like any other element — asking for the last 1 line
  // of a well-formed log returned that empty string and nothing else. The
  // previous `readFileSync` spelling had the same flaw and got away with it
  // only because it always asked for 30 and then trimmed, quietly answering
  // with 29.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-count).join("\n").trim();
}

/** The last `count` lines of a file, at a cost that does not grow with it. */
export async function tailLines(
  filePath: string,
  count: number,
  tailBytes: number = DEFAULT_TAIL_BYTES,
): Promise<string> {
  const file = Bun.file(filePath);
  const size = file.size;
  if (size <= 0) return "";
  const start = Math.max(0, size - tailBytes);
  const tail = await file.slice(start).text();
  return lastLinesFromTail(tail, count, start > 0);
}

/** Bytes counted between two yields back to the event loop. */
export const YIELD_EVERY_BYTES = 2 * 1024 * 1024;

/**
 * How many lines a file has, read as a stream of bytes.
 *
 * Counting `0x0A` over raw bytes rather than characters is not an
 * approximation: UTF-8 gives every byte of a multi-byte sequence the high bit,
 * so no byte of any non-ASCII character can collide with a newline. It also
 * builds no string at all, so nothing the size of the file is held.
 *
 * This is **not faster** than the `readFileSync` walk it replaces — both are
 * 53 ms on a 35 MB transcript. What changes is that the event loop gets the
 * thread back during it, and that is the entire point.
 *
 * The explicit yield is the part that is easy to get wrong, and was. Awaiting
 * the stream is *not* enough: its chunks resolve as **microtasks**, and a
 * microtask queue drains without ever letting a timer or a socket run, so a
 * `for await` over an already-buffered file blocks exactly as hard as the
 * synchronous version. Measured with a 5 ms interval running alongside, over
 * the same file:
 *
 *     readFileSync + charCodeAt   53 ms wall,  0 timer fires
 *     stream, no explicit yield   37 ms wall,  0 timer fires
 *     stream + setTimeout yield   53 ms wall,  9 timer fires, worst gap 11.8 ms
 *
 * (control: an equivalent `Bun.sleep` allows 12.) Only a macrotask hands the
 * thread back, hence the `setTimeout`.
 */
export async function countLines(filePath: string): Promise<number> {
  let count = 0;
  let lastByte = -1;
  let sinceYield = 0;
  // `getReader()` rather than `for await`: Bun's ReadableStream is async
  // iterable at runtime, but the DOM typings it is declared against do not say
  // so, and a cast to paper over that would outlive the reason for it.
  const reader = Bun.file(filePath).stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      for (let i = 0; i < value.length; i++) if (value[i] === 0x0a) count++;
      if (value.length > 0) lastByte = value[value.length - 1]!;
      sinceYield += value.length;
      if (sinceYield >= YIELD_EVERY_BYTES) {
        sinceYield = 0;
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (lastByte === -1) return 0;              // empty file
  if (lastByte !== 0x0a) count++;             // last line carries no newline
  return count;
}
