/**
 * Runs the host's `gh` CLI for the PR link reader: fixed argv, no shell, no prompt, 15 s timeout.
 * `Bun.spawn` throws synchronously when the binary is missing, so the spawn itself sits inside the
 * `try` and a missing `gh` comes back as a failed run (`code: null`) rather than an exception.
 */

export interface GhRun {
  /** Exit code; null when `gh` could not be started at all or was killed by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `gh` is not installed (or not on PATH). */
  missing: boolean;
  timedOut: boolean;
}

export type GhRunner = (args: readonly string[]) => Promise<GhRun>;

export const GH_TIMEOUT_MS = 15_000;

function spawnGh(args: readonly string[]) {
  return Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // `env` is passed explicitly: without it a child gets the environment the process started with.
    env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  });
}

export const runGh: GhRunner = async (args) => {
  let proc: ReturnType<typeof spawnGh>;
  try {
    proc = spawnGh(args);
  } catch (e) {
    return { code: null, stdout: "", stderr: (e as Error).message, missing: true, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already gone */ }
  }, GH_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: timedOut ? null : code, stdout, stderr, missing: false, timedOut };
  } catch (e) {
    return { code: null, stdout: "", stderr: (e as Error).message, missing: false, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/** What a failed `gh` run means for a PR link: `gh` is unusable here, or this one call failed. */
export function ghFailure(run: GhRun): { unavailable: boolean; message: string } {
  if (run.missing) return { unavailable: true, message: "gh not available" };
  const err = run.stderr.toLowerCase();
  if (/auth login|not logged in|authentication|gh_token|no oauth token/.test(err)) return { unavailable: true, message: "gh not available" };
  if (run.timedOut) return { unavailable: false, message: "gh timed out" };
  const first = run.stderr.split(/\r?\n/).find((l) => l.trim())?.trim() ?? `gh exited with ${run.code}`;
  return { unavailable: false, message: first.slice(0, 200) };
}
