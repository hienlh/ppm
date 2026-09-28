/** Shared argv-array shell-out for host-info providers. Every provider that
 *  needs PowerShell/plutil/findmnt/xdg-user-dir injects a `Runner` so unit
 *  tests never spawn a real process — only `defaultRunner` touches `Bun.spawn`. */
export interface RunResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null when killed by the timeout. */
  code: number | null;
  timedOut: boolean;
}

export type Runner = (argv: string[], timeoutMs?: number) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 5000;

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
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Process already exited between the timer firing and the kill call.
    }
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code, timedOut };
  } catch (e: any) {
    return { stdout: "", stderr: e?.message ?? String(e), code: null, timedOut };
  } finally {
    clearTimeout(killTimer);
  }
};
