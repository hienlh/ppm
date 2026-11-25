/**
 * Runs a spec's approved test command in the project folder and judges the result.
 *
 * The command is the one in design.md's `ppm-test` block, run only after the user approved
 * that document — PPM never runs a command the AI changed since. It goes through the shell
 * because test commands are written for one (`bun test {files}`, `cd api && go test ./...`).
 * Asynchronous throughout, output capped (`BoundedBuffer`), killed at the time limit.
 */
import { BoundedBuffer } from "../bounded-buffer.ts";
import { judgeRun, type Verdict } from "./test-judge.ts";
import type { SpecRunRecord } from "../../shared/spec-types.ts";

export const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_SUITE_TIMEOUT_MS = 20 * 60_000;

/** Quotes one argument for the platform's shell. */
export function shellQuote(arg: string): string {
  if (process.platform === "win32") return `"${arg.replace(/"/g, '""')}"`;
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Puts the task's test files into the command's `{files}`. */
export function expandTestCommand(template: string, files: string[]): string {
  return template.replace(/\{files\}/g, files.map(shellQuote).join(" "));
}

// cmd.exe reads its command line itself, not as argv: quoted as one argument, `"sum.test.ts"`
// reached bun as `\"sum.test.ts\"` and matched no file. So the line goes through verbatim,
// wrapped in the outer quotes `/s` strips (Node's `shell: true` does the same).
const isWindows = process.platform === "win32";
const shellArgv = (command: string): string[] =>
  isWindows ? ["cmd.exe", "/d", "/s", "/c", `"${command}"`] : ["/bin/sh", "-c", command];

const spawnTest = (command: string, cwd: string) =>
  Bun.spawn(shellArgv(command), {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // A group of its own, so a stop reaches every process the runner started (a test that drives
    // a VM can be three shells deep), not only the shell's direct children.
    detached: !isWindows,
    windowsHide: true,
    windowsVerbatimArguments: isWindows,
    // CI=1 makes most runners print plainly (no watch mode, no colour, no spinner).
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
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

/** Stops the whole run: the shell's process group (the runner and everything under it). */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try { Bun.spawn(["taskkill", "/pid", String(pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore", windowsHide: true }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  // A runner that traps TERM (or a VM helper that ignores it) is ended for good a moment later.
  setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 3_000).unref?.();
}

export interface TestRun {
  record: SpecRunRecord;
  verdict: Verdict;
  /** The caller gave up on the run (the chat stopped the call) and it was killed: judge nothing. */
  aborted?: boolean;
}

/**
 * `signal` is the tool call that asked for the run: when it aborts (the user stopped the turn,
 * the provider gave up) the run is killed at once instead of going on unseen for minutes.
 */
export async function runTestCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<TestRun> {
  const started = Date.now();
  const buf = new BoundedBuffer();
  let code: number | null = null;
  let timedOut = false;
  let aborted = false;
  let proc: ReturnType<typeof spawnTest> | null = null;
  try {
    proc = spawnTest(command, cwd);
  } catch (e) {
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
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    // A runner's own children can keep the pipes open after the shell is killed, so the reads
    // are abandoned at the time limit rather than awaited to their end.
    await Promise.race([Promise.all([pump(p.stdout, buf), pump(p.stderr, buf)]).catch(() => {}), abandoned]);
    code = await Promise.race([p.exited, abandoned.then(() => null)]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (timedOut || aborted) code = null;
  }
  // eslint-disable-next-line no-control-regex
  const output = buf.toString().replace(/\x1b\[[0-9;]*m/g, "");
  const verdict = judgeRun({ command, output, code, timedOut });
  return {
    verdict,
    ...(aborted ? { aborted } : {}),
    record: {
      at: new Date().toISOString(),
      command,
      outcome: verdict.outcome,
      failing: verdict.failing,
      passed: verdict.passed,
      failed: verdict.failed,
      weak: verdict.weak,
      output: output.length > 12_000 ? `${output.slice(0, 4_000)}\n…\n${output.slice(-8_000)}` : output,
      durationMs: Date.now() - started,
    },
  };
}
