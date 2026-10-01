import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemServiceRoutes } from "../../../src/server/routes/system-services.ts";
import { createResourceRoutes } from "../../../src/server/routes/resources.ts";
import { SystemMetricsService } from "../../../src/services/system-metrics/system-metrics.service.ts";
import type { PlatformCollectors } from "../../../src/services/system-metrics/system-metrics-platform.ts";
import { createDarwinAppIconService, type AppIconService } from "../../../src/services/system-services/app-icon-service.ts";
import type { SystemdDeps } from "../../../src/services/system-services/systemd-collector.ts";
import { systemdBackend } from "../../../src/services/system-services/service-backend.ts";
import { createLaunchdBackend } from "../../../src/services/system-services/launchd-collector.ts";
import { NOT_ROOT_REASON } from "../../../src/services/system-services/launchd-guard.ts";
import type { RunResult } from "../../../src/services/host-info/spawn-runner.ts";

const okRun = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false });
const LIST = "sshd.service loaded active running OpenSSH Daemon\nppm.service loaded active running PPM";
const SHOW = "Id=sshd.service\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=850\n\n"
  + "Id=ppm.service\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=99";

function servicesApp(reply: (argv: string[]) => RunResult = (argv) =>
  okRun(argv.includes("list-units") ? LIST : argv.includes("show") ? SHOW : "")) {
  const calls: string[][] = [];
  const deps: SystemdDeps = {
    run: async (argv) => { calls.push(argv); return reply(argv); },
    // Verbatim `/proc/self/cgroup` contents, trailing newline included: that is what
    // the collector reads, and a bare path here would not exercise the parser at all.
    guard: { selfCgroup: "0::/user.slice/user@1000.service/app.slice/ppm.service\n" },
  };
  const app = new Hono();
  app.route("/api/system", createSystemServiceRoutes(systemdBackend(deps)));
  return { app, calls };
}

const post = (app: Hono, path: string, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PPM-Request": "1", ...headers },
    body: "{}",
  });

describe("GET /services", () => {
  test("both scopes in one snapshot, each row carrying its refusals", async () => {
    const { app } = servicesApp();
    const res = await app.request("/api/system/services");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.supported).toBe(true);
    const ppm = body.data.services.find((s: { unit: string }) => s.unit === "ppm.service");
    expect(ppm.refused.stop).toContain("PPM itself");
  });
});

describe("GET /services/:scope/:unit", () => {
  const detail = "Id=sshd.service\nLoadState=loaded\nActiveState=active\nSubState=running\n"
    + "UnitFileState=enabled\nMainPID=850\nFragmentPath=/usr/lib/systemd/system/sshd.service";

  test("details come back with the unit's journal", async () => {
    const { app } = servicesApp((argv) => okRun(argv[0] === "journalctl"
      ? JSON.stringify({ __REALTIME_TIMESTAMP: "1700000000000000", MESSAGE: "ready" })
      : detail));
    const res = await app.request("/api/system/services/system/sshd.service");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.fragmentPath).toBe("/usr/lib/systemd/system/sshd.service");
    expect(body.data.logs).toEqual([{ ts: 1700000000000, message: "ready" }]);
  });

  test("a bad scope or a name that is not a unit name never reaches systemctl", async () => {
    const { app, calls } = servicesApp();
    expect((await app.request("/api/system/services/root/sshd.service")).status).toBe(400);
    expect((await app.request("/api/system/services/system/not-a-unit")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("an unknown unit is a 404", async () => {
    const { app } = servicesApp(() => okRun("Id=x.service\nLoadState=not-found"));
    expect((await app.request("/api/system/services/system/x.service")).status).toBe(404);
  });
});

describe("POST /services/:scope/:unit/:action", () => {
  test("an allowed action runs and reports what it did", async () => {
    const { app, calls } = servicesApp(() => okRun(""));
    const res = await post(app, "/api/system/services/user/foo.service/restart");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ unit: "foo.service", scope: "user", action: "restart" });
    expect(calls[0]).toContain("--no-ask-password");
  });

  test("PPM's own unit is a 403 and is never spawned", async () => {
    const { app, calls } = servicesApp(() => okRun(""));
    const res = await post(app, "/api/system/services/user/ppm.service/stop");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("PPM itself");
    expect(calls).toEqual([]);
  });

  test("a cross-origin form cannot reach it: both headers are required", async () => {
    const { app, calls } = servicesApp(() => okRun(""));
    expect((await post(app, "/api/system/services/user/foo.service/stop", { "X-PPM-Request": "" })).status).toBe(400);
    const form = await app.request("/api/system/services/user/foo.service/stop", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-PPM-Request": "1" },
      body: "x=1",
    });
    expect(form.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("an action that is not an action is a 400", async () => {
    const { app, calls } = servicesApp(() => okRun(""));
    expect((await post(app, "/api/system/services/user/foo.service/mask")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a systemd failure is a 500 carrying its reason", async () => {
    const { app } = servicesApp(() => ({ stdout: "", stderr: "Unit foo.service not loaded.", code: 1, timedOut: false }));
    const res = await post(app, "/api/system/services/user/foo.service/stop");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("not loaded");
  });
});

describe("on launchd", () => {
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dir, "..", "services", "system-services", "fixtures", "darwin", name), "utf8");

  function launchdApp() {
    const calls: string[][] = [];
    const reply = (argv: string[]): RunResult => {
      const [tool, verb, target] = argv;
      if (tool === "ps") return okRun("  900 98871\n98871     1\n");
      if (verb === "print" && target === "gui/501") return okRun(fixture("launchctl-print-gui.txt"));
      if (verb === "print" && target === "system") return okRun(fixture("launchctl-print-system.txt"));
      if (verb === "print" && target === "gui/501/com.hienlh.ppm") return okRun(fixture("launchctl-print-job-ppm.txt"));
      if (verb === "print" && target?.includes("/")) {
        return { stdout: "", stderr: `Bad request.\nCould not find service "${target.split("/").pop()}"\n`, code: 113, timedOut: false };
      }
      return okRun("");
    };
    const backend = createLaunchdBackend({
      run: async (argv) => { calls.push(argv); return reply(argv); },
      uid: 501,
      userName: "user",
      pid: 900,
      serviceName: undefined,
      logs: { read: async () => ({ lines: [], source: { kind: "unified", minutes: 5 } }) },
      jobIndex: { update: () => {}, keysFor: () => new Map() },
    });
    const app = new Hono();
    app.route("/api/system", createSystemServiceRoutes(backend));
    const changes = () => calls.filter(([tool, verb]) => tool === "launchctl" && verb !== "print" && verb !== "print-disabled");
    return { app, calls, changes };
  }

  test("the snapshot says which manager answered", async () => {
    const body = await (await launchdApp().app.request("/api/system/services")).json();
    expect(body.data.manager).toBe("launchd");
    expect(body.data.supported).toBe(true);
  });

  test("a label that is not one never reaches launchctl", async () => {
    const { app, calls } = launchdApp();
    for (const attempt of ["gui%2F501%2Fcom.example.x", "a%20b", "..%2F..%2Fsystem"]) {
      const res = await app.request(`/api/system/services/user/${attempt}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Not a job label");
    }
    expect(calls).toEqual([]);
  });

  test("an unknown label is a 404 in launchd's words", async () => {
    const res = await launchdApp().app.request("/api/system/services/user/com.example.gone");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No job named com.example.gone");
  });

  test("PPM's own job cannot be stopped from the page it serves", async () => {
    const { app, changes } = launchdApp();
    const res = await post(app, "/api/system/services/user/com.hienlh.ppm/stop");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("PPM itself");
    expect(changes()).toEqual([]);
  });

  test("a system job is a 403 for a PPM that is not root", async () => {
    const { app, changes } = launchdApp();
    const res = await post(app, "/api/system/services/system/com.apple.fseventsd/restart");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(NOT_ROOT_REASON);
    expect(changes()).toEqual([]);
  });

  test("the user's own job goes to launchctl, and what launchctl says comes back", async () => {
    const { app, changes } = launchdApp();
    const res = await post(app, "/api/system/services/user/com.example.crashy-agent/stop");
    // The fixture has no print for it: launchctl says it does not know the job.
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Could not find service");
    expect(changes()).toEqual([]);
    const started = await post(app, "/api/system/services/user/com.example.crashy-agent/start");
    expect(started.status).toBe(200);
    expect(changes()).toEqual([["launchctl", "kickstart", "gui/501/com.example.crashy-agent"]]);
  });
});

describe("GET /app-icon/:id", () => {
  let dir = "";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-icon-"));
    writeFileSync(join(dir, "code.svg"), svg);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function iconApp(
    // The route can only ever serve what THIS resolver returned for an app id.
    icons: AppIconService = { path: (id) => (id === "code" ? join(dir, "code.svg") : id === "ghost" ? join(dir, "gone.svg") : null) },
  ) {
    const collectors: PlatformCollectors = {
      platform: "linux",
      processes: { collect: async () => ({ rows: [], warnings: [] }), stop: () => {} },
      diskNet: async () => ({ disk: null, net: null, warnings: [] }),
      gpus: { collect: async () => [], isDisabled: () => false },
      devices: null,
      apps: null,
    };
    const service = new SystemMetricsService({ collectors, exitHooks: false, log: () => {} });
    const app = new Hono();
    app.route("/api/system", createResourceRoutes(
      service,
      async () => ({ platform: "linux", ts: 1, disks: [], nics: [], gpus: [] }),
      icons,
    ));
    return { app, service };
  }

  test("a known app's icon is served with its own media type", async () => {
    const { app, service } = iconApp();
    const res = await app.request("/api/system/app-icon/code");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toBe(svg);
    service.shutdown();
  });

  test("an unknown app, and a resolved path whose file is gone, are both 404", async () => {
    const { app, service } = iconApp();
    expect((await app.request("/api/system/app-icon/nope")).status).toBe(404);
    expect((await app.request("/api/system/app-icon/ghost")).status).toBe(404);
    service.shutdown();
  });

  test("the route takes an app id, so a path cannot be asked for", async () => {
    const { app, service } = iconApp();
    // Nothing here resolves: the resolver is keyed by id and knows only "code".
    for (const attempt of ["..", "%2e%2e", "etc", "..%2fetc%2fshadow"]) {
      expect((await app.request(`/api/system/app-icon/${attempt}`)).status).not.toBe(200);
    }
    service.shutdown();
  });

  test("macOS: a listed app's PNG is served once its conversion finishes", async () => {
    writeFileSync(join(dir, "chrome.png"), "png");
    const { app, service } = iconApp(createDarwinAppIconService(
      { iconSource: (id) => (id === "com.google.Chrome" ? { bundle: "/Applications/Google Chrome.app", iconPath: "/x/app.icns" } : null) },
      { png: async () => { await Bun.sleep(5); return join(dir, "chrome.png"); } },
    ));
    const res = await app.request("/api/system/app-icon/com.google.Chrome");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    service.shutdown();
  });

  test("macOS: a path, however it is encoded, reaches neither the app list nor sips", async () => {
    const asked: string[] = [];
    const { app, service } = iconApp(createDarwinAppIconService(
      { iconSource: (id) => { asked.push(id); return null; } },
      { png: async () => { throw new Error("must not convert"); } },
    ));
    for (const attempt of ["..%2F..%2Fetc%2Fpasswd", "..%2fetc%2fshadow", "%2e%2e", "com.google.Chrome"]) {
      expect((await app.request(`/api/system/app-icon/${attempt}`)).status).toBe(404);
    }
    // Only the one id shaped like an id was looked up, and it was not listed.
    expect(asked).toEqual(["com.google.Chrome"]);
    service.shutdown();
  });
});
