/**
 * The one door between the helper's logic and the machine: spawning Windows tools, reading the
 * helper's state files, staging payloads. Tests swap in a fake (`setHelperSystem`), so nothing
 * in the helper's logic touches the real Task Scheduler, UAC or `tscon`.
 *
 * Spawns are always asynchronous with a kill timer of their own: a synchronous spawn with a
 * `timeout` fails at once inside a request after the server has idled (Bun 1.3.10, Windows —
 * see CLAUDE.md), and these run inside requests.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { downloadVerified } from "../../speech-to-text/whisper-download.ts";

export interface CommandResult {
  /** null when the process was killed by the timeout or could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HelperSystem {
  platform: NodeJS.Platform;
  run(cmd: string[], timeoutMs: number): Promise<CommandResult>;
  readText(path: string): string | null;
  /** Staging only: PPM's own folder. The admin side never reads anything it did not hash. */
  writeText(path: string, text: string): void;
  exists(path: string): boolean;
  /** Fetch `url` to `dest`, refusing (and deleting) anything whose SHA-256 is not `sha256`. */
  download(url: string, dest: string, sha256: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

async function runCommand(cmd: string[], timeoutMs: number): Promise<CommandResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (e) {
    // `Bun.spawn` throws synchronously for a missing binary (CLAUDE.md).
    return { code: null, stdout: "", stderr: (e as Error).message };
  }
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code: proc.signalCode ? null : code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export const realHelperSystem: HelperSystem = {
  platform: process.platform,
  run: runCommand,
  readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  writeText: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  },
  exists: (path) => existsSync(path),
  download: (url, dest, sha256) => downloadVerified({ url, dest, sha256 }),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let current: HelperSystem = realHelperSystem;

export function helperSystem(): HelperSystem {
  return current;
}

/** Tests only: route every helper call through `system`; `null` restores the real one. */
export function setHelperSystem(system: HelperSystem | null): void {
  current = system ?? realHelperSystem;
}
