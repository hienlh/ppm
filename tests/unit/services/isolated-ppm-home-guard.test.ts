import { describe, test, expect, afterEach } from "bun:test";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { isIsolatedPpmHome } from "../../../src/services/ppm-dir.ts";

const ORIGINAL = process.env.PPM_HOME;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL;
});

describe("isIsolatedPpmHome", () => {
  test("false when PPM_HOME is unset (normal production run)", () => {
    delete process.env.PPM_HOME;
    expect(isIsolatedPpmHome()).toBe(false);
  });

  test("false when PPM_HOME just points at the real ~/.ppm", () => {
    process.env.PPM_HOME = resolve(homedir(), ".ppm");
    expect(isIsolatedPpmHome()).toBe(false);
  });

  test("true when PPM_HOME is redirected elsewhere", () => {
    process.env.PPM_HOME = resolve(require("node:os").tmpdir(), "ppm-test-guard");
    expect(isIsolatedPpmHome()).toBe(true);
  });
});

describe("service-manager call sites are guarded", () => {
  const stopSrc = Bun.file(
    resolve(import.meta.dir, "../../../src/cli/commands/stop.ts"),
  );
  const registerSrc = Bun.file(
    resolve(import.meta.dir, "../../../src/services/autostart-register.ts"),
  );

  test("every launchctl bootout / systemctl stop is gated on isIsolatedPpmHome", async () => {
    const src = await stopSrc.text();

    // Each service-manager block is entered only via an autoStatus check that
    // also requires a non-isolated PPM_HOME.
    const guards = src.match(/autoStatus\.enabled && autoStatus\.running && !isIsolatedPpmHome\(\)/g) ?? [];
    const bootouts = src.match(/launchctl", "bootout"/g) ?? [];

    expect(bootouts.length).toBeGreaterThan(0);
    expect(guards.length).toBe(bootouts.length);
  });

  test("killAllByName bails out under an isolated PPM_HOME", async () => {
    const src = await stopSrc.text();
    expect(src).toMatch(/function killAllByName[\s\S]{0,240}?if \(isIsolatedPpmHome\(\)\) return 0;/);
  });

  test("enable/disableAutoStart bail out under an isolated PPM_HOME", async () => {
    const src = await registerSrc.text();
    expect(src).toMatch(/export async function enableAutoStart[^\n]*\n\s*if \(isIsolatedPpmHome\(\)\)/);
    expect(src).toMatch(/export async function disableAutoStart[^\n]*\n\s*if \(isIsolatedPpmHome\(\)\)/);
  });
});
