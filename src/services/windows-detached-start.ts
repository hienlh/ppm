/**
 * Start a process on Windows that outlives its caller, through PowerShell `Start-Process` (a fresh
 * process outside the caller's job object, with no console window), and learn its PID.
 *
 * The PID comes back through a file, never through PowerShell's stdout. `Start-Process` creates
 * the child with handle inheritance on, so a long-lived child (the supervisor) holds a copy of the
 * pipe PowerShell writes its stdout and stderr to. Bun 1.4.4's `spawnSync` waits for those pipes
 * to close, not for PowerShell to exit, so `ppm start` waited for as long as the supervisor ran:
 * measured, a 20 s child kept `spawnSync` 20,228 ms on 1.4.4 against 262 ms on 1.3.12. The
 * leftover `ppm start` process held 466 MB for the life of PPM, and the Task Scheduler watchdog,
 * which starts PPM through the same code, would leave one behind on every restart. With no pipes
 * at all (`stdio: "ignore"`) it returns in ~200 ms on both.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A PowerShell single-quoted string literal. */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export interface DetachedStartOptions {
  exe: string;
  args: string[];
  /** Where the child's stdout and stderr go (`Start-Process` truncates both). */
  stdoutPath: string;
  stderrPath: string;
}

/** The PowerShell script: start the child, then write its PID, or the error, to a file. */
export function detachedStartScript(opts: DetachedStartOptions, pidFile: string, errFile: string): string {
  // Start-Process rejects an empty argument, which is why callers pass "_" for a blank slot.
  const argList = opts.args.map((a) => psQuote(a || "_")).join(",");
  return [
    "try {",
    `$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ${psQuote(opts.exe)} -ArgumentList ${argList}`,
    `-RedirectStandardOutput ${psQuote(opts.stdoutPath)} -RedirectStandardError ${psQuote(opts.stderrPath)};`,
    `Set-Content -LiteralPath ${psQuote(pidFile)} -Value $p.Id -Encoding ascii`,
    "} catch {",
    `Set-Content -LiteralPath ${psQuote(errFile)} -Value $_.Exception.Message -Encoding utf8`,
    "}",
  ].join(" ");
}

/** Start the child detached; its PID, or why it could not be started. */
export function startDetachedOnWindows(opts: DetachedStartOptions): { pid: number } | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), "ppm-detached-start-"));
  const pidFile = join(dir, "pid.txt");
  const errFile = join(dir, "error.txt");
  try {
    const r = Bun.spawnSync({
      cmd: ["powershell", "-NoProfile", "-NonInteractive", "-Command", detachedStartScript(opts, pidFile, errFile)],
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const read = (f: string) => { try { return readFileSync(f, "utf8").replace(/^﻿/, "").trim(); } catch { return ""; } };
    const pid = parseInt(read(pidFile), 10);
    if (Number.isFinite(pid) && pid > 0) return { pid };
    return { error: read(errFile) || `PowerShell exited with code ${r.exitCode} and reported no PID` };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir, left for the OS */ }
  }
}
