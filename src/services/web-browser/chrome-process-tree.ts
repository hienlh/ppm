/**
 * Reading and killing Chrome's process tree without ever blocking the event loop: every tool
 * runs through an awaited `Bun.spawn` with its own kill timer.
 */
import { readFileSync } from "node:fs";
import { collectProcessTree, killPids } from "../windows-process-tree.ts";

async function run(cmd: string[], timeoutMs: number): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", windowsHide: true });
  } catch {
    return null; // the tool is not installed on this host
  }
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  try {
    const out = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The command line of `pid`, or null when it is not running (or cannot be read). */
export async function processCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return null; }
  }
  if (process.platform === "win32") {
    const out = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], 8000);
    return out && out.trim() ? out.trim() : null;
  }
  const out = await run(["ps", "-o", "args=", "-p", String(pid)], 5000);
  return out && out.trim() ? out.trim() : null;
}

/** Kills `pid` and every descendant. */
export async function killChromeTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const out = await run(["taskkill", "/PID", String(pid), "/T", "/F"], 8000);
    if (out === null) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    return;
  }
  try {
    killPids(collectProcessTree(pid), "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}
