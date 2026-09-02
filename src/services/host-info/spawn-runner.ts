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

/** Real implementation: argv array only (never string-interpolated into a shell), bounded by timeoutMs. */
export const defaultRunner: Runner = async (argv, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
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
