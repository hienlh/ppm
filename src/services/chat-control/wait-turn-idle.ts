/**
 * Waits for a chat's running turn to end after it was asked to stop, by asking `isRunning` every
 * `intervalMs` until it says no or `timeoutMs` has passed. Answers whether the turn ended.
 *
 * A stop is a request, not a guarantee: a provider can take a moment to tear its subprocess down,
 * or not end the turn at all. A caller that acts on a stopped chat (deletes it) must therefore
 * wait for the turn to be gone, and must not act when it never goes.
 *
 * The clock and the sleep are injected so tests run without real time.
 */
export interface WaitTurnIdleOptions {
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const WAIT_TURN_IDLE_INTERVAL_MS = 100;
export const WAIT_TURN_IDLE_TIMEOUT_MS = 10_000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitTurnIdle(isRunning: () => boolean, opts: WaitTurnIdleOptions = {}): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? WAIT_TURN_IDLE_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? WAIT_TURN_IDLE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const deadline = now() + timeoutMs;
  while (isRunning()) {
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
  return true;
}
