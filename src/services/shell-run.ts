/**
 * Runs one command line to its end, asynchronously, with its output capped (`BoundedBuffer`),
 * killed at a time limit or when the caller's signal aborts. Used by the Run button on a chat's
 * code blocks.
 *
 * The process gets a group of its own (off Windows), so a stop reaches everything it started
 * (a test that drives a VM can be three shells deep), not only the direct child.
 */
import { BoundedBuffer } from "./bounded-buffer.ts";

const isWindows = process.platform === "win32";

export interface ShellRunOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** cmd.exe reads its own command line: pass it through as written. */
  windowsVerbatimArguments?: boolean;
}

export interface ShellRunResult {
  /** stdout and stderr in the order they arrived, colour codes removed. */
  output: string;
  /** Exit code; null when the process could not start, timed out or was stopped. */
  code: number | null;
  timedOut: boolean;
  /** The caller's signal aborted and the run was killed. */
  aborted: boolean;
  durationMs: number;
}

const spawnRun = (o: ShellRunOptions) =>
  Bun.spawn(o.argv, {
    cwd: o.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: !isWindows,
    windowsHide: true,
    windowsVerbatimArguments: o.windowsVerbatimArguments ?? false,
    env: o.env,
  });

async function pump(stream: ReadableStream<Uint8Array>, buf: BoundedBuffer): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf.append(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

/** Stops the whole run: the process group (the command and everything under it). */
function killTree(pid: number): void {
  if (isWindows) {
    try { Bun.spawn(["taskkill", "/pid", String(pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore", windowsHide: true }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  // A command that traps TERM (or a VM helper that ignores it) is ended for good a moment later.
  setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 3_000).unref?.();
}

export async function runShell(o: ShellRunOptions): Promise<ShellRunResult> {
  const started = Date.now();
  const buf = new BoundedBuffer();
  let code: number | null = null;
  let timedOut = false;
  let aborted = false;
  let proc: ReturnType<typeof spawnRun> | null = null;
  try {
    proc = spawnRun(o);
  } catch (e) {
    // Bun.spawn throws at once on a missing binary: report it as a run that could not start.
    buf.append((e as Error).message);
  }
  if (proc) {
    const p = proc;
    let giveUp!: () => void;
    const abandoned = new Promise<void>((r) => { giveUp = r; });
    const stop = () => {
      killTree(p.pid);
      try { p.kill(); } catch { /* already gone */ }
      giveUp();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    // A command's own children can keep the pipes open after the shell is killed, so the reads
    // are abandoned at the time limit rather than awaited to their end.
    await Promise.race([Promise.all([pump(p.stdout, buf), pump(p.stderr, buf)]).catch(() => {}), abandoned]);
    code = await Promise.race([p.exited, abandoned.then(() => null)]);
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    if (timedOut || aborted) code = null;
  }
  // eslint-disable-next-line no-control-regex
  const output = buf.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return { output, code, timedOut, aborted, durationMs: Date.now() - started };
}
