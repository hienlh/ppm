import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createResourceRoutes } from "../../../src/server/routes/resources.ts";
import { SystemMetricsService } from "../../../src/services/system-metrics/system-metrics.service.ts";
import type { PlatformCollectors } from "../../../src/services/system-metrics/system-metrics-platform.ts";
import type { RawProcessRow } from "../../../src/services/system-metrics/process-collector-types.ts";
import type { MetricsPlatform, MetricsSnapshot, ProcessDetails } from "../../../src/types/system-metrics.ts";

const row = (pid: number, ppid: number, name: string, startedAt: number): RawProcessRow =>
  ({ pid, ppid, name, command: null, cpuMs: 0, ramMB: 1, startedAt });

const DETAILS: ProcessDetails = {
  pid: 400, ppid: 1, name: "vim", startedAt: 20, command: "vim notes.md",
  exe: "/usr/bin/vim", cwd: "/home/t", user: "t", state: "S (Sleeping)",
  threads: 1, nice: 0, cgroup: "/user.slice/vim.scope",
};

const live: SystemMetricsService[] = [];
afterEach(() => { for (const s of live.splice(0)) s.shutdown(); });

function harness(platform: MetricsPlatform = "linux") {
  const sent: Array<[number, string, boolean]> = [];
  const collectors: PlatformCollectors = {
    platform,
    processes: {
      collect: async () => ({ rows: [row(1, 0, "systemd", 1), row(300, 1, "bun", 10), row(400, 1, "vim", 20)], warnings: [] }),
      stop: () => {},
    },
    diskNet: async () => ({ disk: null, net: null, warnings: [] }),
    gpus: { collect: async () => [], isDisabled: () => false },
    devices: null,
    apps: null,
  };
  const service = new SystemMetricsService({
    collectors,
    intervals: { full: 20, light: 20 },
    idleTeardownMs: 20,
    leaseTimeoutMs: 1000,
    now: () => 5_000_000,
    resolveProtected: () => ({ pids: new Set([300]), roots: new Set([300]), selfPid: 300 }),
    executeSignal: async (pid, signal, tree) => {
      sent.push([pid, signal, tree]);
      return { pid, signal, tree, method: "signal", signalled: [pid] };
    },
    details: (pid) => (pid === 400 ? DETAILS : null),
    log: () => {},
    exitHooks: false,
  });
  live.push(service);
  const app = new Hono();
  app.route("/api/system", createResourceRoutes(service, async () => ({
    platform: "linux", ts: 1, disks: [], nics: [], gpus: [],
  })));
  return { app, service, sent };
}

const signal = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/system/resources/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PPM-Request": "1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /resources/signal", () => {
  test("an allowed signal reaches the executor and reports what was signalled", async () => {
    const { app, sent } = harness();
    const res = await signal(app, { pid: 400, startedAt: 20, signal: "USR1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ pid: 400, signal: "USR1", tree: false, method: "signal", signalled: [400] });
    expect(sent).toEqual([[400, "USR1", false]]);
  });

  test("tree is carried through rather than silently dropped", async () => {
    const { app, sent } = harness();
    await signal(app, { pid: 400, startedAt: 20, signal: "STOP", tree: true });
    expect(sent).toEqual([[400, "STOP", true]]);
  });

  test("a cross-origin form cannot reach the executor: both headers are required", async () => {
    const { app, sent } = harness();
    const noHeader = await signal(app, { pid: 400, startedAt: 20, signal: "KILL" }, { "X-PPM-Request": "" });
    expect(noHeader.status).toBe(400);
    const formType = await app.request("/api/system/resources/signal", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-PPM-Request": "1" },
      body: "pid=400",
    });
    expect(formType.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("a malformed body is a 400, not a 500", async () => {
    const { app } = harness();
    expect((await signal(app, "{not json")).status).toBe(400);
    expect((await signal(app, { pid: 400, startedAt: 20, signal: "SIGKILL" })).status).toBe(400);
    expect((await signal(app, { pid: 400, startedAt: 20 })).status).toBe(400);
  });

  test("the kill guard applies unchanged — PPM's own process cannot be suspended", async () => {
    const { app, sent } = harness();
    const res = await signal(app, { pid: 300, startedAt: 10, signal: "STOP" });
    expect(res.status).toBe(403);
    expect(sent).toEqual([]);
  });

  test("an OS-critical process is refused as firmly as it would be for a kill", async () => {
    const { app } = harness();
    expect((await signal(app, { pid: 1, startedAt: 1, signal: "STOP" })).status).toBe(403);
  });

  test("a pid that is gone is 404 and a recycled one is 409", async () => {
    const { app, sent } = harness();
    expect((await signal(app, { pid: 999, startedAt: 1, signal: "TERM" })).status).toBe(404);
    expect((await signal(app, { pid: 400, startedAt: 999999, signal: "TERM" })).status).toBe(409);
    expect(sent).toEqual([]);
  });

  test("a host that cannot deliver the signal says so instead of guessing", async () => {
    const { app, sent } = harness("win32");
    const res = await signal(app, { pid: 400, startedAt: 20, signal: "STOP" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("SIGSTOP");
    expect(sent).toEqual([]);
    expect((await signal(app, { pid: 400, startedAt: 20, signal: "TERM" })).status).toBe(200);
  });
});

describe("GET /resources/process/:pid", () => {
  test("a live pid returns the dialog's facts", async () => {
    const { app } = harness();
    const res = await app.request("/api/system/resources/process/400");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(DETAILS);
  });

  test("a pid that is gone is a 404, never an empty shell of nulls", async () => {
    const { app } = harness();
    expect((await app.request("/api/system/resources/process/999")).status).toBe(404);
  });

  test("anything that is not a positive integer is refused before the read", async () => {
    const { app } = harness();
    for (const bad of ["abc", "-1", "1.5", "0", "00", "4e2"]) {
      expect((await app.request(`/api/system/resources/process/${bad}`)).status).toBe(400);
    }
  });

  test("a traversal segment never even reaches the handler", async () => {
    const { app } = harness();
    // Hono normalises the segment away, so this matches no route at all. Worth
    // pinning anyway: the handler takes a number and is not a file read, so
    // neither layer is load-bearing on its own.
    expect((await app.request("/api/system/resources/process/%2e%2e")).status).toBe(404);
  });
});

describe("the signal menu on the snapshot", () => {
  /**
   * The scheduler ticks synchronously from the first `subscribe`, so the frame it
   * DELIVERS is what proves the menu reached the wire. A second `runTick()` would
   * not: the collector lock drops it as an overlapping poll while the first is
   * still in flight, and the assertion would then read a snapshot that does not
   * exist yet.
   */
  const firstFrame = async (platform: MetricsPlatform) => {
    const h = harness(platform);
    const snapshot = await new Promise<MetricsSnapshot>((resolve) => {
      h.service.subscribe({ tier: "full", deliver: resolve, close: () => {} });
    });
    return { snapshot, service: h.service };
  };

  test("the full tier publishes what THIS host can deliver, the light tier nothing", async () => {
    const { snapshot, service } = await firstFrame("linux");
    expect(snapshot.tier).toBe("full");
    expect(snapshot.signals).toEqual(["TERM", "KILL", "STOP", "CONT", "HUP", "INT", "USR1", "USR2"]);
    // Projected from that same frame: no process rows, so nothing to signal.
    expect(service.getLatest("light")?.signals).toBeUndefined();
  });

  test("Windows publishes only the two taskkill can mean", async () => {
    const { snapshot } = await firstFrame("win32");
    expect(snapshot.signals).toEqual(["TERM", "KILL"]);
  });
});
