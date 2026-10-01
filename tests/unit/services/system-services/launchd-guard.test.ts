/** Which launchd actions PPM refuses: the system domain, app instances, its own job, macOS's jobs. */
import { describe, expect, test } from "bun:test";
import {
  ancestorsOf, appInstanceReason, checkLaunchdActionAllowed, isPlausibleLaunchdLabel, launchdRefusals,
  NOT_ROOT_REASON, selfJobLabels, type LaunchdGuardContext,
} from "../../../../src/services/system-services/launchd-guard.ts";
import { SERVICE_ACTIONS } from "../../../../src/types/system-services.ts";

const user: LaunchdGuardContext = { uid: 501, selfLabels: new Set(["com.example.ppm"]) };
const root: LaunchdGuardContext = { uid: 0, selfLabels: new Set() };

describe("launchdRefusals", () => {
  test("every system job, every action, when PPM is not root", () => {
    const refused = launchdRefusals("com.example.daemon", "system", user);
    expect(Object.keys(refused).sort()).toEqual([...SERVICE_ACTIONS].sort());
    expect(new Set(Object.values(refused))).toEqual(new Set([NOT_ROOT_REASON]));
  });

  test("as root the system domain is open, apart from macOS's own jobs", () => {
    expect(launchdRefusals("com.example.daemon", "system", root)).toEqual({});
    expect(Object.keys(launchdRefusals("com.apple.mDNSResponder.reloaded", "system", root)).sort())
      .toEqual(["disable", "restart", "stop"]);
  });

  test("an app's own launch is refused whole, though its label is not under com.apple.", () => {
    for (const label of ["application.com.apple.Terminal.497485692.497485698", "application.com.example.editor.1.2"]) {
      const refused = launchdRefusals(label, "user", user);
      expect(Object.keys(refused).sort()).toEqual([...SERVICE_ACTIONS].sort());
      expect(new Set(Object.values(refused))).toEqual(new Set([appInstanceReason(label)]));
    }
  });

  test("PPM's own job cannot be taken away, but starting it is harmless", () => {
    const refused = launchdRefusals("com.example.ppm", "user", user);
    expect(Object.keys(refused).sort()).toEqual(["disable", "restart", "stop"]);
    expect(refused.stop).toContain("PPM itself");
  });

  test("macOS's own agents: nothing that takes one away", () => {
    const refused = launchdRefusals("com.apple.Dock.agent", "user", user);
    expect(Object.keys(refused).sort()).toEqual(["disable", "restart", "stop"]);
    expect(refused.disable).toContain("part of macOS");
  });

  test("anyone else's user job is the user's to manage", () => {
    expect(launchdRefusals("homebrew.mxcl.postgresql@16", "user", user)).toEqual({});
    // Apple ships ssh-agent, but not under its own prefix: it is an ordinary job here.
    expect(launchdRefusals("com.openssh.ssh-agent", "user", user)).toEqual({});
  });
});

describe("checkLaunchdActionAllowed", () => {
  test("the same verdict the row carries", () => {
    expect(checkLaunchdActionAllowed("com.example.ppm", "user", "stop", user))
      .toEqual({ allowed: false, reason: launchdRefusals("com.example.ppm", "user", user).stop });
    expect(checkLaunchdActionAllowed("com.example.ppm", "user", "start", user)).toEqual({ allowed: true });
  });

  test("an unknown action or a label that is not one never gets as far as the rules", () => {
    expect(checkLaunchdActionAllowed("com.example.job", "user", "bootout" as never, user).allowed).toBe(false);
    expect(checkLaunchdActionAllowed("gui/501/com.example.job", "user", "start", user))
      .toEqual({ allowed: false, reason: "Not a job label" });
  });
});

describe("isPlausibleLaunchdLabel", () => {
  test.each([
    "com.apple.DataDetectorsLocalSources",
    "homebrew.mxcl.postgresql@16",
    "com.apple.mdworker.shared.0B000000-0000-0000-0000-000000000000",
    "application.com.example.editor.12345678.12345684",
    "x",
  ])("accepts %p", (label) => {
    expect(isPlausibleLaunchdLabel(label)).toBe(true);
  });

  test.each(["", "a/b", "../gui", "a b", "tab\tlabel", "line\nbreak", "nul\u0000", "x".repeat(257)])(
    "refuses %p",
    (label) => {
      expect(isPlausibleLaunchdLabel(label)).toBe(false);
    },
  );
});

describe("selfJobLabels", () => {
  const jobs = [
    { label: "com.example.ppm", pid: 700 },
    { label: "com.example.other", pid: 800 },
    { label: "com.example.idle", pid: null },
  ];

  test("the label launchd gave PPM's process", () => {
    expect(selfJobLabels("com.example.ppm", [9000], jobs)).toEqual(new Set(["com.example.ppm"]));
  });

  test("the job whose process is one of PPM's ancestors, whatever the environment says", () => {
    // "0" is what a shell opened from Terminal carries.
    expect(selfJobLabels("0", [9000, 8000, 700], jobs)).toEqual(new Set(["com.example.ppm"]));
    expect(selfJobLabels(undefined, [9000, 700], jobs)).toEqual(new Set(["com.example.ppm"]));
  });

  test("nothing when PPM runs under no job", () => {
    expect(selfJobLabels(undefined, [9000, 8000], jobs)).toEqual(new Set());
  });
});

describe("ancestorsOf", () => {
  test("PPM's pid and its parents, up to launchd", () => {
    const ppid = new Map([[900, 800], [800, 700], [700, 1], [1, 0]]);
    expect(ancestorsOf(900, ppid)).toEqual([900, 800, 700]);
  });

  test("a pid table with a loop in it ends", () => {
    expect(ancestorsOf(5, new Map([[5, 6], [6, 5]]))).toEqual([5, 6]);
  });

  test("an unknown parent ends the chain", () => {
    expect(ancestorsOf(5, new Map())).toEqual([5]);
  });
});
