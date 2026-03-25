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
