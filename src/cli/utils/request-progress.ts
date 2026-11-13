/**
 * A request that may run for minutes (an extension, language server, speech model or database
 * driver install) prints a line every `everyMs` while it waits, so a person or an AI's shell can
 * tell a slow install from a hung one. The lines go to stderr: stdout stays the command's answer.
 */
export const LONG_REQUEST_TIMEOUT_MS = 600_000;
const PROGRESS_EVERY_MS = 15_000;

export async function withProgress<T>(work: () => Promise<T>, enabled: boolean, everyMs = PROGRESS_EVERY_MS): Promise<T> {
  if (!enabled) return work();
  const started = Date.now();
  const ticker = setInterval(() => {
    console.error(`… still working (${Math.round((Date.now() - started) / 1000)}s)`);
  }, everyMs);
  try {
    return await work();
  } finally {
    clearInterval(ticker);
  }
}

/** True for the error an `AbortSignal.timeout` fetch throws when its time ran out. */
export function isTimeoutError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}
