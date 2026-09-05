/**
 * Offset-anchored readiness reader for cloudflared's stderr log file.
 *
 * A quick or named tunnel is only "ready" once cloudflared writes a specific
 * line to its log. The caller truncates that log before every spawn, but the
 * truncation is best-effort and silently fails on Windows while a previous
 * detached cloudflared process still holds the file open — so a scan of the
 * WHOLE file can match a line left over from a dead connector and declare it
 * "ready" in well under 200ms. Anchoring every read to a byte offset captured
 * right after the truncate attempt makes that impossible: only bytes appended
 * by THIS process generation are ever considered.
 */
import { existsSync, readFileSync } from "node:fs";

export interface WaitForLogLineOpts {
  /** Only bytes at or after this offset are scanned — excludes any content
   *  left behind by a previous process generation. */
  fromByteOffset: number;
  timeoutMs: number;
  /** Poll-time check for whether the watched process has already exited. */
  getExitCode: () => number | null;
  pollIntervalMs?: number;
}

/**
 * Poll `path` until `regex` matches within the bytes appended after
 * `fromByteOffset`, the watched process exits, or `timeoutMs` elapses.
 *
 * Reads the file as a Buffer and slices by byte offset (not string index) so
 * a multi-byte UTF-8 character straddling the offset is never corrupted —
 * `toString("utf8")` re-decodes the whole remaining tail on every poll, so a
 * boundary can only delay a match by one poll interval, never corrupt it.
 */
export async function waitForLogLine(
  path: string,
  regex: RegExp,
  opts: WaitForLogLineOpts,
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollIntervalMs ?? 200;

  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const buf = readFileSync(path);
        const tail = buf.subarray(opts.fromByteOffset).toString("utf8");
        const match = tail.match(regex);
        if (match) return match[0];
      } catch {
        // Transient read race (file replaced mid-poll) — retry next tick.
      }
    }
    if (opts.getExitCode() !== null) {
      throw new Error(`cloudflared exited without matching ${regex}`);
    }
    await Bun.sleep(pollMs);
  }
  throw new Error(`readiness timeout (${opts.timeoutMs}ms)`);
}
