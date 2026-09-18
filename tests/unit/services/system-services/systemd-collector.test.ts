import { describe, test, expect } from "bun:test";
import {
  systemctlArgv, journalctlArgv, listScope, collectServices, serviceDetails,
  serviceLogs, runServiceAction, ServiceActionRefused, actionFailureText,
  failureText, withRefusals, type SystemdDeps,
} from "../../../../src/services/system-services/systemd-collector.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";

const okRun = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false });
const failRun = (stderr: string, code = 1): RunResult => ({ stdout: "", stderr, code, timedOut: false });

const LIST = [
  "-.mount            loaded    active   mounted Root Mount",
  "sshd.service       loaded    active   running OpenSSH Daemon",
  "ppm.service        loaded    active   running PPM",
  "autofs.service     not-found inactive dead    autofs.service",
  "cron.timer         loaded    active   waiting A Timer",
].join("\n");

const SHOW = [
  "Id=-.mount\nDescription=Root Mount\nLoadState=loaded\nActiveState=active\nSubState=mounted\nUnitFileState=generated\nMainPID=0",
  "Id=sshd.service\nDescription=OpenSSH Daemon\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=850",
  "Id=ppm.service\nDescription=PPM\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=99",
].join("\n\n");

const CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ppm.service";

function harness(reply: (argv: string[]) => RunResult) {
  const calls: string[][] = [];
  const deps: SystemdDeps = {
    run: async (argv) => { calls.push(argv); return reply(argv); },
    guard: { selfCgroup: CGROUP },
  };
  return { deps, calls };
}

const defaultReply = (argv: string[]): RunResult => {
  if (argv.includes("list-units")) return okRun(LIST);
  if (argv.includes("show")) return okRun(SHOW);
  return okRun("");
};

describe("argv shapes", () => {
  test("the user manager is addressed with --user, the system one with nothing", () => {
    expect(systemctlArgv("user", ["x"])).toEqual(["systemctl", "--user", "x"]);
    expect(systemctlArgv("system", ["x"])).toEqual(["systemctl", "x"]);
  });

  test("journalctl takes the unit as --unit=NAME, so a dash-named unit is not read as options", () => {
    const argv = journalctlArgv("system", "-.mount", 50);
    expect(argv).toContain("--unit=-.mount");
    expect(argv).not.toContain("-.mount");
    expect(journalctlArgv("user", "a.service", 5)).toContain("--user");
  });
});

describe("listScope", () => {
  test("two spawns for the whole scope, with the unit names after --", async () => {
    const h = harness(defaultReply);
    const listing = await listScope("system", h.deps);
    expect(h.calls).toHaveLength(2);
    const show = h.calls[1]!;
    const sep = show.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    // Every unit name sits AFTER the separator, which is what makes -.mount safe.
    expect(show.slice(sep + 1)).toEqual(["-.mount", "sshd.service", "ppm.service"]);
    expect(listing.ok).toBe(true);
  });

  test("a timer is not listed and a not-found unit is dropped", async () => {
    const { deps } = harness(defaultReply);
    const units = (await listScope("system", deps)).services.map((s) => s.unit);
    expect(units).toEqual(["-.mount", "sshd.service", "ppm.service"]);
  });

  test("each row carries the refusals the action route will enforce", async () => {
    const { deps } = harness(defaultReply);
    const services = (await listScope("system", deps)).services;
    const ppm = services.find((s) => s.unit === "ppm.service");
    expect(Object.keys(ppm?.refused ?? {}).sort()).toEqual(["disable", "restart", "stop"]);
    expect(services.find((s) => s.unit === "-.mount")?.refused?.stop).toBeTruthy();
    expect(services.find((s) => s.unit === "sshd.service")?.refused).toBeUndefined();
  });

  test("figures come from show: enabled, the main pid and the generated state", async () => {
    const { deps } = harness(defaultReply);
    const services = (await listScope("system", deps)).services;
    const sshd = services.find((s) => s.unit === "sshd.service");
    expect(sshd?.enabled).toBe(true);
    expect(sshd?.mainPid).toBe(850);
    expect(services.find((s) => s.unit === "-.mount")?.enabled).toBe(false);
  });

  test("no manager at all: one warning, no second spawn, ok false", async () => {
    const h = harness(() => failRun("Failed to connect to bus"));
    const listing = await listScope("user", h.deps);
    expect(listing.ok).toBe(false);
    expect(h.calls).toHaveLength(1);
    expect(listing.warnings[0]).toContain("Failed to connect to bus");
  });

  test("show failing degrades the list instead of emptying it", async () => {
    const h = harness((argv) => (argv.includes("show") ? failRun("boom") : okRun(LIST)));
    const listing = await listScope("system", h.deps);
    expect(listing.ok).toBe(true);
    expect(listing.services.map((s) => s.unit)).toHaveLength(3);
    // LOAD/ACTIVE/SUB survived; only the unit-file state and pid are lost.
    expect(listing.services[1]?.running).toBe(true);
    expect(listing.services[1]?.mainPid).toBeNull();
    expect(listing.warnings[0]).toContain("boom");
  });
});

describe("collectServices", () => {
  test("both scopes in one snapshot", async () => {
    const { deps } = harness(defaultReply);
    const snapshot = await collectServices(deps);
    expect(snapshot.supported).toBe(true);
    expect(snapshot.services.filter((s) => s.scope === "system")).toHaveLength(3);
    expect(snapshot.services.filter((s) => s.scope === "user")).toHaveLength(3);
  });

  test("one manager answering is enough to call the host supported", async () => {
    const { deps } = harness((argv) =>
      argv.includes("--user") ? failRun("no bus") : defaultReply(argv));
    const snapshot = await collectServices(deps);
    expect(snapshot.supported).toBe(true);
    expect(snapshot.warnings).toHaveLength(1);
  });

  test("no systemd at all is reported as unsupported, with the reason kept", async () => {
    const { deps } = harness(() => failRun("command not found", 127));
    const snapshot = await collectServices(deps);
    expect(snapshot.supported).toBe(false);
    expect(snapshot.services).toEqual([]);
    expect(snapshot.warnings.join(" ")).toContain("command not found");
  });
});

describe("serviceDetails", () => {
  const DETAIL = "Id=sshd.service\nDescription=OpenSSH Daemon\nLoadState=loaded\nActiveState=active\n"
    + "SubState=running\nUnitFileState=enabled\nMainPID=850\nUser=\nGroup=\nFragmentPath=/usr/lib/systemd/system/sshd.service";
  const LOG = JSON.stringify({ __REALTIME_TIMESTAMP: "1700000000000000", MESSAGE: "Server listening" });

  test("fills the details pane and this boot's journal", async () => {
    const { deps } = harness((argv) => okRun(argv[0] === "journalctl" ? LOG : DETAIL));
    const details = await serviceDetails("sshd.service", "system", deps);
    expect(details?.fragmentPath).toBe("/usr/lib/systemd/system/sshd.service");
    // An unset User is null, not the empty string systemd prints.
    expect(details?.user).toBeNull();
    expect(details?.logs).toEqual([{ ts: 1700000000000, message: "Server listening" }]);
  });

  test("a unit systemd has never heard of is null, not a shell of blanks", async () => {
    const { deps } = harness(() => okRun("Id=nope.service\nLoadState=not-found\nActiveState=inactive"));
    expect(await serviceDetails("nope.service", "system", deps)).toBeNull();
  });

  test("a failed show is null rather than a half-filled pane", async () => {
    const { deps } = harness(() => failRun("nope"));
    expect(await serviceDetails("x.service", "system", deps)).toBeNull();
  });

  test("logs are NOT gated on the exit code — journalctl exits non-zero with no entries", async () => {
    const { deps } = harness(() => ({ stdout: LOG, stderr: "", code: 1, timedOut: false }));
    expect(await serviceLogs("x.service", "system", deps)).toHaveLength(1);
  });

  test("a timed-out journalctl yields no lines rather than hanging the pane", async () => {
    const { deps } = harness(() => ({ stdout: LOG, stderr: "", code: null, timedOut: true }));
    expect(await serviceLogs("x.service", "system", deps)).toEqual([]);
  });
});

describe("runServiceAction", () => {
  test("PPM's own unit is refused before anything is spawned", async () => {
    const h = harness(() => okRun(""));
    await expect(runServiceAction("ppm.service", "user", "stop", h.deps)).rejects.toBeInstanceOf(ServiceActionRefused);
    expect(h.calls).toEqual([]);
  });

  test("starting PPM's own unit is harmless and still allowed", async () => {
    const h = harness(() => okRun(""));
    expect(await runServiceAction("ppm.service", "user", "start", h.deps)).toEqual({
      unit: "ppm.service", scope: "user", action: "start",
    });
  });

  test("the spawn never waits on a password prompt, and the unit follows --", async () => {
    const h = harness(() => okRun(""));
    await runServiceAction("-.mount", "system", "start", h.deps);
    const argv = h.calls[0]!;
    expect(argv).toContain("--no-ask-password");
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("-.mount");
  });

  test("a polkit refusal is reported in terms the user can act on", async () => {
    const h = harness(() => failRun("Interactive authentication required."));
    await expect(runServiceAction("sshd.service", "system", "stop", h.deps))
      .rejects.toThrow("does not run as root");
  });

  test("any other failure is passed through verbatim", async () => {
    const h = harness(() => failRun("Unit x.service not loaded."));
    await expect(runServiceAction("x.service", "user", "stop", h.deps)).rejects.toThrow("not loaded");
  });
});

describe("small helpers", () => {
  test("failureText prefers stderr, then stdout, then the code", () => {
    expect(failureText(failRun("bad"))).toBe("bad");
    expect(failureText({ stdout: "out", stderr: "", code: 3, timedOut: false })).toBe("out");
    expect(failureText({ stdout: "", stderr: "", code: 3, timedOut: false })).toBe("exited 3");
    expect(failureText({ stdout: "x", stderr: "y", code: null, timedOut: true })).toBe("timed out");
  });

  test("actionFailureText only rewrites the authentication case", () => {
    expect(actionFailureText(failRun("Interactive authentication required."), "user")).toContain("cannot provide");
    expect(actionFailureText(failRun("other"), "system")).toBe("other");
  });

  test("withRefusals leaves an unrestricted unit's object untouched", () => {
    const info = { unit: "a.service", scope: "system" as const, description: "", activeState: "active",
      subState: "running", unitFileState: "enabled", running: true, failed: false, enabled: true, mainPid: 1 };
    expect(withRefusals(info, { selfCgroup: CGROUP })).toBe(info);
  });
});
