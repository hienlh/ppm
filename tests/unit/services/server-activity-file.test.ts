import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextServerActivity, readServerActivity, removeOtherServerActivity, removeServerActivity, serverActivityPath,
  writeServerActivity,
} from "../../../src/services/server-activity-file.ts";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "ppm-activity-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });

const none = { busyChats: 0, activeTerminals: 0, remoteDesktopSessions: 0 };

describe("nextServerActivity", () => {
  it("is busy, with reasons, while anything a restart would cut is running", () => {
    const a = nextServerActivity(7, 1000, { busyChats: 2, activeTerminals: 1, remoteDesktopSessions: 1 }, null);
    expect(a).toMatchObject({ pid: 7, at: 1000, busy: true });
    expect(a.quietSince).toBeUndefined();
    expect(a.reasons).toEqual([
      "2 chat(s) working",
      "1 terminal(s) printed in the last 15 min",
      "1 remote desktop session(s) open",
    ]);
  });

  it("counts quiet time from the first quiet tick and keeps it while quiet", () => {
    const first = nextServerActivity(7, 1000, none, null);
    expect(first).toEqual({ pid: 7, at: 1000, busy: false, quietSince: 1000 });
    const second = nextServerActivity(7, 31_000, none, first);
    expect(second.quietSince).toBe(1000);
  });

  it("restarts the quiet clock after any busy tick", () => {
    const quiet = nextServerActivity(7, 1000, none, null);
    const busy = nextServerActivity(7, 31_000, { ...none, busyChats: 1 }, quiet);
    const again = nextServerActivity(7, 61_000, none, busy);
    expect(again.quietSince).toBe(61_000);
  });
});

describe("the report file", () => {
  it("round-trips, and is read only for the pid it names", () => {
    const dir = scratch();
    writeServerActivity(dir, { pid: 7, at: 5, busy: false, quietSince: 1 });
    expect(readServerActivity(dir, 7)).toEqual({ pid: 7, at: 5, busy: false, quietSince: 1 });
    expect(readServerActivity(dir, 8)).toBeNull();
  });

  it("reads a damaged or mislabelled file as no report", () => {
    const dir = scratch();
    writeFileSync(serverActivityPath(dir, 7), "{not json");
    expect(readServerActivity(dir, 7)).toBeNull();
    writeFileSync(serverActivityPath(dir, 7), JSON.stringify({ pid: 9, at: 1, busy: false }));
    expect(readServerActivity(dir, 7)).toBeNull();
  });

  it("is removed by its server, and earlier servers' reports by the next one", () => {
    const dir = scratch();
    writeServerActivity(dir, { pid: 1, at: 1, busy: true });
    writeServerActivity(dir, { pid: 2, at: 1, busy: true });
    writeFileSync(join(dir, "unrelated.json"), "{}");
    removeOtherServerActivity(dir, 2);
    expect(readdirSync(dir).sort()).toEqual(["server-activity.2.json", "unrelated.json"]);
    removeServerActivity(dir, 2);
    expect(existsSync(serverActivityPath(dir, 2))).toBe(false);
  });
});
