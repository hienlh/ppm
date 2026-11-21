import { describe, expect, it } from "bun:test";
import { isRecordedProcess, recordedProcesses } from "../../../src/services/supervisor-watchdog/recorded-pid.ts";

describe("isRecordedProcess", () => {
  it("takes a process started after the record was written for a reused pid", () => {
    // Fast Startup: uptime does not reset, but the stranger started after the dead run's last write.
    expect(isRecordedProcess(true, 10_000, 20_000)).toBe(true);
    expect(isRecordedProcess(true, 21_999, 20_000)).toBe(true);
    expect(isRecordedProcess(true, 30_000, 20_000)).toBe(false);
    expect(isRecordedProcess(false, 10_000, 20_000)).toBe(false);
  });

  it("falls back to liveness when a time is unknown", () => {
    expect(isRecordedProcess(true, undefined, 20_000)).toBe(true);
    expect(isRecordedProcess(true, 30_000, null)).toBe(true);
  });
});

describe("recordedProcesses", () => {
  it("keeps this test process when it was recorded after it started, and drops a dead pid", async () => {
    const dead = 2 ** 30;
    const now = Date.now();
    expect(await recordedProcesses([process.pid, dead], now)).toEqual(new Set([process.pid]));
    if (process.platform === "win32") {
      // Recorded long before this process started: a reused pid as far as the record knows.
      expect(await recordedProcesses([process.pid], now - 24 * 60 * 60_000)).toEqual(new Set());
    }
  });
});
