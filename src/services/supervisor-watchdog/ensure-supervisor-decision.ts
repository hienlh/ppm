/**
 * What PPM's watchdog task does on one of its runs (`ppm __ensure_supervisor__`, every 2 minutes
 * and at logon, from the Windows Task Scheduler task). Pure: every fact is passed in.
 *
 * Why it exists: on 20/11/2026 the machine ran out of memory and the supervisor died in the same
 * second as the server, so nothing inside PPM was left to bring it back; it stayed down 15 minutes
 * until someone typed `ppm restart`. Linux (systemd `Restart=always`) and macOS (launchd
 * `KeepAlive`) already restart a dead supervisor; this is Windows' equivalent.
 *
 * Rules, in order:
 * 1. A live supervisor: nothing to do.
 * 2. PPM is wanted only if its last run died (`status.json` still in a live state) or this is the
 *    first run since the machine started (logon used to start PPM unconditionally). `ppm stop
 *    --kill` / `ppm down` delete `status.json`, so a PPM someone took down stays down — until the
 *    next boot, as before.
 * 3. At most {@link MAX_STARTS} starts in {@link START_WINDOW_MS}: past that it gives up once,
 *    loudly, instead of restarting into a machine that keeps killing it.
 * 4. After a death, while free commit is exhausted (`commitExhausted`: 2 GB or 5% of the limit), it
 *    waits (the next run asks again) for at most {@link MAX_MEMORY_WAIT_MS}: a server started into
 *    an exhausted machine dies again and spends the budget. Not the user's block threshold, which a
 *    machine may sit under all day.
 */

export const MAX_STARTS = 5;
export const START_WINDOW_MS = 30 * 60_000;
export const MAX_MEMORY_WAIT_MS = 10 * 60_000;
/** An upgrade swaps supervisors: a status this fresh saying "upgrading" is a swap in progress, not a death. */
export const UPGRADE_GRACE_MS = 3 * 60_000;

/** The watchdog's own memory across runs (`watchdog-state.json`). */
export interface WatchdogState {
  /** When it started PPM, newest last, at most {@link MAX_STARTS} kept. */
  starts: number[];
  /** The last time it found PPM running or started it: the current boot is then handled. */
  bootHandledAt?: number;
  /** Since when it has been waiting for memory before a start. */
  waitingSince?: number;
  /** When it last gave up; it says so once per giving up. */
  gaveUpAt?: number;
}

export interface EnsureFacts {
  now: number;
  /** When the machine started (ms), or null when unknown. */
  bootAt: number | null;
  /** `status.json`'s state, or null when there is none. */
  statusState: string | null;
  /** How long ago `status.json` was written, or null when unknown. */
  statusAgeMs?: number | null;
  supervisorAlive: boolean;
  state: WatchdogState;
  /** Whether free commit is exhausted right now (false when unreadable). */
  memoryExhausted: boolean;
}

export type EnsureAction =
  | { action: "none"; reason: "running" | "not-wanted" | "gave-up" | "upgrading" }
  | { action: "wait"; reason: "low-memory"; waitedMs: number }
  | { action: "give-up"; starts: number }
  | { action: "start"; why: "boot" | "died"; afterWaitMs?: number };

const LIVE_STATES = new Set(["running", "paused", "upgrading"]);

export function decideEnsure(f: EnsureFacts): { decision: EnsureAction; state: WatchdogState } {
  const state: WatchdogState = { ...f.state, starts: f.state.starts.filter((t) => f.now - t < START_WINDOW_MS) };
  if (f.supervisorAlive) {
    return { decision: { action: "none", reason: "running" }, state: { ...state, bootHandledAt: f.now, waitingSince: undefined } };
  }
  if (f.statusState === "upgrading" && f.statusAgeMs != null && f.statusAgeMs < UPGRADE_GRACE_MS) {
    return { decision: { action: "none", reason: "upgrading" }, state };
  }
  const bootPending = f.bootAt !== null && (state.bootHandledAt ?? 0) < f.bootAt;
  const died = f.statusState !== null && LIVE_STATES.has(f.statusState);
  if (!bootPending && !died) return { decision: { action: "none", reason: "not-wanted" }, state: { ...state, waitingSince: undefined } };

  if (state.starts.length >= MAX_STARTS) {
    const oldest = state.starts[0]!;
    if (state.gaveUpAt !== undefined && state.gaveUpAt >= oldest) return { decision: { action: "none", reason: "gave-up" }, state };
    return { decision: { action: "give-up", starts: state.starts.length }, state: { ...state, gaveUpAt: f.now } };
  }

  let afterWaitMs: number | undefined;
  if (died && !bootPending && f.memoryExhausted) {
    const since = state.waitingSince ?? f.now;
    const waitedMs = f.now - since;
    if (waitedMs < MAX_MEMORY_WAIT_MS) {
      return { decision: { action: "wait", reason: "low-memory", waitedMs }, state: { ...state, waitingSince: since } };
    }
    afterWaitMs = waitedMs;
  } else if (state.waitingSince !== undefined && died) {
    afterWaitMs = f.now - state.waitingSince;
  }

  return {
    decision: { action: "start", why: bootPending ? "boot" : "died", ...(afterWaitMs !== undefined ? { afterWaitMs } : {}) },
    state: { ...state, starts: [...state.starts, f.now].slice(-MAX_STARTS), bootHandledAt: f.now, waitingSince: undefined },
  };
}
