import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  swapBinaryAndWeb,
  cleanupStaleBinaryUpgradeArtifacts,
  OLD_SUFFIX,
} from "../../../src/services/binary-upgrade-swap.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-swap-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

/** Build a fake install dir + a fresh payload dir. binName varies per platform. */
function scaffold(binName: string) {
  const binDir = join(root, "bin");
  const payload = join(root, "payload");
  mkdirSync(join(binDir, "web"), { recursive: true });
  mkdirSync(join(payload, "web"), { recursive: true });
  writeFileSync(join(binDir, binName), "OLD-BINARY");
  writeFileSync(join(binDir, "web", "old.html"), "old");
  writeFileSync(join(payload, binName), "NEW-BINARY");
  writeFileSync(join(payload, "web", "index.html"), "new");
  return { binDir, payload, execPath: join(binDir, binName), webDir: join(binDir, "web") };
}

describe("swapBinaryAndWeb — Unix", () => {
  it("overwrites binary in place and swaps web, leaving no .old", () => {
    const { payload, execPath, webDir } = scaffold("ppm");
    swapBinaryAndWeb(payload, execPath, webDir, "linux");
    expect(readFileSync(execPath, "utf8")).toBe("NEW-BINARY");
    expect(existsSync(join(webDir, "index.html"))).toBe(true);
    expect(existsSync(join(webDir, "old.html"))).toBe(false);
    expect(existsSync(webDir + OLD_SUFFIX)).toBe(false);
  });
});

describe("swapBinaryAndWeb — Windows (via platform param)", () => {
  it("renames running exe to .old and installs new exe", () => {
    const { payload, execPath, webDir } = scaffold("ppm.exe");
    swapBinaryAndWeb(payload, execPath, webDir, "win32");
    expect(readFileSync(execPath, "utf8")).toBe("NEW-BINARY");
    expect(existsSync(execPath + OLD_SUFFIX)).toBe(true);
    expect(readFileSync(execPath + OLD_SUFFIX, "utf8")).toBe("OLD-BINARY");
    expect(existsSync(join(webDir, "index.html"))).toBe(true);
    expect(existsSync(join(webDir, "old.html"))).toBe(false);
  });
});

describe("cleanupStaleBinaryUpgradeArtifacts", () => {
  it("removes ppm.exe.old and web.old on win32", () => {
    const binDir = join(root, "bin");
    mkdirSync(join(binDir, "web.old"), { recursive: true });
    writeFileSync(join(binDir, "ppm.exe.old"), "stale");
    writeFileSync(join(binDir, "web.old", "x"), "stale");
    cleanupStaleBinaryUpgradeArtifacts(binDir, "win32");
    expect(existsSync(join(binDir, "ppm.exe.old"))).toBe(false);
    expect(existsSync(join(binDir, "web.old"))).toBe(false);
  });
  it("is a no-op on non-win32", () => {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "ppm.exe.old"), "stale");
    cleanupStaleBinaryUpgradeArtifacts(binDir, "linux");
    expect(existsSync(join(binDir, "ppm.exe.old"))).toBe(true);
  });
  it("does not throw when nothing to clean", () => {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    expect(() => cleanupStaleBinaryUpgradeArtifacts(binDir, "win32")).not.toThrow();
  });
});
