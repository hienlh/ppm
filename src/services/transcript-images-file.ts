import { closeSync, openSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import {
  auditImageLine,
  emptyImageAudit,
  stripImageLine,
  type ImageScopeOpts,
  type StripMode,
  type TranscriptImageAudit,
} from "./transcript-images.ts";

/**
 * File-level image auditing and removal that never holds a transcript in memory.
 *
 * The in-memory helpers take the whole transcript as one string, which forces callers to
 * refuse anything large — and a transcript only becomes worth cleaning once it *is* large,
 * so that cap turned the feature off exactly where it was needed. Reading a line at a time
 * removes the cap and the memory spike together: peak usage is one record, not one file.
 */

/**
 * Copy `src` over `dest`, truncating it, without allocating either file in memory.
 *
 * `openSync(dest, "w")` truncates and writes through the existing inode, so a CLI holding
 * the path open in append mode keeps writing to the file callers can still see.
 */
function copyOverInPlace(src: string, dest: string): void {
  const buf = Buffer.allocUnsafe(1 << 20);
  const from = openSync(src, "r");
  const to = openSync(dest, "w");
  try {
    for (;;) {
      const n = readSync(from, buf, 0, buf.length, null);
      if (n === 0) break;
      writeSync(to, buf, 0, n);
    }
  } finally {
    closeSync(from);
    closeSync(to);
  }
}

/**
 * Feed a file to a callback one newline-delimited record at a time.
 *
 * `terminated` says whether the record was followed by a newline in the source. A rewrite has
 * to reproduce that exactly: the CLI appends to this file, and a transcript left without its
 * final newline would have the next record glued onto the last one, corrupting both.
 */
async function forEachLine(
  path: string,
  onLine: (line: string, terminated: boolean) => void,
): Promise<void> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const parts = (carry + decoder.decode(value, { stream: true })).split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) onLine(line, true);
    }
  } finally {
    reader.releaseLock();
  }
  if (carry) onLine(carry, false);
}

export async function auditTranscriptImagesFile(path: string): Promise<TranscriptImageAudit> {
  const audit = emptyImageAudit();
  await forEachLine(path, (line) => auditImageLine(audit, line));
  return audit;
}

export interface StripFileResult {
  removed: number;
  bytesFreed: number;
  remaining: TranscriptImageAudit;
}

/**
 * Rewrite a transcript with its image payloads replaced, keeping the same inode.
 *
 * The rewrite goes to a sibling file first so a crash midway cannot leave a half-written
 * transcript, and is then copied back over the original rather than renamed into place: the
 * CLI holds this path open in append mode, and a rename would leave it writing to an inode
 * nothing reads any more.
 *
 * Returns without touching the original when there was nothing to remove, so a no-op strip
 * cannot change the file's mtime.
 */
export async function stripTranscriptImagesFile(
  path: string,
  mode: StripMode,
  opts: ImageScopeOpts = {},
): Promise<StripFileResult> {
  const tmp = `${path}.strip-${process.pid}`;
  let removed = 0;
  let bytesFreed = 0;
  const remaining = emptyImageAudit();
  // The rewrite replaces the whole file, so anything appended after this point would be lost.
  // Callers are expected to stop the session first; this catches the case where they did not,
  // because the damage is silent — a dropped record breaks the parentUuid chain and the UI
  // renders the conversation as empty from that point back.
  const before = statSync(path);

  const writer = Bun.file(tmp).writer();
  try {
    await forEachLine(path, (line, terminated) => {
      const r = stripImageLine(line, mode, opts);
      removed += r.removed;
      bytesFreed += r.bytesFreed;
      auditImageLine(remaining, r.line);
      // Reproduce the source's separators byte for byte, trailing newline included.
      writer.write(terminated ? r.line + "\n" : r.line);
    });
    await writer.end();

    if (removed === 0) {
      unlinkSync(tmp);
      return { removed, bytesFreed, remaining };
    }
    // Guard against writing a truncated transcript over a good one.
    if (statSync(tmp).size === 0 && before.size > 0) {
      unlinkSync(tmp);
      throw new Error("Refusing to replace transcript with an empty rewrite");
    }
    const after = statSync(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      unlinkSync(tmp);
      throw new Error(
        "Transcript changed while it was being rewritten — the session is still running. " +
        "Nothing was modified; stop the session and try again.",
      );
    }
    copyOverInPlace(tmp, path);
    unlinkSync(tmp);
    return { removed, bytesFreed, remaining };
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}
