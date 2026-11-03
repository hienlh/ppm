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
