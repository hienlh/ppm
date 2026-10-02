import { describe, expect, test } from "bun:test";
import {
  isPlausibleWindowsServiceName, parseEventLines, parseExtraLine, parseServiceLines, startupType, toB64,
  toWindowsServiceInfo, windowsRefusals,
} from "../../../src/services/system-services/windows-services-parse.ts";
import { actionScript, createWindowsServicesBackend, detailsScript, queuedRunner } from "../../../src/services/system-services/windows-services.ts";
import { ServiceActionRefused } from "../../../src/services/system-services/systemd-collector.ts";

/** One `S` line as the listing script prints it. */
function sLine(o: { name: string; display?: string; state?: string; mode?: string; pid?: number; exit?: number; svcExit?: number; acceptStop?: boolean; delayed?: boolean }) {
  return ["S", toB64(o.name), toB64(o.display ?? o.name), o.state ?? "Running", o.mode ?? "Auto", o.pid ?? 0,
    o.exit ?? 0, o.svcExit ?? 0, o.acceptStop ?? true ? "True" : "False", o.delayed ? "True" : "False"].join("\t");
}

describe("parseServiceLines", () => {
  test("reads every field, and an embedded newline cannot forge a row", () => {
    const text = [
      sLine({ name: "Spooler", display: "Print Spooler\nS\tZm9yZ2Vk", pid: 4828 }),
      "garbage line",
      sLine({ name: "Fax", state: "Stopped", mode: "Manual" }),
    ].join("\r\n");
    const rows = parseServiceLines(text);
    expect(rows.map((r) => r.name)).toEqual(["Spooler", "Fax"]);
    expect(rows[0]!.displayName).toBe("Print Spooler\nS\tZm9yZ2Vk");
    expect(rows[0]!.pid).toBe(4828);
    expect(rows[1]!.pid).toBeNull();
  });
});

describe("toWindowsServiceInfo", () => {
  test("a running automatic service is running and enabled", () => {
    const [row] = parseServiceLines(sLine({ name: "Spooler", display: "Print Spooler", pid: 10 }));
    expect(toWindowsServiceInfo(row!)).toEqual({
      unit: "Spooler", scope: "system", description: "Print Spooler", activeState: "running", subState: "",
      unitFileState: "automatic", running: true, failed: false, enabled: true, mainPid: 10,
    });
  });

  test("a stopped service that never started is not failed; one with an exit code is", () => {
    const [never] = parseServiceLines(sLine({ name: "A", state: "Stopped", mode: "Manual", exit: 1077 }));
    const [crashed] = parseServiceLines(sLine({ name: "B", state: "Stopped", exit: 1066, svcExit: 42 }));
    expect(toWindowsServiceInfo(never!).failed).toBe(false);
    expect(toWindowsServiceInfo(crashed!)).toMatchObject({ failed: true, subState: "exit code 42" });
  });

  test("startup types read like the Services console", () => {
    expect(startupType({ startMode: "Auto", delayedAutoStart: true })).toBe("automatic (delayed)");
    expect(startupType({ startMode: "Disabled", delayedAutoStart: false })).toBe("disabled");
  });
});

describe("windowsRefusals", () => {
  test("critical services cannot be stopped, restarted or disabled — but can be started", () => {
    const [row] = parseServiceLines(sLine({ name: "RpcSs" }));
    const refused = windowsRefusals(row!)!;
    expect(Object.keys(refused).sort()).toEqual(["disable", "restart", "stop"]);
  });

  test("a running service that does not accept stop is refused stop and restart", () => {
    const [row] = parseServiceLines(sLine({ name: "Foo", acceptStop: false }));
    expect(Object.keys(windowsRefusals(row!)!).sort()).toEqual(["restart", "stop"]);
  });

  test("an ordinary service has no refusals", () => {
    const [row] = parseServiceLines(sLine({ name: "Spooler" }));
    expect(windowsRefusals(row!)).toBeUndefined();
  });
});

describe("details and events", () => {
  test("extra fields and events, oldest first", () => {
    const text = [
      ["X", toB64("C:\\svc.exe -k x"), toB64("LocalSystem"), toB64("Does things")].join("\t"),
      ["E", String(638_000_000_000_000_000n + 20_000_000n), toB64("second")].join("\t"),
      ["E", String(638_000_000_000_000_000n), toB64("first")].join("\t"),
    ].join("\n");
    expect(parseExtraLine(text)).toEqual({ pathName: "C:\\svc.exe -k x", startName: "LocalSystem", description: "Does things" });
    const events = parseEventLines(text);
    expect(events.map((e) => e.message)).toEqual(["first", "second"]);
    expect(events[1]!.ts! - events[0]!.ts!).toBe(2000);
  });
});

describe("scripts", () => {
  test("a service name reaches PowerShell only as base64", () => {
    const evil = "x'; Remove-Item C:\\ -Recurse; '";
    for (const script of [detailsScript(evil), actionScript(evil, "stop")]) {
      expect(script).not.toContain("Remove-Item");
      expect(script).toContain(toB64(evil));
    }
  });

  test("names with wildcards, separators or control characters are rejected", () => {
    expect(isPlausibleWindowsServiceName("Spooler")).toBe(true);
    expect(isPlausibleWindowsServiceName("OneSyncSvc_1a2b3")).toBe(true);
    for (const bad of ["*", "a?b", "a/b", "a\\b", "a\nb", ""]) expect(isPlausibleWindowsServiceName(bad)).toBe(false);
  });
});

describe("createWindowsServicesBackend", () => {
  const listing = [sLine({ name: "Spooler", pid: 1 }), sLine({ name: "RpcSs", pid: 2 }), sLine({ name: "Fax", state: "Stopped", mode: "Manual" })].join("\n");

  test("lists every service in the system scope, with refusals attached", async () => {
    const snap = await createWindowsServicesBackend(async () => listing).collect();
    expect(snap).toMatchObject({ supported: true, manager: "scm" });
    expect(snap.services).toHaveLength(3);
    expect(snap.services.find((s) => s.unit === "RpcSs")!.refused?.stop).toBeDefined();
  });

  test("a PowerShell failure is unsupported with the reason, not a throw", async () => {
    const snap = await createWindowsServicesBackend(async () => { throw new Error("boom"); }).collect();
    expect(snap.supported).toBe(false);
    expect(snap.warnings[0]).toContain("boom");
  });

  /**
   * A stand-in SCM that answers the action script the way PowerShell would, from state it
   * holds itself — so a decision made from a stale listing shows up as the wrong command.
   */
  function fakeScm(initial: Record<string, { state: "Running" | "Stopped"; canStop?: boolean }>) {
    const state = structuredClone(initial);
    const executed: string[] = [];
    const run = async (script: string) => {
      if (script.includes("Get-CimInstance Win32_Service -Property")) {
        return Object.entries(state).map(([name, s]) => sLine({ name, state: s.state, acceptStop: s.canStop !== false })).join("\n");
      }
      const name = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(script)![1]!, "base64").toString();
      const svc = state[name]!;
      const action = /(Start|Stop|Restart|Set)-Service/.exec(script)![1]!;
      if (action === "Start" && svc.state === "Running" && script.includes("NOOP running")) return "NOOP running";
      if (action === "Stop" && svc.state === "Stopped" && script.includes("NOOP stopped")) return "NOOP stopped";
      if ((action === "Stop" || action === "Restart") && svc.state === "Running" && svc.canStop === false) return "REFUSED";
      executed.push(`${action} ${name}`);
      if (action === "Start" || action === "Restart") svc.state = "Running";
      if (action === "Stop") svc.state = "Stopped";
      return "OK";
    };
    return { run, executed, state };
  }

  test("critical services are refused by name, even before any listing", async () => {
    const scm = fakeScm({ RpcSs: { state: "Running" }, Audiosrv: { state: "Running" } });
    const backend = createWindowsServicesBackend(scm.run);
    for (const action of ["stop", "restart", "disable"] as const) {
      await expect(backend.action("RpcSs", "system", action)).rejects.toBeInstanceOf(ServiceActionRefused);
    }
    await expect(backend.action("Audiosrv", "system", "stop")).rejects.toBeInstanceOf(ServiceActionRefused);
    expect(scm.executed).toEqual([]);
  });

  test("no-ops are decided from the service's live state, not the last listing", async () => {
    const scm = fakeScm({ Spooler: { state: "Running" } });
    const backend = createWindowsServicesBackend(scm.run);
    await backend.collect(); // lists Spooler as running
    await backend.action("Spooler", "system", "stop");
    // The listing still says running; the start must still happen.
    const started = await backend.action("Spooler", "system", "start");
    expect(started.note).toBeUndefined();
    expect(scm.executed).toEqual(["Stop Spooler", "Start Spooler"]);
    expect((await backend.action("Spooler", "system", "start")).note).toContain("already running");
    expect(scm.executed).toHaveLength(2);
  });

  test("a running service that cannot stop is refused, from live state", async () => {
    const scm = fakeScm({ Foo: { state: "Running", canStop: false } });
    await expect(createWindowsServicesBackend(scm.run).action("Foo", "system", "stop")).rejects.toBeInstanceOf(ServiceActionRefused);
    expect(scm.executed).toEqual([]);
  });

  test("a PowerShell error surfaces as the action's error", async () => {
    const backend = createWindowsServicesBackend(async () => "__ERR__ Cannot open Spooler service");
    await expect(backend.action("Spooler", "system", "stop")).rejects.toThrow("Cannot open Spooler service");
  });

  test("the action script never uses `return`, which would end the session's loop", () => {
    for (const action of ["start", "stop", "restart", "enable", "disable"] as const) {
      expect(actionScript("Spooler", action)).not.toMatch(/\breturn\b/);
    }
  });
});

describe("queuedRunner", () => {
  test("runs one request at a time, in order, and a failure does not block the next", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const run = queuedRunner({
      request: async (s: string) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5);
        inFlight--; order.push(s);
        if (s === "bad") throw new Error("bad");
        return s;
      },
    });
    const results = await Promise.allSettled([run("a"), run("bad"), run("c")]);
    expect(order).toEqual(["a", "bad", "c"]);
    expect(maxInFlight).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
