/**
 * Integration tests for the auto-upgrade feature.
 *
 * Tests:
 * - compareSemver — edge cases including pre-release, partial, invalid
 * - getInstallMethod — detects bun in current test env
 * - checkForUpdate — real npm registry fetch
 * - signalSupervisorUpgrade — with fake status.json in isolated dir
 * - GET /api/upgrade — status endpoint returns version + install method
 * - POST /api/upgrade/apply — guarded by concurrency, binary detection
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import "../../tests/test-setup.ts";

import {
  compareSemver,
  getInstallMethod,
  checkForUpdate,
  applyUpgrade,
  buildUpgradeCommand,
  createLatestVersionCheck,
} from "../../src/services/upgrade.service.ts";
import { app } from "../../src/server/index.ts";

// ─── Isolated PPM_HOME for signalSupervisorUpgrade tests ────────────────
const TEST_PPM_DIR = resolve(tmpdir(), `ppm-test-upgrade-${process.pid}`);

beforeAll(() => {
  mkdirSync(TEST_PPM_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TEST_PPM_DIR, { recursive: true, force: true }); } catch {}
});

async function req(path: string, init?: RequestInit) {
  return app.request(new Request(`http://localhost${path}`, init));
}

// ─── compareSemver ──────────────────────────────────────────────────────

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns -1 when a < b", () => {
    expect(compareSemver("0.8.52", "0.8.53")).toBe(-1);
    expect(compareSemver("0.8.53", "0.9.0")).toBe(-1);
    expect(compareSemver("0.9.99", "1.0.0")).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    expect(compareSemver("0.8.53", "0.8.52")).toBe(1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });

  it("strips pre-release tags and compares base version", () => {
    expect(compareSemver("1.0.0-beta.1", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0-alpha", "1.0.1")).toBe(-1);
    expect(compareSemver("2.0.0-rc.1", "1.9.9")).toBe(1);
  });

  it("handles partial versions (missing patch)", () => {
    // "1.0" → [1, 0, NaN] → NaN ?? 0 → 0, effectively "1.0.0"
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
  });

  it("handles major-only version", () => {
    expect(compareSemver("2", "1.9.9")).toBe(1);
  });
});

// ─── getInstallMethod ───────────────────────────────────────────────────

describe("getInstallMethod", () => {
  it("detects bun or npm in test environment", () => {
    const method = getInstallMethod();
    // In test env running via `bun test`, execPath contains "bun"
    expect(["bun", "npm", "binary"]).toContain(method);
    if (process.execPath.includes("bun")) {
      expect(method).toBe("bun");
    }
  });
});

// ─── checkForUpdate (real network) ──────────────────────────────────────

describe("checkForUpdate", () => {
  it("returns current version and latest from registry", async () => {
    const result = await checkForUpdate();
    expect(result.current).toMatch(/^\d+\.\d+\.\d+/);
    // latest is either a version string or null (if registry unreachable)
    if (result.latest) {
      expect(result.latest).toMatch(/^\d+\.\d+\.\d+/);
    }
    expect(typeof result.available).toBe("boolean");
  });
});

// ─── buildUpgradeCommand (pure) ─────────────────────────────────────────

describe("buildUpgradeCommand", () => {
  it("bun uses the running runtime path", () => {
    const cmd = buildUpgradeCommand("bun", "@hienlh/ppm@9.9.9");
    expect(cmd).toEqual([process.execPath, "install", "-g", "@hienlh/ppm@9.9.9"]);
  });
  it("npm resolves an npm bin and installs globally", () => {
    const cmd = buildUpgradeCommand("npm", "@hienlh/ppm@9.9.9");
    expect(cmd.slice(1)).toEqual(["install", "-g", "@hienlh/ppm@9.9.9"]);
    expect(cmd[0]).toMatch(/npm/);
  });
});

// ─── applyUpgrade regression (bun/npm path — spawn mocked via DI) ────────
// Locks the existing global-install behavior so the binary-dispatch refactor
// can't silently regress it. getInstallMethod() returns "bun" under `bun test`.

describe("applyUpgrade regression (bun/npm)", () => {
  const okSpawn = (() => ({ exited: Promise.resolve(0), stderr: null })) as unknown as typeof Bun.spawn;

  it("happy path returns success + new version, does not spawn a real install", async () => {
    let spawnedCmd: string[] | undefined;
    const spy = ((args: { cmd: string[] }) => {
      spawnedCmd = args.cmd;
      return { exited: Promise.resolve(0), stderr: null };
    }) as unknown as typeof Bun.spawn;
    const res = await applyUpgrade({
      checkFn: async () => ({ available: true, current: "1.0.0", latest: "9.9.9" }),
      spawnFn: spy,
    });
    expect(res).toEqual({ success: true, newVersion: "9.9.9" });
    expect(spawnedCmd).toEqual([process.execPath, "install", "-g", "@hienlh/ppm@9.9.9"]);
  });

  it("returns 'already on latest' when no update available", async () => {
    const res = await applyUpgrade({
      checkFn: async () => ({ available: false, current: "9.9.9", latest: "9.9.9" }),
      spawnFn: okSpawn,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/latest/);
  });

  it("second concurrent call is rejected while one is in progress", async () => {
    let release!: (n: number) => void;
    const slow = (() => ({ exited: new Promise<number>((r) => { release = r; }), stderr: null })) as unknown as typeof Bun.spawn;
    const p1 = applyUpgrade({
      checkFn: async () => ({ available: true, current: "1.0.0", latest: "9.9.9" }),
      spawnFn: slow,
    });
    await new Promise((r) => setTimeout(r, 20)); // let p1 set the in-progress flag + start the slow spawn
    const r2 = await applyUpgrade({
      checkFn: async () => ({ available: true, current: "1.0.0", latest: "9.9.9" }),
      spawnFn: okSpawn,
    });
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/in progress/);
    release(0);
    expect((await p1).success).toBe(true);
  });
});

// ─── createLatestVersionCheck ───────────────────────────────────────────

describe("createLatestVersionCheck", () => {
  const result = (latest: string | null) => ({ available: !!latest, current: "1.0.0", latest });

  it("serves repeat calls from cache within the TTL", async () => {
    let calls = 0;
    const check = createLatestVersionCheck(async () => { calls++; return result("1.2.3"); }, 60_000);
    expect(await check()).toBe("1.2.3");
    expect(await check()).toBe("1.2.3");
    expect(calls).toBe(1);
  });

  it("bypasses a live cache entry when the caller forces a check", async () => {
    let calls = 0;
    let latest = "1.2.3";
    const check = createLatestVersionCheck(async () => { calls++; return result(latest); }, 60_000);
    expect(await check()).toBe("1.2.3");
    latest = "1.2.4"; // published moments after the cached answer was taken
    expect(await check({ force: true })).toBe("1.2.4");
    expect(calls).toBe(2);
  });

  it("re-checks once the TTL expires", async () => {
    let calls = 0;
    const check = createLatestVersionCheck(async () => { calls++; return result("1.2.3"); }, 0);
    await check();
    await check();
    expect(calls).toBe(2);
  });

  it("dedupes concurrent callers into one request", async () => {
    let calls = 0;
    const check = createLatestVersionCheck(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return result("1.2.3");
    }, 60_000);
    expect(await Promise.all([check(), check(), check()])).toEqual(["1.2.3", "1.2.3", "1.2.3"]);
    expect(calls).toBe(1);
  });

  it("keeps the last good answer when the registry becomes unreachable", async () => {
    let latest: string | null = "1.2.3";
    const check = createLatestVersionCheck(async () => result(latest), 0);
    expect(await check()).toBe("1.2.3");
    latest = null; // offline — checkForUpdate reports latest:null
    expect(await check()).toBe("1.2.3");
  });

  it("returns null when the first check fails", async () => {
    const check = createLatestVersionCheck(async () => result(null), 60_000);
    expect(await check()).toBeNull();
  });

  it("throttles retries after a failure instead of refetching every call", async () => {
    let calls = 0;
    const check = createLatestVersionCheck(async () => { calls++; return result(null); }, 60_000);
    await check();
    await check();
    expect(calls).toBe(1);
  });
});

// ─── API: GET /api/upgrade ──────────────────────────────────────────────

describe("GET /api/upgrade", () => {
  it("returns current version and install method", async () => {
    const res = await req("/api/upgrade");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data.currentVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(["bun", "npm", "binary"]).toContain(json.data.installMethod);
    // availableVersion can be null or string
    expect(json.data).toHaveProperty("availableVersion");
  });
});
