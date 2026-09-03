/**
 * `ppm start` must decide correctly when to hand the supervisor to the OS
 * service manager. Regression for the macOS bug where `enabled` and `running`
 * were both derived from "plist loaded", making `enabled && !running`
 * unsatisfiable — so the launchd path never ran and a directly spawned
 * supervisor died with the Terminal window that ran `ppm start`.
 */
import { describe, test, expect } from "bun:test";
import { shouldStartViaService } from "../../../src/services/autostart-register.ts";

describe("shouldStartViaService", () => {
  describe("darwin", () => {
    test("always uses launchd — Terminal.app kills directly spawned trees on window close", () => {
      expect(shouldStartViaService("darwin", { enabled: false, running: false }, false)).toBe(true);
      expect(shouldStartViaService("darwin", { enabled: true, running: false }, false)).toBe(true);
      // Loaded job but port was free → job is dead/throttled; re-bootstrap it.
      expect(shouldStartViaService("darwin", { enabled: true, running: true }, false)).toBe(true);
    });
  });

  describe("linux", () => {
    test("uses systemd only when the unit is registered but inactive", () => {
      expect(shouldStartViaService("linux", { enabled: true, running: false }, false)).toBe(true);
    });

    test("spawns directly on first run (no unit yet)", () => {
      expect(shouldStartViaService("linux", { enabled: false, running: false }, false)).toBe(false);
    });

    test("does not re-enable an already active unit", () => {
      expect(shouldStartViaService("linux", { enabled: true, running: true }, false)).toBe(false);
    });
  });

  test("windows never uses a service manager from `ppm start`", () => {
    expect(shouldStartViaService("win32", { enabled: true, running: false }, false)).toBe(false);
  });

  test("isolated PPM_HOME never touches the real service manager", () => {
    expect(shouldStartViaService("darwin", { enabled: true, running: false }, true)).toBe(false);
    expect(shouldStartViaService("linux", { enabled: true, running: false }, true)).toBe(false);
  });
});
