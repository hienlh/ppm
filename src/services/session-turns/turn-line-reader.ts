/**
 * A transcript read line by line with each line's byte range, for the turn index.
 *
 * The index remembers where every turn starts so a later read can parse just that turn, and it
 * resumes an appended transcript where it stopped — both need exact byte offsets, which
 * `read-lines.ts` (strings only) does not give. Bytes come from `readFileChunks`, never
 * `Bun.file().stream()` (see `file-chunks.ts`); stopping early closes the file.
 *
 * Only newline-terminated lines are yielded. The last line of a transcript being written is
 * usually incomplete, and indexing half a record would pin the next scan's start inside it.
 */
import { readFileChunks } from "../file-chunks.ts";

export interface TranscriptLine {
  text: string;
  /** Offset of the line's first byte. */
  start: number;
  /** Offset just past its newline: where the next line starts. */
  end: number;
}

const NEWLINE = 0x0a;

/**
 * Lines from `fromByte` (a line start) up to `toByte` (exclusive, a line start or the end).
 * A line still being written when the read reaches it is left out.
 */
export async function* readTranscriptLines(filePath: string, fromByte = 0, toByte?: number): AsyncGenerator<TranscriptLine> {
  let parts: Uint8Array[] = [];
  let partStart = fromByte;
  let position = fromByte;
  for await (const chunk of readFileChunks(filePath, { fromByte, toByte })) {
    let from = 0;
    for (let i = chunk.indexOf(NEWLINE); i !== -1; i = chunk.indexOf(NEWLINE, from)) {
      const piece = chunk.subarray(from, i);
      const bytes = parts.length ? Buffer.concat([...parts, piece]) : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
      const end = position + i + 1;
      yield { text: bytes.toString("utf8"), start: partStart, end };
      parts = [];
      partStart = end;
      from = i + 1;
    }
    if (from < chunk.length) parts.push(chunk.subarray(from));
    position += chunk.length;
  }
}

/**
 * A copy of `s` that shares no storage with the string it was cut from.
 *
 * Everything a scan keeps comes out of a transcript line: a uuid sliced off its tail, a value
 * `JSON.parse` returned, a prompt's first line. In Bun (JSC) each of those can be a view into the
 * line — or into the whole read chunk the line was decoded from — so keeping a 36-character uuid
 * kept tens of kilobytes alive, and the cache's byte budget counted a fraction of what it held
 * (measured: 21 MB resident for an estimate of 40 KB). A round trip through a Buffer allocates the
 * characters afresh; latin1 keeps the usual all-ASCII value at one byte a character.
 */
export function detachedCopy(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return Buffer.from(s, "utf16le").toString("utf16le");
  }
  return Buffer.from(s, "latin1").toString("latin1");
}

/**
 * Hands the event loop back between slices of a long walk: every 256 lines, or sooner when a
 * slice has run 8 ms (one multi-megabyte record can cost that alone). `setTimeout(0)` rather
 * than `setImmediate`, which starved HTTP when the file index walk used it.
 */
export class SliceClock {
  private lines = 0;
  private sliceStart = performance.now();

  async tick(): Promise<void> {
    if (++this.lines % 256 !== 0 && performance.now() - this.sliceStart < 8) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.sliceStart = performance.now();
  }
}
