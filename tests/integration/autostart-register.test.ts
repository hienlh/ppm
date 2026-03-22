/**
 * Integration tests for autostart-register.
 *
 * These tests perform REAL OS operations (write service files, register/unregister).
 * They are platform-specific — each test block only runs on its target OS.
 * Designed for GitHub Actions CI matrix (macOS/Linux/Windows runners).
 *
 * IMPORTANT: Tests clean up after themselves (disable in afterEach).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import {
  enableAutoStart,
  disableAutoStart,
  getAutoStartStatus,
} from "../../src/services/autostart-register.ts";
import { getPlistPath, getServicePath, getVbsPath } from "../../src/services/autostart-generator.ts";

const TEST_CONFIG = {
  port: 19999, // Use high port to avoid conflicts
  host: "127.0.0.1",
  share: false,
};

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWindows = process.platform === "win32";

// Always clean up after each test
afterEach(async () => {
  try { await disableAutoStart(); } catch {}
});

// ─── macOS (launchd) ────────────────────────────────────────────────────

describe.if(isMac)("macOS autostart (launchd)", () => {
  test("enable creates plist file", async () => {
    const servicePath = await enableAutoStart(TEST_CONFIG);
    expect(servicePath).toBe(getPlistPath());
    expect(existsSync(getPlistPath())).toBe(true);
  });

  test("status shows enabled after enable", async () => {
    await enableAutoStart(TEST_CONFIG);
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(true);
    expect(status.platform).toContain("darwin");
    expect(status.servicePath).toBe(getPlistPath());
  });

  test("disable removes plist file", async () => {
    await enableAutoStart(TEST_CONFIG);
    await disableAutoStart();
    expect(existsSync(getPlistPath())).toBe(false);
  });

  test("status shows disabled after disable", async () => {
    await enableAutoStart(TEST_CONFIG);
    await disableAutoStart();
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(false);
  });

  test("enable is idempotent (can re-enable)", async () => {
    await enableAutoStart(TEST_CONFIG);
    // Re-enable should not throw
    const servicePath = await enableAutoStart({ ...TEST_CONFIG, port: 29999 });
    expect(existsSync(servicePath)).toBe(true);
  });

  test("disable is idempotent (can re-disable)", async () => {
    // Disable without prior enable should not throw
    await disableAutoStart();
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(false);
  });
});

// ─── Linux (systemd) ───────────────────────────────────────────────────

describe.if(isLinux)("Linux autostart (systemd)", () => {
  test("enable creates service file", async () => {
    const servicePath = await enableAutoStart(TEST_CONFIG);
    expect(servicePath).toBe(getServicePath());
    expect(existsSync(getServicePath())).toBe(true);
  });

  test("status shows enabled after enable", async () => {
    await enableAutoStart(TEST_CONFIG);
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(true);
    expect(status.platform).toContain("linux");
    expect(status.servicePath).toBe(getServicePath());
  });

  test("disable removes service file", async () => {
    await enableAutoStart(TEST_CONFIG);
    await disableAutoStart();
    expect(existsSync(getServicePath())).toBe(false);
  });

  test("status shows disabled after disable", async () => {
    await enableAutoStart(TEST_CONFIG);
    await disableAutoStart();
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(false);
  });

  test("enable is idempotent", async () => {
    await enableAutoStart(TEST_CONFIG);
    const servicePath = await enableAutoStart({ ...TEST_CONFIG, port: 29999 });
    expect(existsSync(servicePath)).toBe(true);
  });

  test("disable is idempotent", async () => {
    await disableAutoStart();
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(false);
  });
});

// ─── Windows (Task Scheduler) ───────────────────────────────────────────

describe.if(isWindows)("Windows autostart (Task Scheduler)", () => {
  test("enable creates VBS wrapper", async () => {
    const servicePath = await enableAutoStart(TEST_CONFIG);
    expect(servicePath).toBe(getVbsPath());
    expect(existsSync(getVbsPath())).toBe(true);
  });

  test("status shows enabled after enable", async () => {
    await enableAutoStart(TEST_CONFIG);
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(true);
    expect(status.platform).toContain("windows");
  });

  test("disable removes VBS wrapper", async () => {
    await enableAutoStart(TEST_CONFIG);
    await disableAutoStart();
    expect(existsSync(getVbsPath())).toBe(false);
  });

  test("status shows disabled after disable", async () => {
    await enableAutoStart(TEST_CONFIG);
    await disableAutoStart();
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(false);
  });

  test("enable is idempotent", async () => {
    await enableAutoStart(TEST_CONFIG);
    const servicePath = await enableAutoStart({ ...TEST_CONFIG, port: 29999 });
    expect(existsSync(servicePath)).toBe(true);
  });

  test("disable is idempotent", async () => {
    await disableAutoStart();
    const status = getAutoStartStatus();
    expect(status.enabled).toBe(false);
  });
});

// ─── Cross-platform ─────────────────────────────────────────────────────

describe("cross-platform autostart", () => {
  test("getAutoStartStatus returns valid structure on any platform", () => {
    const status = getAutoStartStatus();
    expect(typeof status.enabled).toBe("boolean");
    expect(typeof status.running).toBe("boolean");
    expect(typeof status.platform).toBe("string");
    expect(typeof status.details).toBe("string");
  });

  test("enable and disable round-trip works", async () => {
    if (!isMac && !isLinux && !isWindows) {
      // Skip on unsupported platforms
      return;
    }
    await enableAutoStart(TEST_CONFIG);
    const afterEnable = getAutoStartStatus();
    expect(afterEnable.enabled).toBe(true);

    await disableAutoStart();
    const afterDisable = getAutoStartStatus();
    expect(afterDisable.enabled).toBe(false);
  });
});
