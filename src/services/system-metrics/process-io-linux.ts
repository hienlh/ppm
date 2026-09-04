/**
 * Per-process disk bytes on Linux from `/proc/<pid>/io` — no subprocess.
 *
 * `read_bytes`/`write_bytes` are the counters that actually reached the block
 * layer, which is what a Task-Manager "Disk" column means; `rchar`/`wchar`
 * would also count page-cache hits and make every process look busy.
 *
 * The file is PTRACE_MODE_READ-protected, so unprivileged PPM sees it only for
 * its own uid: an EACCES is the NORMAL case for other users' processes and must
 * leave those rows unmeasured (`undefined`) rather than 0 or an exception.
 */
import { readFileSync } from "node:fs";

export interface ProcIoBytes {
  readBytes: number;
  writeBytes: number;
}

const FIELD = /^(read_bytes|write_bytes):\s+(\d+)$/;

/** Null when neither counter is present (a kernel thread reports zeros only in
 *  some kernels, and a truncated read must not be guessed at). */
export function parseProcIo(text: string): ProcIoBytes | null {
  let read: number | undefined;
  let write: number | undefined;
  for (const line of text.split("\n")) {
    const m = FIELD.exec(line.trim());
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    if (m[1] === "read_bytes") read = value;
    else write = value;
  }
  if (read === undefined && write === undefined) return null;
  return { readBytes: read ?? 0, writeBytes: write ?? 0 };
}

/** Null on EACCES (another user's process), ENOENT (exited between readdir and
 *  read) or an unparseable file. Never throws. */
export function readProcIoBytes(pid: number): ProcIoBytes | null {
  try {
    return parseProcIo(readFileSync(`/proc/${pid}/io`, "utf-8"));
  } catch {
    return null;
  }
}
