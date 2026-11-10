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

const shellArgv = (command: string): string[] =>
  process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command];

const spawnTest = (command: string, cwd: string) =>
  Bun.spawn(shellArgv(command), {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
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

/** Stops what the shell started (the test runner and its workers), then the shell itself. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try { Bun.spawn(["taskkill", "/pid", String(pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore", windowsHide: true }); } catch { /* best effort */ }
    return;
  }
  try { Bun.spawn(["pkill", "-TERM", "-P", String(pid)], { stdout: "ignore", stderr: "ignore" }); } catch { /* no pkill */ }
}

export interface TestRun {
  record: SpecRunRecord;
  verdict: Verdict;
}

export async function runTestCommand(command: string, cwd: string, timeoutMs: number): Promise<TestRun> {
  const started = Date.now();
  const buf = new BoundedBuffer();
  let code: number | null = null;
  let timedOut = false;
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
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(p.pid);
      try { p.kill(); } catch { /* already gone */ }
      giveUp();
    }, timeoutMs);
    // A runner's own children can keep the pipes open after the shell is killed, so the reads
    // are abandoned at the time limit rather than awaited to their end.
    await Promise.race([Promise.all([pump(p.stdout, buf), pump(p.stderr, buf)]).catch(() => {}), abandoned]);
    code = await Promise.race([p.exited, abandoned.then(() => null)]);
    clearTimeout(timer);
    if (timedOut) code = null;
  }
  // eslint-disable-next-line no-control-regex
  const output = buf.toString().replace(/\x1b\[[0-9;]*m/g, "");
  const verdict = judgeRun({ command, output, code, timedOut });
  return {
    verdict,
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
