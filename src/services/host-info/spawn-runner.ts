/** Shared argv-array shell-out for host-info providers. Every provider that
 *  needs PowerShell/plutil/findmnt/xdg-user-dir injects a `Runner` so unit
 *  tests never spawn a real process — only `defaultRunner` touches `Bun.spawn`. */
import { createLogger } from "../logger.ts";

const log = createLogger("spawn");

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null when killed by the timeout. */
  code: number | null;
  timedOut: boolean;
}

export type Runner = (argv: string[], timeoutMs?: number) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 5000;

/** A tool that hangs tends to hang on every poll, so each binary's timeout is a WARN at
 *  most once a minute and a DEBUG line otherwise. Keyed by binary name: the arguments
 *  are never logged, since a caller's argv is its own business. */
const TIMEOUT_REPORT_EVERY_MS = 60_000;
const timeoutReports = new Map<string, { at: number; suppressed: number }>();

function reportTimeout(argv0: string | undefined, timeoutMs: number): void {
  const bin = argv0?.split(/[\\/]/).pop() || "?";
  const now = Date.now();
  const last = timeoutReports.get(bin);
  if (last && now - last.at < TIMEOUT_REPORT_EVERY_MS) {
    last.suppressed++;
    log.debug(`${bin} timed out after ${timeoutMs} ms; killed`);
    return;
  }
  const more = last?.suppressed ? ` (+${last.suppressed} more since the last one logged)` : "";
  timeoutReports.set(bin, { at: now, suppressed: 0 });
  log.warn(`${bin} timed out after ${timeoutMs} ms; killed${more}`);
}

/** Real implementation: argv array only (never string-interpolated into a shell), bounded by timeoutMs.
 *
 *  `Bun.spawn` **throws synchronously** when the binary is not on `PATH`
 *  ("Executable not found in $PATH"), and for these providers that is a normal
 *  condition rather than an error: every one of them shells out to a per-OS tool
 *  (`systemctl`, `plutil`, `powershell.exe`, `findmnt`, `xdg-user-dir`,
 *  `nvidia-smi`), so on any other OS the binary is simply absent. Left to throw,
 *  it escapes the `Promise<RunResult>` this signature promises: the Services page
 *  on macOS and Windows answered 500 and showed the exception, instead of the
 *  "this host has no service manager" the collector is written to report.
 *
 *  So a missing binary is returned as a run that failed — `code: null` with the
 *  message on stderr, which is the shape every caller already handles for a
 *  non-zero exit. */
const spawnPiped = (argv: string[]) =>
  Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });

export const defaultRunner: Runner = async (argv, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  // Named via `spawnPiped` rather than `ReturnType<typeof Bun.spawn>`: the bare
  // form loses the option narrowing, and `proc.stdout` widens back to a union
  // with `number` (a raw fd) that `new Response()` will not take.
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(argv);
  } catch (e: any) {
    return { stdout: "", stderr: e?.message ?? String(e), code: null, timedOut: false };
  }
  let timedOut = false;
  /** Resolves when the timeout fires, so the readers below stop waiting with the process. */
  let giveUp!: () => void;
  const abandoned = new Promise<void>((resolve) => { giveUp = resolve; });
  const killTimer = setTimeout(() => {
    timedOut = true;
    reportTimeout(argv[0], timeoutMs);
    try {
      proc.kill();
    } catch {
      // Process already exited between the timer firing and the kill call.
    }
    giveUp();
  }, timeoutMs);

  /**
   * The output, or nothing once the run has been given up on.
   *
   * Killing the process does **not** close its pipes. A shell that forks rather than execs
   * leaves a grandchild holding the write end, so draining stdout goes on until *that* exits —
   * measured, `proc.exited` came back at the 150ms timeout while the drain ran the full five
   * seconds, which means `timeoutMs` bounded nothing at all. The pending read is left to settle
   * on its own and discarded rather than cancelled: cancelling a subprocess stream has crashed
   * Bun on Windows before, and there is nothing here worth that risk.
   */
  const readOrAbandon = (stream: ReadableStream<Uint8Array>): Promise<string> =>
    Promise.race([
      new Response(stream).text().catch(() => ""),
      abandoned.then(() => ""),
    ]);

  try {
    const [stdout, stderr, code] = await Promise.all([
      readOrAbandon(proc.stdout),
      readOrAbandon(proc.stderr),
      proc.exited,
    ]);
    return { stdout, stderr, code, timedOut };
  } catch (e: any) {
    return { stdout: "", stderr: e?.message ?? String(e), code: null, timedOut };
  } finally {
    clearTimeout(killTimer);
  }
};
