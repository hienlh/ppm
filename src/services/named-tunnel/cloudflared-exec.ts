/**
 * One-shot cloudflared invocations (`tunnel create`, `route dns`, `tunnel
 * token`) — distinct from the long-running login process in
 * `cloudflared-login.service.ts`, which needs incremental stdout/stderr reads
 * instead of a single awaited result.
 */
import { ensureCloudflared } from "../cloudflared.service.ts";
import { killProcessTree } from "../windows-process-tree.ts";

export interface RunCloudflaredResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Short one-shot calls must never hang setup indefinitely on a network stall. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Spawn cloudflared with `args`, capture both streams, and enforce a timeout.
 * Never logs `args` — phase 1b's argv builders already keep them secret-free
 * (the run token travels via `--token-file`, never argv), so this stays that
 * way rather than re-introducing a leak at the logging layer.
 */
export async function runCloudflared(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunCloudflaredResult> {
  const bin = await ensureCloudflared();
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc.pid);
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) throw new Error(`cloudflared timed out after ${timeoutMs}ms`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
