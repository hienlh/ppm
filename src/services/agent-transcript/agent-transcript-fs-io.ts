/**
 * Filesystem seam the hub reads through, so a test can simulate a locked or
 * vanished file without touching real disk I/O, and so the tick path never
 * hides a surprise `fs` call behind a helper that looks pure.
 *
 * Every read is by explicit byte range — the hub never re-reads a file from
 * the start just to find out how much it grew, and a stat is one syscall
 * shared across every subscription watching the same path in a given tick
 * (see `agent-transcript-session-hub.ts`).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface AgentTranscriptFsIo {
  /** Current file size in bytes. Throws if the file does not exist. */
  statSize(path: string): number;
  /** Directory mtime in epoch ms, for the "did anything change" index-refresh check. Throws if missing. */
  statDirMtimeMs(path: string): number;
  /** Bytes `[start, start+length)`. `length <= 0` returns an empty buffer without opening the file. */
  readRange(path: string, start: number, length: number): Buffer;
}

function realReadRange(path: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export const realAgentTranscriptFsIo: AgentTranscriptFsIo = {
  statSize: (path) => statSync(path).size,
  statDirMtimeMs: (path) => statSync(path).mtimeMs,
  readRange: realReadRange,
};

/** Mutable seam — reassign in a test, restore in `afterEach`. */
export const agentTranscriptFsIo: AgentTranscriptFsIo = { ...realAgentTranscriptFsIo };

export function resetAgentTranscriptFsIoForTest(): void {
  agentTranscriptFsIo.statSize = realAgentTranscriptFsIo.statSize;
  agentTranscriptFsIo.statDirMtimeMs = realAgentTranscriptFsIo.statDirMtimeMs;
  agentTranscriptFsIo.readRange = realAgentTranscriptFsIo.readRange;
}

/** `statSize`, or `null` for any error (missing file, permission, raced delete). */
export function statSizeSafe(path: string): number | null {
  try {
    return agentTranscriptFsIo.statSize(path);
  } catch {
    return null;
  }
}

/** `statDirMtimeMs`, or `null` for any error. */
export function statDirMtimeSafe(path: string): number | null {
  try {
    return agentTranscriptFsIo.statDirMtimeMs(path);
  } catch {
    return null;
  }
}
