/** The Services page on macOS: listing, details and actions through `launchctl`, faked. */
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";
import {
  createLaunchdBackend, keepAliveNote, type LaunchdDeps,
} from "../../../../src/services/system-services/launchd-collector.ts";
import { isPlausibleLaunchdLabel, NOT_ROOT_REASON } from "../../../../src/services/system-services/launchd-guard.ts";
import { parseDomainPrint } from "../../../../src/services/system-services/launchd-parse.ts";
import type { LaunchdLogRequest } from "../../../../src/services/system-services/launchd-logs.ts";
import { ServiceActionRefused } from "../../../../src/services/system-services/systemd-collector.ts";
import { SERVICE_ACTIONS, type ServiceInfo } from "../../../../src/types/system-services.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "darwin", name), "utf8");
const GUI = fixture("launchctl-print-gui.txt");
// The background session's domain: the GUI one's parent, with jobs of its own.
const USER = fixture("launchctl-print-user.txt");
// The system fixture also carries the gui one's third-party and app lines, which the
// parser tests use; a real system domain holds Apple's daemons, so they go.
const SYSTEM = fixture("launchctl-print-system.txt")
  .split("\n")
  .filter((line) => !/\t(com\.example|org\.example|application|com\.hienlh)\./.test(line))
  .join("\n");
const PPM_JOB = fixture("launchctl-print-job-ppm.txt");
const MDNS_JOB = fixture("launchctl-print-job-mdnsresponder.txt");

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false });
const fail = (code: number, stderr: string): RunResult => ({ stdout: "", stderr, code, timedOut: false });
const NO_GUI = fail(112, "Bad request.\nCould not find domain for user gui: 501\n");
const noService = (label: string, domain = "user gui: 501") =>
  fail(113, `Bad request.\nCould not find service "${label}" in domain for ${domain}\n`);

/** A job's `print`, shaped like the real ones. */
function jobPrint(target: string, opts: { pid?: number; properties?: string } = {}): string {
  return [
    `${target} = {`,
    "\tactive count = 1",
    `\tpath = /Users/user/Library/LaunchAgents/${target.split("/").pop()}.plist`,
    "\ttype = LaunchAgent",
    `\tstate = ${opts.pid ? "running" : "not running"}`,
    "",
    "\tprogram = /Applications/Example Sync.app/Contents/MacOS/sync-helper",
    "\targuments = {",
    "\t\t/Applications/Example Sync.app/Contents/MacOS/sync-helper",
    "\t\t--background",
    "\t}",
    "",
    ...(opts.pid ? [`\tpid = ${opts.pid}`] : []),
    "\tlast exit code = (never exited)",
    `\tproperties = ${opts.properties ?? "runatload | inferred program"}`,
    "}",
    "",
  ].join("\n");
}

/** PPM (pid 900) under the bun that launchd started as com.hienlh.ppm (98871). */
const PS = "    1     0\n98871     1\n  800 98871\n  900   800\n 1812     1\n";
const DISABLED = '\n\tdisabled services = {\n\t\t"com.example.updater.agent" => disabled\n\t\t"com.hienlh.ppm" => enabled\n\t}\n';

type Reply = (argv: string[]) => RunResult | undefined;

function backend(reply: Reply = () => undefined, deps: Partial<LaunchdDeps> = {}) {
  const calls: string[][] = [];
  const indexed: [number, string][][] = [];
  const logRequests: LaunchdLogRequest[] = [];
  const standard = (argv: string[]): RunResult => {
    const [tool, verb, target] = argv;
    if (tool === "ps") return ok(PS);
    if (verb === "print" && target === "system") return ok(SYSTEM);
    if (verb === "print" && target === "gui/501") return ok(GUI);
    if (verb === "print" && target === "user/501") return ok(USER);
    if (verb === "print-disabled") return ok(DISABLED);
    if (verb === "print" && target === "gui/501/com.hienlh.ppm") return ok(PPM_JOB);
    if (verb === "print" && target === "system/com.apple.mDNSResponder.reloaded") return ok(MDNS_JOB);
    if (verb === "print" && target?.startsWith("gui/501/com.example.sync-helper")) return ok(jobPrint(target, { pid: 1812 }));
    if (verb === "print" && target === "user/501/com.example.background-agent") return ok(jobPrint(target, { pid: 3101 }));
    if (verb === "print" && target?.includes("/")) return noService(target.split("/").pop()!);
    return ok("");
  };
  const b = createLaunchdBackend({
    run: async (argv) => {
      calls.push(argv);
      return reply(argv) ?? standard(argv);
    },
    uid: 501,
    userName: "user",
    pid: 900,
    serviceName: undefined,
    logs: {
      async read(req) {
        logRequests.push(req);
        return { lines: [{ ts: null, message: "started" }], source: { kind: "files", paths: [req.stdoutPath ?? "?"] } };
      },
    },
    jobIndex: { update: (pids) => { indexed.push([...pids] as [number, string][]); }, keysFor: () => new Map() },
    ...deps,
  });
  /** The calls that change something: everything but the lookups. */
  const actions = () => calls.filter(([tool, verb]) => tool === "launchctl" && verb !== "print" && verb !== "print-disabled");
  return { b, calls, indexed, logRequests, actions };
}

const row = (services: ServiceInfo[], scope: string, unit: string) => {
  const found = services.find((s) => s.scope === scope && s.unit === unit);
  if (!found) throw new Error(`no ${scope}/${unit}`);
  return found;
};

describe("collect", () => {
  test("every domain in one snapshot, without Launch Services' per-app jobs", async () => {
    const { b } = backend();
    const snap = await b.collect();
    expect(snap.manager).toBe("launchd");
    expect(snap.supported).toBe(true);
    expect(snap.warnings).toEqual([]);
    // gui: 47 lines, 2 of them app instances; user: 5. system: 47, 7 of them the gui's.
    expect(snap.services.filter((s) => s.scope === "user")).toHaveLength(50);
    expect(snap.services.filter((s) => s.scope === "system")).toHaveLength(40);
    expect(snap.services.some((s) => s.unit.startsWith("application."))).toBe(false);
  });

  test("the background domain's jobs are listed, and looked at and acted on where they live", async () => {
    const { b, calls, actions } = backend();
    const { services } = await b.collect();
    expect(row(services, "user", "com.example.background-agent")).toMatchObject({
      running: true, mainPid: 3101, unitFileState: "enabled",
    });
    expect(row(services, "user", "com.apple.trustd.agent").refused?.stop).toContain("part of macOS");

    expect((await b.details("com.example.background-agent", "user"))?.mainPid).toBe(3101);
    expect(calls).toContainEqual(["launchctl", "print-disabled", "user/501"]);
    for (const action of ["stop", "start", "disable"] as const) await b.action("com.example.background-agent", "user", action);
    expect(actions()).toEqual([
      ["launchctl", "kill", "SIGTERM", "user/501/com.example.background-agent"],
      ["launchctl", "kickstart", "user/501/com.example.background-agent"],
      ["launchctl", "disable", "user/501/com.example.background-agent"],
    ]);
  });

  test("each row reads as the Services page expects", async () => {
    const { services } = await backend().b.collect();
    expect(row(services, "user", "com.example.sync-helper")).toMatchObject({
      running: true, mainPid: 1812, activeState: "running", enabled: true, unitFileState: "enabled", failed: false,
    });
    expect(row(services, "user", "com.example.crashy-agent")).toMatchObject({
      running: false, failed: true, subState: "killed by SIGKILL",
    });
    expect(row(services, "user", "org.example.failing-job")).toMatchObject({ failed: true, subState: "exit code 78" });
    expect(row(services, "user", "com.example.updater.agent")).toMatchObject({ enabled: false, unitFileState: "disabled" });
    expect(row(services, "system", "com.apple.kernelmanager_helper")).toMatchObject({ failed: false, subState: "idle exit" });
  });

  test("PPM's own job is found through its ancestors, with no help from the environment", async () => {
    const { services } = await backend().b.collect();
    const ppm = row(services, "user", "com.hienlh.ppm");
    expect(Object.keys(ppm.refused ?? {}).sort()).toEqual(["disable", "restart", "stop"]);
    expect(ppm.refused!.stop).toContain("PPM itself");
  });

  test("and through XPC_SERVICE_NAME when the process table says nothing", async () => {
    const { services } = await backend((argv) => (argv[0] === "ps" ? ok("") : undefined), {
      serviceName: "com.hienlh.ppm",
    }).b.collect();
    expect(row(services, "user", "com.hienlh.ppm").refused!.stop).toContain("PPM itself");
  });

  test("macOS's agents keep what cannot hurt them, and the user's own jobs keep everything", async () => {
    const { services } = await backend().b.collect();
    expect(Object.keys(row(services, "user", "com.apple.chronod").refused ?? {}).sort()).toEqual(["disable", "restart", "stop"]);
    expect(row(services, "user", "com.example.sync-helper").refused).toBeUndefined();
  });

  test("every system job is locked for a PPM that is not root", async () => {
    const { services } = await backend().b.collect();
    for (const s of services.filter((x) => x.scope === "system")) {
      expect(Object.keys(s.refused ?? {}).sort()).toEqual([...SERVICE_ACTIONS].sort());
      expect(s.refused!.start).toBe(NOT_ROOT_REASON);
    }
  });

  test("the running jobs' main processes go to the metrics tick's index", async () => {
    const { b, indexed } = backend();
    await b.collect();
    const pids = new Map(indexed[0]);
    expect(pids.get(470)).toBe("user:com.apple.chronod");
    expect(pids.get(98871)).toBe("user:com.hienlh.ppm");
    expect(pids.get(170)).toBe("system:com.apple.runningboardd");
    expect(pids.get(3101)).toBe("user:com.example.background-agent");
    // App instances are the Apps page's: their pids are not a job's.
    expect(pids.has(2201)).toBe(false);
    expect(pids.has(0)).toBe(false);
  });

  test("a Mac with nobody at the screen has no GUI domain, which is not a failure", async () => {
    const { b, actions } = backend((argv) => (argv[2] === "gui/501" ? NO_GUI : undefined));
    const snap = await b.collect();
    expect(snap.supported).toBe(true);
    expect(snap.warnings).toEqual([]);
    expect(snap.services.filter((s) => s.scope === "user")).toHaveLength(5);
    await b.action("com.example.background-agent", "user", "start");
    expect(actions()).toEqual([["launchctl", "kickstart", "user/501/com.example.background-agent"]]);
  });

  test("one domain failing is a warning naming it, every one failing is no service manager", async () => {
    const one = await backend((argv) => (argv[2] === "system" ? fail(1, "boom\nagain") : undefined)).b.collect();
    expect(one.supported).toBe(true);
    expect(one.warnings).toEqual(["system jobs unavailable: boom again"]);
    const background = await backend((argv) => (argv[2] === "user/501" ? fail(5, "Input/output error") : undefined)).b.collect();
    expect(background.warnings).toEqual(["user/501 jobs unavailable: Input/output error"]);

    const none = await backend((argv) => (argv[1] === "print" ? fail(1, "no launchd here") : undefined)).b.collect();
    expect(none.supported).toBe(false);
    expect(none.services).toEqual([]);
    expect(none.warnings).toHaveLength(3);
  });

  test("an answer with no services block is not an empty domain", async () => {
    const snap = await backend((argv) => (argv[2] === "system" ? ok("system = {\n}\n") : undefined)).b.collect();
    expect(snap.warnings).toEqual(["system jobs unavailable: launchctl printed no services block"]);
  });

  test("a listing that missed PPM's job does not decide PPM's job for good", async () => {
    let userDomainDown = true;
    const { b } = backend((argv) => (argv[2] === "gui/501" && userDomainDown ? fail(5, "Input/output error") : undefined));
    await b.collect();
    userDomainDown = false;
    await expect(b.action("com.hienlh.ppm", "user", "stop")).rejects.toThrow("PPM itself");
  });
});

describe("details", () => {
  test("a LaunchAgent: its program, output, override and log", async () => {
    const { b, logRequests } = backend((argv) => (argv.includes("lstart=") ? ok("Wed Sep 30 22:37:57 2026\n") : undefined));
    const d = (await b.details("com.hienlh.ppm", "user"))!;
    expect(d).toMatchObject({
      unit: "com.hienlh.ppm",
      scope: "user",
      running: true,
      mainPid: 98871,
      unitFileState: "enabled",
      user: "user",
      group: null,
      fragmentPath: "/Users/user/Library/LaunchAgents/com.hienlh.ppm.plist",
      program: "/Users/user/.bun/bin/bun",
      stdoutPath: "/Users/user/.ppm/ppm-launchd.log",
      stderrPath: "/Users/user/.ppm/ppm-launchd.log",
      lastExit: "never exited",
      keepAlive: true,
      logs: [{ ts: null, message: "started" }],
    });
    expect(d.arguments?.[0]).toBe("/Users/user/.bun/bin/bun");
    expect(d.refused?.stop).toContain("PPM itself");
    expect(logRequests).toEqual([{
      stdoutPath: "/Users/user/.ppm/ppm-launchd.log",
      stderrPath: "/Users/user/.ppm/ppm-launchd.log",
      pid: 98871,
      // The floor of a query by pid: before it, 98871 named some other process.
      startedAt: new Date(2026, 8, 30, 22, 37, 57).getTime(),
      program: "/Users/user/.bun/bin/bun",
    }]);
  });

  test("a job that is not running asks nothing about a start", async () => {
    const { b, calls, logRequests } = backend((argv) =>
      argv[1] === "print" && argv[2] === "gui/501/com.example.idle-agent" ? ok(jobPrint(argv[2])) : undefined);
    await b.details("com.example.idle-agent", "user");
    expect(calls.some((argv) => argv.includes("lstart="))).toBe(false);
    expect(logRequests[0]).toMatchObject({ pid: null, startedAt: null });
  });

  test("a daemon names the account it runs as", async () => {
    const d = (await backend().b.details("com.apple.mDNSResponder.reloaded", "system"))!;
    expect(d).toMatchObject({ user: "_mdnsresponder", group: "_mdnsresponder", keepAlive: false });
    expect(Object.keys(d.refused ?? {})).toHaveLength(SERVICE_ACTIONS.length);
  });

  test("a label launchd does not know is nothing, not an error", async () => {
    expect(await backend().b.details("com.example.gone", "user")).toBeNull();
  });

  test("a launchctl that fails for another reason is still a null, and says why in the log", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { b } = backend((argv) =>
        argv[1] === "print" && argv[2] === "gui/501/com.example.wedged" ? { stdout: "", stderr: "", code: null, timedOut: true } : undefined);
      expect(await b.details("com.example.wedged", "user")).toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining("launchctl print user/com.example.wedged failed:"),
      ]);
      // An unknown label is the ordinary 404, not something to log.
      warn.mockClear();
      expect(await b.details("com.example.gone", "user")).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("action", () => {
  test.each([
    ["start", ["launchctl", "kickstart", "gui/501/com.example.sync-helper"]],
    ["restart", ["launchctl", "kickstart", "-k", "gui/501/com.example.sync-helper"]],
    ["enable", ["launchctl", "enable", "gui/501/com.example.sync-helper"]],
    ["disable", ["launchctl", "disable", "gui/501/com.example.sync-helper"]],
  ] as const)("%s runs %p", async (action, argv) => {
    const { b, actions } = backend();
    expect(await b.action("com.example.sync-helper", "user", action)).toEqual({
      unit: "com.example.sync-helper", scope: "user", action,
    });
    expect(actions()).toEqual([[...argv]]);
  });

  test("stop sends SIGTERM to the running job and leaves it loaded", async () => {
    const { b, actions } = backend();
    expect(await b.action("com.example.sync-helper", "user", "stop")).toEqual({
      unit: "com.example.sync-helper", scope: "user", action: "stop",
    });
    expect(actions()).toEqual([["launchctl", "kill", "SIGTERM", "gui/501/com.example.sync-helper"]]);
    expect(actions().some(([, verb]) => verb === "bootout")).toBe(false);
  });

  test("stopping a job launchd keeps alive says it came straight back", async () => {
    const { b } = backend((argv) => (argv[1] === "print" && argv[2] === "gui/501/com.example.sync-helper"
      ? ok(jobPrint(argv[2], { pid: 1812, properties: "keepalive | runatload" }))
      : undefined));
    expect((await b.action("com.example.sync-helper", "user", "stop")).note).toBe(keepAliveNote("com.example.sync-helper"));
  });

  test("stopping a job with no process is done already", async () => {
    const { b, actions } = backend((argv) => (argv[1] === "print" && argv[2] === "gui/501/com.example.sync-helper"
      ? ok(jobPrint(argv[2]))
      : undefined));
    expect((await b.action("com.example.sync-helper", "user", "stop")).note).toBe("com.example.sync-helper was not running");
    expect(actions()).toEqual([]);
  });

  test.each([
    ["com.hienlh.ppm", "user", "stop", "PPM itself"],
    ["com.hienlh.ppm", "user", "disable", "PPM itself"],
    ["com.apple.chronod", "user", "restart", "part of macOS"],
    ["com.apple.fseventsd", "system", "start", NOT_ROOT_REASON],
    // Not a row on this page, so only a request naming it directly gets this far.
    ["application.com.apple.Terminal.497485692.497485698", "user", "stop", "Apps page"],
    ["application.com.example.editor.1.2", "user", "enable", "Apps page"],
  ] as const)("%s (%s) %s is refused before launchctl is asked", async (label, scope, action, reason) => {
    const { b, actions } = backend();
    const attempt = b.action(label, scope, action);
    await expect(attempt).rejects.toBeInstanceOf(ServiceActionRefused);
    await expect(attempt).rejects.toThrow(reason);
    expect(actions()).toEqual([]);
  });

  test("launchctl's two-line complaint arrives as one sentence", async () => {
    const { b } = backend((argv) => (argv[1] === "kickstart" ? noService("com.example.gone") : undefined));
    await expect(b.action("com.example.gone", "user", "start"))
      .rejects.toThrow('Bad request. Could not find service "com.example.gone" in domain for user gui: 501');
  });

  test("a stop that cannot find the job says why", async () => {
    await expect(backend().b.action("com.example.gone", "user", "stop")).rejects.toThrow("Could not find service");
  });
});

describe.if(process.platform === "darwin")("on this Mac", () => {
  test("every line of this Mac's own services block parses", () => {
    const text = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid!()}`]).stdout.toString();
    const lines = text.split("\n");
    const start = lines.indexOf("\tservices = {");
    const end = lines.indexOf("\t}", start);
    expect(start).toBeGreaterThan(-1);
    const raw = lines.slice(start + 1, end).filter((line) => line.trim() !== "");
    expect(raw.length).toBeGreaterThan(0);
    expect(parseDomainPrint(text)!.jobs).toHaveLength(raw.length);
  });

  test("the real backend lists the user's jobs and locks what it must", async () => {
    // Reads only: `launchctl print` for both domains and one `ps`.
    const snap = await createLaunchdBackend().collect();
    expect(snap.supported).toBe(true);
    expect(snap.manager).toBe("launchd");
    const user = snap.services.filter((s) => s.scope === "user");
    expect(user.length).toBeGreaterThan(0);
    expect(snap.services.every((s) => isPlausibleLaunchdLabel(s.unit) && !s.unit.startsWith("application."))).toBe(true);
    const root = process.getuid!() === 0;
    for (const s of snap.services) {
      if (s.scope === "system" && !root) expect(s.refused?.start).toBe(NOT_ROOT_REASON);
      if (s.unit.startsWith("com.apple.")) expect(s.refused?.stop).toBeDefined();
    }
  });
});
