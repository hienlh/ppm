/**
 * Which systemd unit owns a pid — what the Services page's live CPU, memory,
 * swap, drive and GPU columns are summed over.
 *
 * The fixtures are real `/proc/<pid>/cgroup` lines off this repo's dev host,
 * because the shapes are the whole difficulty: a user service nests two units
 * deep under `user@1000.service`, and a desktop app nests a scope inside a
 * service. Reading the wrong one of a nested pair puts every desktop process on
 * a single row.
 */
import { describe, test, expect } from "bun:test";
import { serviceKeyFromCgroup, systemdHierarchy, unitFromCgroup } from "../../../../src/services/system-services/app-cgroup-linux.ts";
import { parseVmSwapKB } from "../../../../src/services/system-metrics/process-swap-linux.ts";

describe("unitFromCgroup", () => {
  test("a system service is named by its own cgroup segment", () => {
    expect(unitFromCgroup("0::/system.slice/ppm.service\n")).toBe("ppm.service");
  });

  test("a USER service nests under user@1000.service — the inner unit wins", () => {
    const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/dbus-broker.service";
    expect(unitFromCgroup(cgroup)).toBe("dbus-broker.service");
  });

  test("a slice is never the answer: it names nothing anyone can act on", () => {
    expect(unitFromCgroup("0::/user.slice/user-1000.slice")).toBeNull();
    expect(unitFromCgroup("0::/system.slice")).toBeNull();
  });

  test("a kernel thread is in the root cgroup and belongs to no unit", () => {
    expect(unitFromCgroup("0::/")).toBeNull();
    expect(unitFromCgroup("")).toBeNull();
  });

  test("scopes, sockets, mounts and swaps all own processes too", () => {
    expect(unitFromCgroup("0::/init.scope")).toBe("init.scope");
    expect(unitFromCgroup("0::/system.slice/home.mount")).toBe("home.mount");
    expect(unitFromCgroup("0::/user.slice/user-1000.slice/session-2.scope")).toBe("session-2.scope");
  });

  test("the name is verbatim — an unescaped one would match no systemctl row", () => {
    const swap = "0::/system.slice/dev-disk-by\\x2duuid-9f2a.swap";
    expect(unitFromCgroup(swap)).toBe("dev-disk-by\\x2duuid-9f2a.swap");
  });

  test("a desktop app's scope inside its service resolves to the scope", () => {
    const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-code-179366.scope";
    expect(unitFromCgroup(cgroup)).toBe("app-code-179366.scope");
  });
});

describe("systemdHierarchy", () => {
  test("cgroup v1 has one line per controller; only the systemd one is the unit tree", () => {
    const v1 = [
      "12:pids:/system.slice/sshd.service",
      "3:cpu,cpuacct:/",
      "1:name=systemd:/system.slice/sshd.service",
    ].join("\n");
    expect(systemdHierarchy(v1)).toBe("/system.slice/sshd.service");
    expect(unitFromCgroup(v1)).toBe("sshd.service");
  });

  test("a v1 dump with no systemd hierarchy answers nothing rather than guessing", () => {
    expect(systemdHierarchy("3:cpu,cpuacct:/system.slice/sshd.service")).toBeNull();
  });

  test("a malformed line is skipped, not parsed into a bogus path", () => {
    expect(systemdHierarchy("garbage")).toBeNull();
    expect(systemdHierarchy("0::")).toBeNull();
  });
});

describe("parseVmSwapKB", () => {
  test("VmSwap is read out of the status dump", () => {
    const status = ["Name:\tbun", "VmRSS:\t  204800 kB", "VmSwap:\t    1280 kB", "Threads:\t22"].join("\n");
    expect(parseVmSwapKB(status)).toBe(1280);
  });

  test("a kernel thread has no address space and so no VmSwap line — that is 0", () => {
    expect(parseVmSwapKB("Name:\tkthreadd\nThreads:\t1\n")).toBe(0);
  });

  test("`VmSwapSomething` must not match: the unit suffix anchors the line", () => {
    expect(parseVmSwapKB("VmSwapped:\t99 kB\n")).toBe(0);
  });
});

describe("serviceKeyFromCgroup", () => {
  const USER_UNIT = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/dbus-broker.service";
  const SYSTEM_UNIT = "0::/system.slice/dbus-broker.service";

  test("the same unit name in both scopes gets two different keys", () => {
    // Not hypothetical: this host runs dbus-broker.service in BOTH scopes, and
    // one key for the two would show one figure for two different units.
    expect(serviceKeyFromCgroup(SYSTEM_UNIT, 1000)).toBe("system:dbus-broker.service");
    expect(serviceKeyFromCgroup(USER_UNIT, 1000)).toBe("user:dbus-broker.service");
  });

  test("living under /user.slice/ does not make a unit a user one", () => {
    // `systemctl list-units` reports both of these in the SYSTEM scope.
    expect(serviceKeyFromCgroup("0::/user.slice/user-1000.slice/session-2.scope", 1000))
      .toBe("system:session-2.scope");
    expect(serviceKeyFromCgroup("0::/user.slice/user-1000.slice/user@1000.service", 1000))
      .toBe("system:user@1000.service");
  });

  test("another user's unit is not on our page, so it is null rather than ours", () => {
    expect(serviceKeyFromCgroup(USER_UNIT, 1001)).toBeNull();
  });

  test("a pid in no unit has no key", () => {
    expect(serviceKeyFromCgroup("0::/", 1000)).toBeNull();
  });
});
