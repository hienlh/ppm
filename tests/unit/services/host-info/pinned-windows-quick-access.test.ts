import { describe, expect, test } from "bun:test";
import { getWindowsQuickAccessPinned } from "../../../../src/services/host-info/pinned-windows-quick-access.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";

function runResult(stdout: string, code = 0): RunResult {
  return { stdout, stderr: "", code, timedOut: false };
}

describe("getWindowsQuickAccessPinned", () => {
  test("keeps only Pinned===true items that are real directories", async () => {
    const warnings: string[] = [];
    const pinned = await getWindowsQuickAccessPinned(warnings, {
      run: async () =>
        runResult(
          JSON.stringify([
            { Name: "Desktop", Path: "C:\\Users\\victor\\Desktop", Pinned: true },
            { Name: "Downloads", Path: "C:\\Users\\victor\\Downloads", Pinned: false },
            { Name: "archive.zip", Path: "C:\\Users\\victor\\archive.zip", Pinned: true },
          ]),
        ),
      isDirectory: async (p) => p !== "C:\\Users\\victor\\archive.zip",
    });
    expect(pinned).toEqual([{ name: "Desktop", path: "C:\\Users\\victor\\Desktop", source: "quick-access" }]);
    expect(warnings).toEqual([]);
  });

  test("single-item PowerShell output (not wrapped in []) still parses", async () => {
    const pinned = await getWindowsQuickAccessPinned([], {
      run: async () => runResult(JSON.stringify({ Name: "Desktop", Path: "C:\\Users\\victor\\Desktop", Pinned: true })),
      isDirectory: async () => true,
    });
    expect(pinned).toEqual([{ name: "Desktop", path: "C:\\Users\\victor\\Desktop", source: "quick-access" }]);
  });

  test("no items at all ('[null]' after the @() wrap) yields an empty list, no crash", async () => {
    const pinned = await getWindowsQuickAccessPinned([], { run: async () => runResult("[null]") });
    expect(pinned).toEqual([]);
  });

  test("PowerShell timeout or non-zero exit yields a warning, empty list, never throws", async () => {
    const warnings: string[] = [];
    const pinned = await getWindowsQuickAccessPinned(warnings, { run: async () => runResult("", 1) });
    expect(pinned).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  test("malformed JSON yields a warning, never throws", async () => {
    const warnings: string[] = [];
    const pinned = await getWindowsQuickAccessPinned(warnings, { run: async () => runResult("{not json") });
    expect(pinned).toEqual([]);
    expect(warnings.some((w) => w.includes("JSON parse failed"))).toBe(true);
  });
});
