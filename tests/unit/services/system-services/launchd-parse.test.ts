/** `launchctl print` output read into the Services page's shapes. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeExit, isAppInstance, isFailedExit, jobProperties, lastExitFromFields, parseDomainPrint,
  parseJobPrint, parseLastExit, parseLstart, parseOverrides, pidField, signalName, toLaunchdServiceInfo,
  topLevelBlock, type LastExit,
} from "../../../../src/services/system-services/launchd-parse.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "darwin", name), "utf8");
const GUI = fixture("launchctl-print-gui.txt");
const SYSTEM = fixture("launchctl-print-system.txt");

describe("parseDomainPrint", () => {
  test("reads every line of the services block, and nothing from the blocks around it", () => {
    const listing = parseDomainPrint(GUI)!;
    // Every line of the fixture's services block (`awk` between its braces: 47).
    expect(listing.jobs).toHaveLength(47);
    // `externally-hosted endpoints` has lines shaped like a job's ("0  M  D  com.apple…").
    expect(listing.jobs.some((j) => j.label.includes("SpeechRecognitionCore"))).toBe(false);
    expect(listing.jobs.find((j) => j.label === "com.apple.chronod")).toEqual({ label: "com.apple.chronod", pid: 470, status: "-" });
  });

  test("pid 0 is no process, and the middle column is kept verbatim", () => {
    const byLabel = new Map(parseDomainPrint(GUI)!.jobs.map((j) => [j.label, j]));
    expect(byLabel.get("com.apple.DataDetectorsLocalSources")).toEqual({ label: "com.apple.DataDetectorsLocalSources", pid: null, status: "-" });
    expect(byLabel.get("com.example.crashy-agent")!.status).toBe("-9");
    expect(byLabel.get("org.example.failing-job")!.status).toBe("78");
    expect(byLabel.get("com.apple.peopled")).toEqual({ label: "com.apple.peopled", pid: 80195, status: "(jt)" });
  });

  test("the domain's overrides come from its own disabled-services block", () => {
    const { overrides } = parseDomainPrint(SYSTEM)!;
    expect(overrides.get("com.example.updater.agent")).toBe("disabled");
    expect(overrides.get("com.apple.smbd")).toBe("enabled");
    expect(overrides.has("com.apple.fseventsd")).toBe(false);
  });

  test("text with no services block is not a domain with no jobs", () => {
    expect(parseDomainPrint("Bad request.\nCould not find domain for user gui: 12345\n")).toBeNull();
  });

  test("a label is the rest of the line, and the legacy `list` spelling of no pid parses too", () => {
    const text = "x = {\n\tservices = {\n\t\t       -      0 \thomebrew.mxcl.postgresql@16\n\t}\n}\n";
    expect(parseDomainPrint(text)!.jobs).toEqual([{ label: "homebrew.mxcl.postgresql@16", pid: null, status: "0" }]);
  });
});

describe("topLevelBlock / parseOverrides", () => {
  test("print-disabled's output is the same block on its own", () => {
    const text = '\n\tdisabled services = {\n\t\t"com.example.a" => enabled\n\t\t"com.example.b" => disabled\n\t}\n';
    expect([...parseOverrides(topLevelBlock(text, "disabled services"))]).toEqual([
      ["com.example.a", "enabled"],
      ["com.example.b", "disabled"],
    ]);
  });

  test("a missing block is null, and no block is no overrides", () => {
    expect(topLevelBlock("nothing here", "services")).toBeNull();
    expect(parseOverrides(null).size).toBe(0);
  });
});

describe("the last exit", () => {
  test("the middle column decodes into what happened", () => {
    expect(parseLastExit("-")).toEqual({ kind: "none" });
    expect(parseLastExit("0")).toEqual({ kind: "code", code: 0 });
    expect(parseLastExit("78")).toEqual({ kind: "code", code: 78 });
    expect(parseLastExit("-9")).toEqual({ kind: "signal", signal: 9 });
    expect(parseLastExit("(pe)")).toEqual({ kind: "idle" });
    expect(parseLastExit("(jt)")).toEqual({ kind: "jetsam" });
    expect(parseLastExit("(zz)")).toEqual({ kind: "other", text: "(zz)" });
  });

  const cases: [LastExit, string, boolean][] = [
    [{ kind: "none" }, "", false],
    [{ kind: "code", code: 0 }, "exit code 0", false],
    [{ kind: "code", code: 1 }, "exit code 1", true],
    // The signals a deliberate stop sends are not a failure, on systemd either.
    [{ kind: "signal", signal: 15 }, "killed by SIGTERM", false],
    [{ kind: "signal", signal: 1 }, "killed by SIGHUP", false],
    [{ kind: "signal", signal: 9 }, "killed by SIGKILL", true],
    [{ kind: "signal", signal: 11 }, "killed by SIGSEGV", true],
    // macOS reclaiming memory from an idle job: 155 of 446 jobs on a real Mac.
    [{ kind: "idle" }, "idle exit", false],
    [{ kind: "jetsam" }, "killed by jetsam", true],
    [{ kind: "jetsam", reason: "JETSAM_REASON_MEMORY_PERPROCESSLIMIT" }, "killed by jetsam (memory limit)", true],
    [{ kind: "other", text: "(zz)" }, "(zz)", false],
  ];
  test.each(cases)("%j reads %p, failure %p", (exit, text, failed) => {
    expect(describeExit(exit)).toBe(text);
    expect(isFailedExit(exit)).toBe(failed);
  });

  test("signal names follow Darwin's numbering, not Linux's", () => {
    expect(signalName(10)).toBe("SIGBUS");
    expect(signalName(30)).toBe("SIGUSR1");
    expect(signalName(99)).toBe("signal 99");
  });
});

describe("toLaunchdServiceInfo", () => {
  const info = (status: string, pid: number | null, override?: "enabled" | "disabled") =>
    toLaunchdServiceInfo({ label: "com.example.job", pid, exit: parseLastExit(status) }, "user", override);

  test("a running job says nothing of its previous run", () => {
    expect(info("-9", 42)).toMatchObject({
      activeState: "running", subState: "", running: true, failed: false, mainPid: 42,
    });
  });

  test("a job that is not running is failed only when its last run was", () => {
    expect(info("78", null)).toMatchObject({ activeState: "not running", subState: "exit code 78", failed: true });
    expect(info("(pe)", null)).toMatchObject({ subState: "idle exit", failed: false });
    expect(info("-", null)).toMatchObject({ subState: "", failed: false, mainPid: null });
  });

  test("a job is enabled until something disables it", () => {
    expect(info("-", null)).toMatchObject({ enabled: true, unitFileState: null });
    expect(info("-", null, "enabled")).toMatchObject({ enabled: true, unitFileState: "enabled" });
    expect(info("-", null, "disabled")).toMatchObject({ enabled: false, unitFileState: "disabled" });
  });

  test("launchd has no descriptions", () => {
    expect(info("-", null).description).toBe("");
  });
});

describe("parseJobPrint", () => {
  test("PPM's own job: its fields and its argument vector, and not its environment", () => {
    const job = parseJobPrint(fixture("launchctl-print-job-ppm.txt"))!;
    expect(job.fields.get("path")).toBe("/Users/user/Library/LaunchAgents/com.hienlh.ppm.plist");
    expect(job.fields.get("stdout path")).toBe("/Users/user/.ppm/ppm-launchd.log");
    expect(pidField(job.fields)).toBe(98871);
    expect(job.arguments).toEqual([
      "/Users/user/.bun/bin/bun", "run",
      "/Users/user/.bun/install/global/node_modules/@hienlh/ppm/src/services/supervisor.ts",
      "__supervise__", "3210", "0.0.0.0", "--share",
    ]);
    expect([...job.fields.keys()].some((k) => k.includes("PATH") || k.includes("XPC_SERVICE_NAME"))).toBe(false);
    expect(jobProperties(job.fields).has("keepalive")).toBe(true);
  });

  test("a daemon's user and group", () => {
    const job = parseJobPrint(fixture("launchctl-print-job-mdnsresponder.txt"))!;
    expect(job.fields.get("username")).toBe("_mdnsresponder");
    expect(job.fields.get("group")).toBe("_mdnsresponder");
    expect(job.arguments).toEqual(["/usr/sbin/mDNSResponder"]);
    // `event triggers` holds `service = …` two levels down; the job's own fields win.
    expect(job.fields.get("state")).toBe("running");
  });

  test("a nested block's lines never become the job's fields", () => {
    const job = parseJobPrint(fixture("launchctl-print-job-wifi-firmware.txt"))!;
    expect(job.fields.has("keepalive")).toBe(false);
    expect(job.fields.has("service")).toBe(false);
    expect(job.fields.get("last exit code")).toBe("1");
    expect(job.arguments).toEqual(["/usr/libexec/wifiFirmwareLoader"]);
  });

  test("an argument ending in a brace, or empty, is still one argument", () => {
    const text = "gui/501/x = {\n\targuments = {\n\t\t/bin/sh\n\t\tfn() {\n\t\t\n\t}\n\n\tstate = running\n}\n";
    const job = parseJobPrint(text)!;
    expect(job.arguments).toEqual(["/bin/sh", "fn() {", ""]);
    expect(job.fields.get("state")).toBe("running");
  });

  test("launchctl's error text is not a job", () => {
    expect(parseJobPrint('Bad request.\nCould not find service "x" in domain for system\n')).toBeNull();
  });
});

describe("lastExitFromFields", () => {
  const fields = (entries: Record<string, string>) => new Map(Object.entries(entries));

  test("each way a job's description spells its last exit", () => {
    expect(lastExitFromFields(fields({ "last exit code": "(never exited)" }))).toEqual({ kind: "none" });
    expect(lastExitFromFields(fields({ "last exit code": "1" }))).toEqual({ kind: "code", code: 1 });
    expect(lastExitFromFields(fields({ "last exit code": "78: EX_CONFIG" }))).toEqual({ kind: "code", code: 78 });
    expect(lastExitFromFields(fields({ "last terminating signal": "Killed: 9" }))).toEqual({ kind: "signal", signal: 9 });
    expect(lastExitFromFields(fields({ "last exit reason": "JETSAM_REASON_MEMORY_IDLE_EXIT" }))).toEqual({ kind: "idle" });
    expect(lastExitFromFields(fields({ "last exit reason": "JETSAM_REASON_MEMORY_PERPROCESSLIMIT" })))
      .toEqual({ kind: "jetsam", reason: "JETSAM_REASON_MEMORY_PERPROCESSLIMIT" });
    expect(lastExitFromFields(fields({}))).toEqual({ kind: "none" });
  });

  test("the real fixtures", () => {
    expect(lastExitFromFields(parseJobPrint(fixture("launchctl-print-job-wifi-firmware.txt"))!.fields))
      .toEqual({ kind: "code", code: 1 });
    expect(lastExitFromFields(parseJobPrint(fixture("launchctl-print-job-ppm.txt"))!.fields)).toEqual({ kind: "none" });
  });
});

test("a process's start from `ps -o lstart=`, in local time, single-digit days included", () => {
  expect(parseLstart("Wed Sep 30 22:37:57 2026\n")).toBe(new Date(2026, 8, 30, 22, 37, 57).getTime());
  expect(parseLstart("Tue Sep  8 10:05:03 2026")).toBe(new Date(2026, 8, 8, 10, 5, 3).getTime());
  // A process that is gone prints nothing; the ppid listing is not a start.
  expect(parseLstart("")).toBeNull();
  expect(parseLstart("  900 98871\n98871     1\n")).toBeNull();
});

test("an app instance is Launch Services' per-launch job, and nothing else is", () => {
  expect(isAppInstance("application.com.example.editor.12345678.12345684")).toBe(true);
  expect(isAppInstance("com.apple.applicationmanager")).toBe(false);
});
