// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/build-kill-request.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildKillRequest,
  buildGroupKillRequests,
  isGroupProtected,
} from "../../../src/web/components/system/build-kill-request.ts";
import type { ProcessGroup, ProcessInfo } from "../../../src/types/system-metrics.ts";

function proc(overrides: Partial<ProcessInfo>): ProcessInfo {
  return {
    pid: 4242,
    ppid: 1,
    name: "notepad",
    command: "notepad.exe",
    cpu: 0.5,
    ramMB: 12,
    startedAt: 1_700_000_000_000,
    ppm: false,
    protected: false,
    ...overrides,
  };
}

describe("buildKillRequest", () => {
  it("carries pid and startedAt as the identity guard, tree as passed", () => {
    const req = buildKillRequest(proc({}), false);
    expect(req).toEqual({ pid: 4242, startedAt: 1_700_000_000_000, tree: false });
  });

  it("tree:true is preserved when the checkbox is on", () => {
    const req = buildKillRequest(proc({}), true);
    expect(req.tree).toBe(true);
  });

  it("does not leak unrelated ProcessInfo fields (name, command, cpu) into the request", () => {
    const req = buildKillRequest(proc({ name: "chrome", command: "chrome.exe --secret=abc" }), false);
    expect(Object.keys(req).sort()).toEqual(["pid", "startedAt", "tree"]);
  });

  it("a pid the OS recycled still round-trips its own startedAt, not a stale one", () => {
    const before = buildKillRequest(proc({ pid: 99, startedAt: 1000 }), false);
    const after = buildKillRequest(proc({ pid: 99, startedAt: 2000 }), false);
    expect(before.startedAt).not.toBe(after.startedAt);
  });
});

function group(overrides: Partial<ProcessGroup>): ProcessGroup {
  return { key: "root:100", label: "notion", rootPid: 100, cpu: 0, ramMB: 0, count: 3, ppm: false, pids: [100, 101, 102], ...overrides };
}

describe("buildGroupKillRequests", () => {
  const members = [
    proc({ pid: 100, startedAt: 10 }),
    proc({ pid: 101, ppid: 100, startedAt: 11 }),
    proc({ pid: 102, ppid: 100, startedAt: 12 }),
  ];

  it("an ancestor roll-up becomes one tree kill on its root, carrying the root's startedAt", () => {
    expect(buildGroupKillRequests(group({}), members)).toEqual([{ pid: 100, startedAt: 10, tree: true }]);
  });

  it("an exe bucket (no root) becomes one single-process kill per member", () => {
    const reqs = buildGroupKillRequests(group({ key: "exe:node", rootPid: null }), members);
    expect(reqs).toEqual([
      { pid: 100, startedAt: 10, tree: false },
      { pid: 101, startedAt: 11, tree: false },
      { pid: 102, startedAt: 12, tree: false },
    ]);
  });

  it("a root that already exited (absent from members) falls back to per-member kills", () => {
    const reqs = buildGroupKillRequests(group({}), members.slice(1));
    expect(reqs.map((r) => r.pid)).toEqual([101, 102]);
    expect(reqs.every((r) => r.tree === false)).toBe(true);
  });
});

describe("isGroupProtected", () => {
  it("is true when any member is protected, false when none are", () => {
    expect(isGroupProtected([proc({}), proc({ pid: 7, protected: true })])).toBe(true);
    expect(isGroupProtected([proc({}), proc({ pid: 7 })])).toBe(false);
    expect(isGroupProtected([])).toBe(false);
  });
});
