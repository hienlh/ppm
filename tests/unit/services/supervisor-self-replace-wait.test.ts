import { describe, it, expect } from "bun:test";
import { waitForReplacement } from "../../../src/services/supervisor-self-replace-wait.ts";

const noSleep = async () => {};

describe("waitForReplacement", () => {
  it("reports the replacement once status.json names a new supervisor", async () => {
    const pids = [100, 100, 200];
    const r = await waitForReplacement({
      oldPid: 100, readSupervisorPid: () => pids.shift(), exited: () => null, timeoutMs: 5_000, sleep: noSleep,
    });
    expect(r).toEqual({ kind: "replaced", pid: 200 });
  });

  it("gives up as soon as the replacement exits, instead of waiting out the timeout", async () => {
    let polls = 0;
    const start = Date.now();
    const r = await waitForReplacement({
      oldPid: 100,
      readSupervisorPid: () => 100,
      exited: () => (++polls >= 2 ? { code: 3 } : null),
      timeoutMs: 30_000,
      pollMs: 10,
    });
    expect(r).toEqual({ kind: "exited", code: 3 });
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("counts a replacement that took over and then exited as a replacement", async () => {
    const r = await waitForReplacement({
      oldPid: 100, readSupervisorPid: () => 200, exited: () => ({ code: 0 }), timeoutMs: 5_000, sleep: noSleep,
    });
    expect(r).toEqual({ kind: "replaced", pid: 200 });
  });

  it("times out when nothing happens, and ignores an unreadable status", async () => {
    const r = await waitForReplacement({
      oldPid: 100, readSupervisorPid: () => undefined, exited: () => null, timeoutMs: 60, pollMs: 10,
    });
    expect(r).toEqual({ kind: "timeout" });
  });
});
