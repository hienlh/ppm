import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyUsageToQuota, fetchAntigravityUsageViaAgy } from "../../../src/providers/antigravity/antigravity-usage.ts";

// `agy -p /usage --output-format json` as agy 1.5.2 answered it on 2026-11-09, app closed.
const AGY_USAGE = {
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t54%\t2026-11-13T23:45:00Z\n",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.5375659465789795, reset_time: "2026-11-13T23:45:00Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.9392018914222717, reset_time: "2026-11-09T06:27:33Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.001389759941957891, reset_time: "2026-11-13T07:16:43Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-09T09:08:51Z" },
          ],
        },
      ],
    },
  },
};

describe("agyUsageToQuota", () => {
  it("reads agy's groups as the language server's, Gemini first", () => {
    const quota = agyUsageToQuota(AGY_USAGE);
    expect(quota?.response?.groups?.[0]).toEqual({
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5375659465789795, resetTime: "2026-11-13T23:45:00Z" },
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9392018914222717, resetTime: "2026-11-09T06:27:33Z" },
      ],
    });
  });

  it("has nothing to read from a failed or empty answer", () => {
    expect(agyUsageToQuota({ ...AGY_USAGE, status: "ERROR" })).toBeNull();
    expect(agyUsageToQuota({ status: "SUCCESS", command: { data: { groups: [] } } })).toBeNull();
    expect(agyUsageToQuota(null)).toBeNull();
  });
});

describe("fetchAntigravityUsageViaAgy", () => {
  let dir: string;
  const savedExe = process.env.ANTIGRAVITY_AGY_EXE;

  /** A stand-in agy that prints `stdout` and records the arguments it was given. */
  function fakeAgy(stdout: string, exitCode = 0): string {
    const exe = join(dir, "agy");
    writeFileSync(join(dir, "out.json"), stdout);
    writeFileSync(exe, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat "${dir}/out.json"\nexit ${exitCode}\n`);
    chmodSync(exe, 0o755);
    process.env.ANTIGRAVITY_AGY_EXE = exe;
    return exe;
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agy-usage-")); });
  afterEach(() => {
    if (savedExe === undefined) delete process.env.ANTIGRAVITY_AGY_EXE;
    else process.env.ANTIGRAVITY_AGY_EXE = savedExe;
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks agy for /usage as JSON and returns the buckets as utilization", async () => {
    fakeAgy(JSON.stringify(AGY_USAGE));
    const usage = await fetchAntigravityUsageViaAgy();
    expect(await Bun.file(join(dir, "args")).text()).toBe("-p /usage --output-format json\n");
    expect(usage.weekly?.utilization).toBeCloseTo(1 - 0.5375659465789795, 6);
    expect(usage.session?.utilization).toBeCloseTo(1 - 0.9392018914222717, 6);
    expect(usage.session?.resetsAt).toBe("2026-11-09T06:27:33Z");
    expect(usage.weeklyScoped?.map((b) => [b.label, Math.round(b.utilization * 100)])).toEqual([
      ["Claude and GPT models · Weekly", 100],
      ["Claude and GPT models · 5-Hour", 0],
    ]);
  });

  it("fails with agy's own words when it returns no quota", async () => {
    fakeAgy("Error: not signed in. Run `agy` to sign in.", 1);
    await expect(fetchAntigravityUsageViaAgy()).rejects.toThrow("not signed in");
  });
});
