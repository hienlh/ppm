import { describe, test, expect } from "bun:test";
import {
  checkKillAllowed,
  collectDescendants,
  WINDOWS_CRITICAL_NAMES,
  POSIX_CRITICAL_NAMES,
  type KillGuardContext,
} from "../../../../src/services/system-metrics/kill-guard.ts";
import { WIN_DEV_HOST, WIN_SERVER_PID, WIN_RUN_PID } from "./fixtures/process-fixtures.ts";

function ctxFrom(platform: KillGuardContext["platform"], protectedPids: number[]): KillGuardContext {
  return {
    platform,
    protectedPids: new Set(protectedPids),
    ppidOf: new Map(WIN_DEV_HOST.map((p) => [p.pid, p.ppid])),
    startedAtOf: new Map(WIN_DEV_HOST.map((p) => [p.pid, p.startedAt])),
  };
}

// Server 3100 + its parent 3000 are the PPM infra pids on the dev host.
const win = ctxFrom("win32", [WIN_SERVER_PID, WIN_RUN_PID]);

describe("checkKillAllowed — refusal rules in order", () => {
  test("1. invalid pid", () => {
    expect(checkKillAllowed({ pid: 0, name: "x" }, false, win)).toEqual({ allowed: false, reason: "Invalid PID" });
    expect(checkKillAllowed({ pid: -5, name: "x" }, false, win).allowed).toBe(false);
    expect(checkKillAllowed({ pid: 1.5, name: "x" }, false, win).allowed).toBe(false);
  });

  test("2. protected PPM pid", () => {
    const v = checkKillAllowed({ pid: WIN_SERVER_PID, name: "bun" }, false, win);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("bun is a PPM process and cannot be ended");
  });

  test("3. win32 kernel pid 4", () => {
    expect(checkKillAllowed({ pid: 4, name: "System" }, false, win).reason).toBe("Cannot kill an OS kernel process");
  });

  test("4. win32 OS-critical names, matched case-insensitively and extension-free", () => {
    for (const name of WINDOWS_CRITICAL_NAMES) {
      expect(checkKillAllowed({ pid: 77777, name }, false, win).allowed).toBe(false);
    }
    expect(checkKillAllowed({ pid: 900, name: "SvcHost" }, false, win).reason).toBe("SvcHost is an OS-critical process");
    expect(checkKillAllowed({ pid: 2328, name: "dwm" }, false, win).allowed).toBe(false);
  });

  test("5. posix init", () => {
    expect(checkKillAllowed({ pid: 1, name: "systemd" }, false, ctxFrom("linux", [])).reason).toBe("Cannot kill init");
  });

  test("6. posix OS-critical names, including sshd (a remote user's only way back in)", () => {
    for (const name of POSIX_CRITICAL_NAMES) {
      expect(checkKillAllowed({ pid: 5555, name }, false, ctxFrom("darwin", [])).allowed).toBe(false);
    }
    expect(checkKillAllowed({ pid: 812, name: "sshd" }, false, ctxFrom("linux", [])).reason).toBe("sshd is an OS-critical process");
  });

  test("7. ancestor rule: WindowsTerminal and explorer are ancestors of the PPM server → refused even without tree", () => {
    expect(checkKillAllowed({ pid: 2000, name: "WindowsTerminal" }, false, win).reason).toBe("Ending WindowsTerminal would also end the PPM server");
    expect(checkKillAllowed({ pid: 1000, name: "explorer" }, false, win).allowed).toBe(false);
  });

  test("8. tree-intersection rule: a tree kill whose descendants include a protected pid is refused", () => {
    // 3000 is itself protected (rule 2); make a context where only the server is protected
    // so the tree rule is the one that fires for its parent.
    const serverOnly = ctxFrom("win32", [WIN_SERVER_PID]);
    expect(checkKillAllowed({ pid: WIN_RUN_PID, name: "bun" }, true, serverOnly).allowed).toBe(false);
    // …and without tree the ancestor rule still catches it.
    expect(checkKillAllowed({ pid: WIN_RUN_PID, name: "bun" }, false, serverOnly).reason).toBe("Ending bun would also end the PPM server");
  });
});

describe("checkKillAllowed — allowed cases", () => {
  test("explorer is killable when PPM does not descend from it", () => {
    const ctx: KillGuardContext = { ...win, ppidOf: new Map([[1000, 700], [3100, 9999]]), startedAtOf: new Map() };
    expect(checkKillAllowed({ pid: 1000, name: "explorer" }, false, ctx)).toEqual({ allowed: true });
  });

  test("a sibling app tree (Chrome) with tree:true is allowed", () => {
    expect(checkKillAllowed({ pid: 4000, name: "chrome" }, true, win)).toEqual({ allowed: true });
  });

  test("PPM's own descendants are killable — killing a runaway child is the point", () => {
    expect(checkKillAllowed({ pid: 3200, name: "node" }, false, win).allowed).toBe(true);
    expect(checkKillAllowed({ pid: 3200, name: "node" }, true, win).allowed).toBe(true);
    expect(checkKillAllowed({ pid: 3300, name: "bash" }, false, win).allowed).toBe(true);
  });

  test("a sibling shell in the same terminal is killable", () => {
    expect(checkKillAllowed({ pid: 2100, name: "pwsh" }, true, win).allowed).toBe(true);
  });
});

describe("startedAt monotonicity + cycle guards", () => {
  test("a recycled parent pid (started after its child) does not fabricate an ancestor chain", () => {
    const ctx: KillGuardContext = {
      platform: "win32",
      protectedPids: new Set([50]),
      ppidOf: new Map([[50, 40], [40, 30]]),
      // 40 started AFTER 50 → 40 is not really 50's parent any more.
      startedAtOf: new Map([[50, 1000], [40, 5000], [30, 10]]),
    };
    expect(checkKillAllowed({ pid: 40, name: "x" }, false, ctx).allowed).toBe(true);
    expect(checkKillAllowed({ pid: 30, name: "y" }, false, ctx).allowed).toBe(true);
  });

  test("a ppid cycle terminates both walks", () => {
    const ctx: KillGuardContext = {
      platform: "linux",
      protectedPids: new Set([50]),
      ppidOf: new Map([[50, 60], [60, 50], [70, 60]]),
      startedAtOf: new Map(),
    };
    expect(checkKillAllowed({ pid: 70, name: "z" }, true, ctx).allowed).toBe(true);
    expect(collectDescendants(60, ctx).has(50)).toBe(true);
  });
});
