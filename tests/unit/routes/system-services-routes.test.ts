import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemServiceRoutes } from "../../../src/server/routes/system-services.ts";
import { createResourceRoutes } from "../../../src/server/routes/resources.ts";
import { SystemMetricsService } from "../../../src/services/system-metrics/system-metrics.service.ts";
import type { PlatformCollectors } from "../../../src/services/system-metrics/system-metrics-platform.ts";
import type { SystemdDeps } from "../../../src/services/system-services/systemd-collector.ts";
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
    guard: { selfCgroup: "/user.slice/user@1000.service/app.slice/ppm.service" },
  };
  const app = new Hono();
  app.route("/api/system", createSystemServiceRoutes(deps));
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

describe("GET /app-icon/:id", () => {
  let dir = "";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-icon-"));
    writeFileSync(join(dir, "code.svg"), svg);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function iconApp() {
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
      // The route can only ever serve what THIS resolver returned for an app id.
      { path: (id) => (id === "code" ? join(dir, "code.svg") : id === "ghost" ? join(dir, "gone.svg") : null) },
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
});
