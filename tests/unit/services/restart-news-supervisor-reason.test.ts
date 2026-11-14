/**
 * The supervisor's start-reason decisions, path by path: what each server exit means (respawn now,
 * after a backoff, or not at all) and the reason the next server is given; and why the first
 * server, a resumed one, a revived one and the one after a failed self-replace start. A request
 * file left by `ppm restart --reason` is read only where someone asked for the restart.
 */
import { describe, expect, it } from "bun:test";
import type { StartReason } from "../../../src/services/restart-news/start-reason.ts";
import {
  BOOT_WINDOW_S, decideServerExit, initialStartReason, isUpgradeFailed, restartWithoutChildReason, resumeAfterPauseReason,
  resumeAfterStopReason, REVIVE_REASON, UPGRADE_FAILED_REASON, type ServerExit, type ServerExitDecision,
} from "../../../src/services/restart-news/supervisor-start-reason.ts";

const base: ServerExit = { exitCode: 1, signal: "none", upForS: 30, stopped: false, shuttingDown: false, healthKill: false, restartRequested: false };

/** A request file reader that counts how often it was asked. */
function request(r: StartReason | null) {
  const spy = { calls: 0, take: () => { spy.calls++; return r; } };
  return spy;
}

describe("a server's exit", () => {
  const cases: Array<{ name: string; exit: Partial<ServerExit>; req: StartReason | null; want: ServerExitDecision; reads: boolean }> = [
    { name: "the supervisor is in its stopped state", exit: { stopped: true, exitCode: 0 }, req: null, want: { action: "stay_down" }, reads: false },
    { name: "the supervisor is shutting down or upgrading", exit: { shuttingDown: true, exitCode: 1 }, req: null, want: { action: "stay_down" }, reads: false },
    {
      name: "the server asked for a restart (exit 42)", exit: { exitCode: 42 }, req: null, reads: true,
      want: { action: "respawn_now", reason: { kind: "manual", detail: "the server asked to be restarted" } },
    },
    {
      name: "ppm restart, ended with SIGTERM (exit 0)", exit: { exitCode: 0, restartRequested: true }, req: null, reads: true,
      want: { action: "respawn_now", reason: { kind: "manual" } },
    },
    {
      name: "ppm restart --reason, ended with SIGTERM", exit: { exitCode: 0, restartRequested: true }, req: { kind: "manual", detail: "nightly" }, reads: true,
      want: { action: "respawn_now", reason: { kind: "manual", detail: "nightly" } },
    },
    {
      name: "ppm restart on Windows, ended with a hard kill (exit 1)", exit: { exitCode: 1, restartRequested: true }, req: null, reads: true,
      want: { action: "respawn_now", reason: { kind: "manual" } },
    },
    {
      name: "a memory recycle asked for with ppm restart --reason recycle", exit: { exitCode: 1, restartRequested: true }, req: { kind: "recycle", detail: "RAM 92%" }, reads: true,
      want: { action: "respawn_now", reason: { kind: "recycle", detail: "RAM 92%" } },
    },
    {
      name: "the health check's SIGTERM (exit 0)", exit: { exitCode: 0, healthKill: true }, req: { kind: "manual", detail: "not ours" }, reads: false,
      want: { action: "respawn_now", reason: { kind: "watchdog", detail: "the server stopped answering health checks and was stopped" } },
    },
    {
      name: "the health check's hard kill", exit: { exitCode: null, signal: "SIGKILL", healthKill: true, upForS: 900 }, req: { kind: "manual" }, reads: false,
      want: { action: "respawn_after_backoff", reason: { kind: "watchdog", detail: "the server stopped answering health checks and was killed after 900s" } },
    },
    {
      name: "a crash with its exit code", exit: { exitCode: 3, upForS: 12 }, req: { kind: "manual", detail: "left over" }, reads: false,
      want: { action: "respawn_after_backoff", reason: { kind: "crash", detail: "exit 3, signal none, after 12s" } },
    },
    {
      name: "a crash by signal", exit: { exitCode: null, signal: "SIGSEGV", upForS: 5 }, req: null, reads: false,
      want: { action: "respawn_after_backoff", reason: { kind: "crash", detail: "exit null, signal SIGSEGV, after 5s" } },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const req = request(c.req);
      expect(decideServerExit({ ...base, ...c.exit }, req.take)).toEqual(c.want);
      // Only a restart someone asked for may wear the request file.
      expect(req.calls > 0).toBe(c.reads);
    });
  }

  it("a request reader that throws falls back instead of failing the respawn", () => {
    expect(decideServerExit({ ...base, exitCode: 42 }, () => { throw new Error("EACCES"); }))
      .toEqual({ action: "respawn_now", reason: { kind: "manual", detail: "the server asked to be restarted" } });
  });
});

describe("the other starts", () => {
  it("resume after repeated crashes names the last crash, unless a reason was given", () => {
    const last: StartReason = { kind: "crash", detail: "exit 3, signal none, after 2s" };
    expect(resumeAfterPauseReason(last, () => null)).toEqual({ kind: "manual", detail: "resumed after repeated crashes (last: exit 3, signal none, after 2s)" });
    expect(resumeAfterPauseReason(last, () => ({ kind: "manual", detail: "fixed the config" }))).toEqual({ kind: "manual", detail: "fixed the config" });
  });

  it("resume after ppm stop, and a restart with no server running", () => {
    expect(resumeAfterStopReason(() => null)).toEqual({ kind: "manual", detail: "resumed after ppm stop" });
    expect(resumeAfterStopReason(() => ({ kind: "recycle" }))).toEqual({ kind: "recycle" });
    expect(restartWithoutChildReason(() => null)).toEqual({ kind: "manual" });
  });

  it("a revive and a failed self-replace carry fixed reasons, and the failed upgrade is recognisable", () => {
    expect(REVIVE_REASON.kind).toBe("unknown");
    expect(UPGRADE_FAILED_REASON.kind).toBe("upgrade");
    expect(isUpgradeFailed(UPGRADE_FAILED_REASON)).toBe(true);
    expect(isUpgradeFailed({ kind: "upgrade" })).toBe(false);
    expect(isUpgradeFailed(null)).toBe(false);
  });
});

describe("the supervisor's first server", () => {
  const first = (o: { isUpgrade?: boolean; uptimeS?: number | null; req?: StartReason | null }) => {
    const req = request(o.req ?? null);
    return { reason: initialStartReason({ isUpgrade: !!o.isUpgrade, uptimeS: o.uptimeS === undefined ? 3600 : o.uptimeS, takeRequest: req.take }), req };
  };

  it("an upgrade, without reading the request", () => {
    const { reason, req } = first({ isUpgrade: true, req: { kind: "manual" } });
    expect(reason).toEqual({ kind: "upgrade" });
    expect(req.calls).toBe(0);
  });

  it("a restart someone asked for wins over the boot window", () => {
    expect(first({ uptimeS: 60, req: { kind: "watchdog", detail: "RAM" } }).reason).toEqual({ kind: "watchdog", detail: "RAM" });
  });

  it("inside the boot window it is a boot; past it, or with no uptime, a start", () => {
    expect(first({ uptimeS: 120 }).reason).toEqual({ kind: "boot", detail: "the machine started 2 min earlier" });
    expect(first({ uptimeS: BOOT_WINDOW_S + 1 }).reason.kind).toBe("manual");
    expect(first({ uptimeS: null }).reason).toEqual({ kind: "manual", detail: "PPM was started (ppm start, or its service starting it again)" });
  });
});
