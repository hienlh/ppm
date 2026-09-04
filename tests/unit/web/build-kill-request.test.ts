// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/build-kill-request.test.ts
import { describe, it, expect } from "bun:test";
import { buildKillRequest } from "../../../src/web/components/system/build-kill-request.ts";
import type { ProcessInfo } from "../../../src/types/system-metrics.ts";

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
