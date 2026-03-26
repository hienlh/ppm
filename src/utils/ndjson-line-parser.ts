import type { Readable } from "node:stream";

/**
 * Async generator: reads from a stream, buffers partial lines,
 * yields parsed JSON objects one per complete line.
 * Handles TCP packet splitting across JSON boundaries.
 */
export async function* parseNdjsonLines(stream: Readable): AsyncIterable<unknown> {
  let buffer = "";

  for await (const chunk of stream) {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || ""; // keep trailing partial

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Skip non-JSON lines (e.g. deprecation warnings from CLI)
        console.warn(`[ndjson] skipping non-JSON line: ${trimmed.slice(0, 100)}`);
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim());
    } catch {
      // ignore trailing non-JSON
    }
  }
}
