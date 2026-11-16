import type { StartReason } from "./start-reason.ts";

/**
 * The supervisor's decisions about why its next server starts, kept apart from `supervisor.ts`
 * so every path can be tested as a table: what a server's exit means (respawn now, after a backoff,
 * or not at all) and the reason the next server is given, and why the first server, a resumed one,
 * a revived one and the one after a failed self-replace start.
 *
 * `takeRequest` is the `ppm restart --reason …` file, consumed when read. It is asked only on paths
 * where a person or a script asked for the restart, so a crash never wears a request it did not make.
 */

export type TakeRequest = () => StartReason | null;

export interface ServerExit {
  exitCode: number | null;
  signal: string;
  /** Seconds the server ran. */
  upForS: number;
  /** `ppm stop` put the supervisor in its stopped state. */
  stopped: boolean;
  /** The supervisor is shutting down or upgrading. */
  shuttingDown: boolean;
  /** The health check killed this server. */
  healthKill: boolean;
  /** A restart was asked for (SIGUSR2, the Windows command file, PPM Cloud). */
  restartRequested: boolean;
}

export type ServerExitDecision =
  | { action: "stay_down" }
  | { action: "respawn_now"; reason: StartReason }
  /** A crash: backed off, and paused after too many in a row (`resumeAfterPauseReason`). */
  | { action: "respawn_after_backoff"; reason: StartReason };

/**
 * A request that says only who asked (a `ppm restart` with no `--reason`) keeps the words the
 * supervisor would have used and adds the asker; one with a reason of its own replaces them.
 */
export function mergeRequest(requested: StartReason | null, fallback: StartReason): StartReason {
  if (!requested) return fallback;
  if (requested.kind === "manual" && !requested.detail && fallback.kind === "manual") {
    return requested.requestedBy ? { ...fallback, requestedBy: requested.requestedBy } : fallback;
  }
  return requested;
}

/** The restart a person or script asked for, else `fallback`. */
const requestedOr = (take: TakeRequest, fallback: StartReason): StartReason => {
  try {
    return mergeRequest(take(), fallback);
  } catch {
    return fallback;
  }
};

/** What a server's exit means, and the reason the next server is given. */
export function decideServerExit(exit: ServerExit, takeRequest: TakeRequest): ServerExitDecision {
  if (exit.stopped || exit.shuttingDown) return { action: "stay_down" };
  // Exit 42 is the server asking for a restart. A SIGTERM ends a healthy-enough server with code 0
  // too, so the same exit can also be the health check's kill or a `ppm restart`.
  if (exit.exitCode === 42 || exit.exitCode === 0) {
    if (exit.healthKill) return { action: "respawn_now", reason: { kind: "watchdog", detail: "the server stopped answering health checks and was stopped" } };
    return {
      action: "respawn_now",
      reason: requestedOr(takeRequest, { kind: "manual", ...(exit.restartRequested ? {} : { detail: "the server asked to be restarted" }) }),
    };
  }
  // A restart someone asked for that ended the server with a kill (always so on Windows).
  if (exit.restartRequested) return { action: "respawn_now", reason: requestedOr(takeRequest, { kind: "manual" }) };
  if (exit.healthKill) {
    return { action: "respawn_after_backoff", reason: { kind: "watchdog", detail: `the server stopped answering health checks and was killed after ${exit.upForS}s` } };
  }
  return { action: "respawn_after_backoff", reason: { kind: "crash", detail: `exit ${exit.exitCode}, signal ${exit.signal}, after ${exit.upForS}s` } };
}

/** The health check killed server `pid` at `at`. */
export interface HealthKillMark {
  pid: number;
  at: number;
}

/** A kill that has not ended its server by then failed, and the mark says nothing more. */
export const HEALTH_KILL_MARK_TTL_MS = 60_000;

/**
 * Whether the exit of server `exitedPid` is the health check's kill. Only the server it killed:
 * a mark left by a kill that failed must not label the next, unrelated exit the watchdog's.
 */
export const healthKillApplies = (mark: HealthKillMark | null, exitedPid: number | undefined): boolean =>
  !!mark && mark.pid === exitedPid;

/** The mark after a health probe the server answered: dropped once the kill has clearly failed. */
export const healthKillAfterAnswer = (mark: HealthKillMark | null, now: number): HealthKillMark | null =>
  mark && now - mark.at > HEALTH_KILL_MARK_TTL_MS ? null : mark;

/**
 * {@link healthKillAfterAnswer}, plus the cleanup a failed kill needs: the kill also left an
 * ordered-stop note for that pid, and once the mark is dropped the note goes too (`dropNote`) —
 * otherwise a later, real crash of the same server would read as a stop the supervisor ordered.
 */
export function healthProbeAnswered(
  mark: HealthKillMark | null, now: number, dropNote: (pid: number) => void,
): HealthKillMark | null {
  const next = healthKillAfterAnswer(mark, now);
  if (mark && !next) {
    try { dropNote(mark.pid); } catch { /* the note then stays, as before */ }
  }
  return next;
}

/** The server that comes back after the supervisor paused on repeated crashes and was resumed. */
export function resumeAfterPauseReason(lastCrash: StartReason, takeRequest: TakeRequest): StartReason {
  return requestedOr(takeRequest, { kind: "manual", detail: `resumed after repeated crashes (last: ${lastCrash.detail ?? lastCrash.kind})` });
}

/** The server that comes back after `ppm stop` and then `ppm start`/`restart`. */
export function resumeAfterStopReason(takeRequest: TakeRequest): StartReason {
  return requestedOr(takeRequest, { kind: "manual", detail: "resumed after ppm stop" });
}

/** A restart asked for while no server was running at all: the supervisor just starts one. */
export function restartWithoutChildReason(takeRequest: TakeRequest): StartReason {
  return requestedOr(takeRequest, { kind: "manual" });
}

/** The health check found no server process while one should run, and started one. */
export const REVIVE_REASON: StartReason = { kind: "unknown", detail: "no server process was running, so the supervisor started one" };

/** A self-replace whose new supervisor never took over: the previous version runs again. */
export const UPGRADE_FAILED_REASON: StartReason = { kind: "upgrade", detail: "the upgrade failed, so the previous version was started again" };

/** Whether a start reason is {@link UPGRADE_FAILED_REASON}, as the server reads it back from the environment. */
export const isUpgradeFailed = (r: StartReason | null | undefined): boolean =>
  !!r && r.kind === UPGRADE_FAILED_REASON.kind && r.detail === UPGRADE_FAILED_REASON.detail;

/** A supervisor started this long after the machine is taken to have started with it. */
export const BOOT_WINDOW_S = 10 * 60;

/** Why the supervisor's first server starts: an upgrade, a restart someone asked for, a boot, or a start. */
export function initialStartReason(opts: { isUpgrade: boolean; uptimeS: number | null; takeRequest: TakeRequest }): StartReason {
  if (opts.isUpgrade) return { kind: "upgrade" };
  let requested: StartReason | null = null;
  try { requested = opts.takeRequest(); } catch { /* none */ }
  const started: StartReason = { kind: "manual", detail: "PPM was started (ppm start, or its service starting it again)" };
  // A `ppm restart` that found the supervisor dead and started PPM again: it asked, so not a boot.
  if (requested) return mergeRequest(requested, started);
  if (opts.uptimeS !== null && opts.uptimeS < BOOT_WINDOW_S) {
    return { kind: "boot", detail: `the machine started ${Math.round(opts.uptimeS / 60)} min earlier` };
  }
  return started;
}
