import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMacosFinderFavoritesPinned } from "../../../../src/services/host-info/pinned-macos-finder-favorites.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";

const fixtureXml = readFileSync(
  join(import.meta.dir, "../../../fixtures/host-info/favorite-items.sfl3.xml"),
  "utf-8",
);

function runResult(stdout: string, code = 0): RunResult {
  return { stdout, stderr: "", code, timedOut: false };
}

describe("getMacosFinderFavoritesPinned", () => {
  test("resolves the URL fast path and the Bookmark slow path, skips items with neither", async () => {
    const warnings: string[] = [];
    const pinned = await getMacosFinderFavoritesPinned("/Users/victor", warnings, {
      fileExists: async () => true,
      run: async (argv) => (argv[0] === "plutil" ? runResult(fixtureXml) : runResult("", 1)),
    });

    expect(pinned).toEqual([
      { name: "Projects", path: "/home/victor/Projects", source: "finder-favorites" },
      { name: "Documents (moved)", path: "/Users/victor/Documents", source: "finder-favorites" },
    ]);
    expect(warnings).toEqual([]); // the "Untitled" item (no URL/Bookmark) is skipped silently, not a warning
  });

  test("no .sfl2/.sfl3/.sfl4 file found yields a remediation warning, empty list", async () => {
    const warnings: string[] = [];
    const pinned = await getMacosFinderFavoritesPinned("/Users/victor", warnings, { fileExists: async () => false });
    expect(pinned).toEqual([]);
    expect(warnings.some((w) => w.includes("Full Disk Access"))).toBe(true);
  });

  test("plutil non-zero exit (TCC denial) yields a remediation warning, never throws", async () => {
    const warnings: string[] = [];
    const pinned = await getMacosFinderFavoritesPinned("/Users/victor", warnings, {
      fileExists: async () => true,
      run: async () => runResult("", 1),
    });
    expect(pinned).toEqual([]);
    expect(warnings.some((w) => w.includes("Full Disk Access"))).toBe(true);
  });

  test("unparsable plist yields a warning, never throws", async () => {
    const warnings: string[] = [];
    const pinned = await getMacosFinderFavoritesPinned("/Users/victor", warnings, {
      fileExists: async () => true,
      run: async () => runResult("<not-a-plist>"),
    });
    expect(pinned).toEqual([]);
    expect(warnings.some((w) => w.includes("verify against a real macOS sample"))).toBe(true);
  });
});
