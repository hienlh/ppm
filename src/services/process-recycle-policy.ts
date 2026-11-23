/**
 * When the supervisor replaces itself, or restarts the server, to give back memory a leaking Bun
 * will never return. Pure: the supervisor feeds it readings and acts on the answer.
 *
 * Bun before 1.4.4 on Windows keeps a fully committed 32 MB block each time an idle helper thread
 * exits (`bun-runtime-advisory.ts`). The edge already recycles itself (`edge-recycle-policy.ts`);
 * this is the same guard for the other two. Live on 1.3.12 the supervisor and server each reached
 * 7.9 GB after 30 hours and left the machine 11.8 GB of commit. On 1.4.4 nothing grows and the
 * limits below are never reached, so this is a safety net, not the fix.
 *
 * Both recycles cut every chat subprocess, terminal and remote desktop session the server holds
 * (replacing the supervisor stops the server too: `selfReplace` keeps only the tunnel and the
 * edge), so they happen only while PPM has been quiet for a while, as the server itself reports
 * in its activity file (`server-activity-file.ts`). A machine that never goes quiet keeps growing,
 * as it does today; that is the trade for never cutting someone's work.
 *
 * Figures are private bytes (commit), as for the edge: Windows only, off elsewhere.
 */

export const SUPERVISOR_RECYCLE_MB_ENV = "PPM_SUPERVISOR_RECYCLE_MB";
export const SERVER_RECYCLE_MB_ENV = "PPM_SERVER_RECYCLE_MB";
/** A fresh supervisor sits at 450–530 MB on 1.3.12 and under 300 MB on 1.4.4. */
export const DEFAULT_SUPERVISOR_RECYCLE_MB = 2048;
/** A busy server legitimately holds 2.5–3.3 GB; a fresh one under 1 GB. */
export const DEFAULT_SERVER_RECYCLE_MB = 3584;
/** How long nothing may have been running before a recycle may cut anything. */
export const RECYCLE_QUIET_MS = 5 * 60_000;
/** Over-limit readings in a row before acting, so one spike never triggers a restart. */
export const RECYCLE_CONFIRM_READINGS = 3;
/** Minimum time between two recycles, so a process born over its limit cannot loop. */
export const RECYCLE_COOLDOWN_MS = 30 * 60_000;
/** An activity report older than this says nothing: the server may be stuck or gone. */
export const ACTIVITY_MAX_AGE_MS = 2 * 60_000;

/** A limit in MB from the env, or null when recycling is off (not Windows, or `0`). */
export function recycleLimitMB(
  envKey: string,
  fallbackMB: number,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (platform !== "win32") return null;
  const raw = env[envKey]?.trim();
  if (!raw) return fallbackMB;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return fallbackMB;
  return mb === 0 ? null : Math.round(mb);
}

export const supervisorRecycleLimitMB = (env?: Record<string, string | undefined>, platform?: NodeJS.Platform) =>
  recycleLimitMB(SUPERVISOR_RECYCLE_MB_ENV, DEFAULT_SUPERVISOR_RECYCLE_MB, env, platform);
export const serverRecycleLimitMB = (env?: Record<string, string | undefined>, platform?: NodeJS.Platform) =>
  recycleLimitMB(SERVER_RECYCLE_MB_ENV, DEFAULT_SERVER_RECYCLE_MB, env, platform);

/** What the server last reported about itself (`server-activity-file.ts`). */
export interface ServerActivity {
  /** Server pid the report is from; a report from another pid is ignored. */
  pid: number;
  /** When the report was written (ms since the epoch). */
  at: number;
  /** Something a restart would cut is running now. */
  busy: boolean;
  /** Since when nothing has been running (ms since the epoch); absent while busy. */
  quietSince?: number;
  /** What made it busy, for the log. */
  reasons?: string[];
}

export interface RecycleReadings {
  now: number;
  supervisorMB?: number;
  serverMB?: number;
  serverPid?: number;
  activity: ServerActivity | null;
}

export interface RecycleLimits {
  supervisorMB: number | null;
  serverMB: number | null;
}

/** Carried between readings by the caller. */
export interface RecycleState {
  supervisorOver: number;
  serverOver: number;
  lastRecycleAt: number | null;
}

export const initialRecycleState = (): RecycleState => ({ supervisorOver: 0, serverOver: 0, lastRecycleAt: null });

export type RecycleAction =
  | { kind: "none" }
  /** Over a limit, but something is running or the server's report is missing. */
  | { kind: "wait"; target: "supervisor" | "server"; why: string }
  | { kind: "server"; detail: string }
  | { kind: "supervisor"; detail: string };

const over = (mb: number | undefined, limit: number | null) => limit !== null && mb !== undefined && mb >= limit;

/** Whether the server's report says PPM has been quiet long enough; else why not. */
export function quietEnough(activity: ServerActivity | null, serverPid: number | undefined, now: number): { ok: true } | { ok: false; why: string } {
  if (!activity || serverPid === undefined || activity.pid !== serverPid) return { ok: false, why: "the server has not reported its activity" };
  if (now - activity.at > ACTIVITY_MAX_AGE_MS) return { ok: false, why: "the server's activity report is stale" };
  if (activity.busy || activity.quietSince === undefined) {
    return { ok: false, why: `busy: ${activity.reasons?.length ? activity.reasons.join(", ") : "work is running"}` };
  }
  const quietFor = now - activity.quietSince;
  if (quietFor < RECYCLE_QUIET_MS) return { ok: false, why: `quiet for only ${Math.round(quietFor / 1000)}s` };
  return { ok: true };
}

/**
 * One reading in, the next state and what to do out. The supervisor wins a tie: replacing it
 * restarts the server as well, so one cut covers both.
 */
export function decideRecycle(state: RecycleState, r: RecycleReadings, limits: RecycleLimits): { state: RecycleState; action: RecycleAction } {
  const next: RecycleState = {
    supervisorOver: over(r.supervisorMB, limits.supervisorMB) ? state.supervisorOver + 1 : 0,
    serverOver: over(r.serverMB, limits.serverMB) ? state.serverOver + 1 : 0,
    lastRecycleAt: state.lastRecycleAt,
  };
  const target: "supervisor" | "server" | null =
    next.supervisorOver >= RECYCLE_CONFIRM_READINGS ? "supervisor"
      : next.serverOver >= RECYCLE_CONFIRM_READINGS ? "server"
        : null;
  if (!target) return { state: next, action: { kind: "none" } };
  if (state.lastRecycleAt !== null && r.now - state.lastRecycleAt < RECYCLE_COOLDOWN_MS) {
    return { state: next, action: { kind: "wait", target, why: "a recycle ran less than 30 minutes ago" } };
  }
  const quiet = quietEnough(r.activity, r.serverPid, r.now);
  if (!quiet.ok) return { state: next, action: { kind: "wait", target, why: quiet.why } };
  const detail = target === "supervisor"
    ? `the supervisor held ${r.supervisorMB}MB of private bytes (limit ${limits.supervisorMB}MB)`
    : `the server held ${r.serverMB}MB of private bytes (limit ${limits.serverMB}MB)`;
  return {
    state: { supervisorOver: 0, serverOver: 0, lastRecycleAt: r.now },
    action: { kind: target, detail },
  };
}
