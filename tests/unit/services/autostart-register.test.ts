/**
 * The isolation guard in `autostart-register`, and the pure status mapping around it.
 *
 * `tests/test-setup.ts` points PPM_HOME at a temp directory for every run, so
 * `isIsolatedPpmHome()` is true throughout and `enableAutoStart`/`disableAutoStart`
 * refuse to touch the service manager. That refusal is what these tests guard: a suite
 * run must not overwrite or unlink the developer's real ppm.service, plist, or
 * scheduled task. `beforeAll` refuses to run at all if that isolation is missing —
 * `bunfig.toml`'s preload resolves from the invocation cwd, so running this file by
 * absolute path from elsewhere would otherwise register autostart on port 19999 and
 * then delete the user's real entry.
 *
 * These assert the refusal itself, not the machine: on a runner nothing is registered,
 * so "the file is still absent afterwards" would pass with the guard deleted.
 *
 * Real registration is covered on CI by the `autostart-integration` job in
 * .github/workflows/test.yml, which drives the CLI outside this isolation, asserts
 * `status --json` actually flips, and then asserts the runner is left clean.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import {
  enableAutoStart,
  disableAutoStart,
  getAutoStartStatus,
  mapMacStatus,
} from "../../../src/services/autostart-register.ts";
import { isIsolatedPpmHome } from "../../../src/services/ppm-dir.ts";
import { getPlistPath, getServicePath, getVbsPath } from "../../../src/services/autostart-generator.ts";

const TEST_CONFIG = {
  port: 19999, // Use high port to avoid conflicts
  host: "127.0.0.1",
  share: false,
};

/** Where this platform keeps its autostart entry, or undefined where we register none. */
function entryPath(): string | undefined {
  if (process.platform === "darwin") return getPlistPath();
  if (process.platform === "linux") return getServicePath();
  if (process.platform === "win32") return getVbsPath();
  return undefined;
}

beforeAll(() => {
  if (!isIsolatedPpmHome()) {
    throw new Error(
      "refusing to run: PPM_HOME is not isolated, so these calls would hit the real service manager",
    );
  }
});

describe("autostart with an isolated PPM_HOME", () => {
  test("enable refuses instead of writing the real entry", async () => {
    const path = entryPath();
    const before = path ? existsSync(path) : false;

    const result = await enableAutoStart(TEST_CONFIG);

    // A real registration returns the path it wrote; the refusal is returned in its place.
    expect(result).toContain("PPM_HOME");
    expect(result).not.toBe(path);
    if (path) expect(existsSync(path)).toBe(before);
  });

  test("disable refuses and says so, rather than reporting success", async () => {
    // On a developer machine this path holds the live PPM entry, and disable is the call
    // that used to unlink it and stop the service. The returned string is the assertion:
    // `disableAutoStart` used to return void, so the CLI printed "Auto-start disabled"
    // whether it had disabled anything or not.
    const path = entryPath();
    const before = path ? existsSync(path) : false;

    const result = await disableAutoStart();

    expect(result).toContain("PPM_HOME");
    if (path) expect(existsSync(path)).toBe(before);
  });
});

describe("cross-platform autostart", () => {
  test("getAutoStartStatus returns valid structure on any platform", () => {
    // Also covers the probe fallback: on a machine with no systemctl/launchctl/schtasks
    // — a container, say — this used to throw out of `Bun.spawnSync`, taking `ppm start`
    // and `ppm stop` down with it.
    const status = getAutoStartStatus();
    expect(typeof status.enabled).toBe("boolean");
    expect(typeof status.running).toBe("boolean");
    expect(typeof status.platform).toBe("string");
    expect(typeof status.details).toBe("string");
  });

  test("mapMacStatus keeps registration and running state independent", () => {
    // The regression: tying `enabled` to the loaded job made "enabled && !running"
    // unsatisfiable, so `ppm start` could never hand off to launchd. Pure, so it runs
    // on every platform and in Docker rather than only on the one Mac.
    const plist = "/tmp/ppm.plist";
    expect(mapMacStatus(true, false, plist)).toMatchObject({
      enabled: true,
      running: false,
      servicePath: plist,
      details: "Plist exists but not loaded",
    });
    expect(mapMacStatus(true, true, plist)).toMatchObject({ enabled: true, running: true });
    expect(mapMacStatus(false, false, plist)).toMatchObject({
      enabled: false,
      running: false,
      servicePath: null,
      details: "Not configured",
    });
  });
});
