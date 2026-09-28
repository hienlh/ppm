import { describe, test, expect } from "bun:test";
import {
  selfUnitChain, serviceRefusals, checkServiceActionAllowed, isPlausibleUnitName, CRITICAL_UNITS,
} from "../../../../src/services/system-services/service-guard.ts";
import { SERVICE_ACTIONS } from "../../../../src/types/system-services.ts";

/**
 * What the kernel actually writes, newline included. The argument is the *file's
 * contents*, not a path: it comes straight from `readSelfCgroup()`, which is an
 * untrimmed `readFileSync`. A fixture that hand-strips the terminator tests a
 * string production never sees, and passes while the guard is inoperative.
 */
const PPM_CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ppm.service\n";
const ctx = { selfCgroup: PPM_CGROUP };

describe("selfUnitChain", () => {
  test("reads PPM's own units off its cgroup path, slices excluded", () => {
    expect(selfUnitChain(PPM_CGROUP)).toEqual(["user@1000.service", "ppm.service"]);
  });

  test("the line terminator does not cost the innermost unit", () => {
    // The whole guard hangs off this: `"ppm.service\n".endsWith(".service")` is false, so a
    // direct split drops PPM's own unit and every refusal with it.
    expect(selfUnitChain(PPM_CGROUP)).toContain("ppm.service");
  });

  test("a system-wide PPM and a bare scope are handled too", () => {
    expect(selfUnitChain("0::/system.slice/ppm.service\n")).toEqual(["ppm.service"]);
    expect(selfUnitChain("0::/user.slice/app.slice/app-code-123.scope\n")).toEqual(["app-code-123.scope"]);
  });

  test("cgroup v1 is one line per controller, and only systemd's describes the unit tree", () => {
    const v1 =
      "12:pids:/user.slice/user-1000.slice/user@1000.service/app.slice/ppm.service\n" +
      "11:memory:/user.slice/user-1000.slice/user@1000.service/app.slice/ppm.service\n" +
      "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/ppm.service\n";
    expect(selfUnitChain(v1)).toEqual(["user@1000.service", "ppm.service"]);
  });

  test("no cgroup means no dynamic refusals, never a crash", () => {
    expect(selfUnitChain(null)).toEqual([]);
    expect(selfUnitChain("")).toEqual([]);
    expect(selfUnitChain("0::\n")).toEqual([]);
  });
});

describe("serviceRefusals", () => {
  test("PPM's own unit cannot be stopped, restarted or disabled", () => {
    const refused = serviceRefusals("ppm.service", "user", ctx);
    expect(Object.keys(refused).sort()).toEqual(["disable", "restart", "stop"]);
    expect(refused.stop).toContain("PPM itself");
  });

  test("starting or enabling PPM's own unit is harmless and stays allowed", () => {
    const refused = serviceRefusals("ppm.service", "user", ctx);
    expect(refused.start).toBeUndefined();
    expect(refused.enable).toBeUndefined();
  });

  test("the user manager PPM runs under is refused with its own wording", () => {
    const refused = serviceRefusals("user@1000.service", "system", ctx);
    expect(refused.stop).toContain("manager PPM runs under");
  });

  test("the system's load-bearing units are refused", () => {
    for (const unit of CRITICAL_UNITS) {
      expect(serviceRefusals(unit, "system", ctx).stop).toBeTruthy();
      expect(serviceRefusals(unit, "system", ctx).start).toBeUndefined();
    }
  });

  test("an ordinary unit refuses nothing", () => {
    expect(serviceRefusals("sshd.service", "system", ctx)).toEqual({});
  });

  test("with no cgroup, only the static list applies — PPM's unit is NOT guessed by name", () => {
    const blind = { selfCgroup: null };
    expect(serviceRefusals("ppm.service", "user", blind)).toEqual({});
    expect(serviceRefusals("dbus.service", "system", blind).stop).toBeTruthy();
  });
});

describe("checkServiceActionAllowed", () => {
  test("the verdict is exactly what the row's refused map says — one source, not two lists", () => {
    for (const unit of ["ppm.service", "user@1000.service", "sshd.service", "dbus.service"]) {
      const refused = serviceRefusals(unit, "system", ctx);
      for (const action of SERVICE_ACTIONS) {
        const verdict = checkServiceActionAllowed(unit, "system", action, ctx);
        expect(verdict.allowed).toBe(refused[action] === undefined);
        if (!verdict.allowed) expect(verdict.reason).toBe(refused[action]);
      }
    }
  });

  test("an action that is not an action is refused before anything else", () => {
    expect(checkServiceActionAllowed("sshd.service", "system", "rm -rf" as never, ctx).allowed).toBe(false);
  });

  test("a unit name with a slash or whitespace never reaches systemctl", () => {
    for (const bad of ["../../etc/passwd", "a b.service", "/etc/shadow", "", "noextension", "a".repeat(300) + ".service"]) {
      expect(checkServiceActionAllowed(bad, "system", "start", ctx).allowed).toBe(false);
    }
    expect(isPlausibleUnitName("user@1000.service")).toBe(true);
    expect(isPlausibleUnitName("home-thawngho.mount")).toBe(true);
  });
});
