import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createResourceRoutes } from "../../../src/server/routes/resources.ts";
import { SystemMetricsService, MAX_STREAM_SUBSCRIBERS } from "../../../src/services/system-metrics/system-metrics.service.ts";
import type { PlatformCollectors } from "../../../src/services/system-metrics/system-metrics-platform.ts";
import type { RawProcessRow } from "../../../src/services/system-metrics/process-collector-types.ts";

const row = (pid: number, ppid: number, name: string, startedAt: number): RawProcessRow =>
  ({ pid, ppid, name, command: null, cpuMs: 0, ramMB: 1, startedAt });

function harness() {
  let clock = 5_000_000;
  const killed: number[] = [];
  const collectors: PlatformCollectors = {
    platform: "linux",
    processes: { collect: async () => ({ rows: [row(1, 0, "systemd", 1), row(300, 1, "bun", 10), row(400, 1, "notepad", 20)], warnings: [] }), stop: () => {} },
    diskNet: async () => ({ disk: null, net: null, warnings: [] }),
    gpus: { collect: async () => [], isDisabled: () => false },
  };
  const service = new SystemMetricsService({
    collectors,
    intervals: { full: 20, light: 20 },
    idleTeardownMs: 20,
    leaseTimeoutMs: 1000,
    now: () => clock,
    resolveProtected: () => ({ pids: new Set([300]), roots: new Set([300]), selfPid: 300 }),
    execute: async (pid, tree) => { killed.push(pid); return { pid, tree, method: "signal", killed: [pid] }; },
    log: () => {},
    exitHooks: false,
  });
  const app = new Hono().route("/api/system", createResourceRoutes(service));
  return { app, service, killed, advanceClock: (ms: number) => { clock += ms; } };
}

const KILL_HEADERS = { "Content-Type": "application/json", "X-PPM-Request": "1" };
const decoder = new TextDecoder();

/** Read SSE text until `until` appears (or the stream ends). */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until: string): Promise<string> {
  let buf = "";
  while (!buf.includes(until)) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf;
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe("GET /api/system/resources", () => {
  test("envelope with null before any tick; ?processes gates rows vs the light projection", async () => {
    const { app, service } = harness();
    cleanup = () => service.shutdown();
    expect(await (await app.request("/api/system/resources")).json()).toEqual({ ok: true, data: null });

    service.subscribe({ tier: "full", deliver: () => {}, close: () => {} });
    await new Promise((r) => setTimeout(r, 40));
    const full = await (await app.request("/api/system/resources?processes=1")).json();
    expect(full.ok).toBe(true);
    expect(full.data.tier).toBe("full");
    expect(full.data.processes).toHaveLength(3);
    expect(full.data.total.processCount).toBe(3);
    const light = await (await app.request("/api/system/resources?processes=0")).json();
    expect(light.data.tier).toBe("light");
    expect(light.data.processes).toEqual([]);
    expect(light.data.system.cpu.cores.length).toBeGreaterThan(0);
  });
});

describe("GET /api/system/resources/stream", () => {
  test("emits retry, a session frame with sid/tier/intervalMs, then snapshot frames; DELETE ends it", async () => {
    const { app, service } = harness();
    cleanup = () => service.shutdown();
    const res = await app.request("/api/system/resources/stream?processes=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const head = await readUntil(reader, "event: snapshot");
    expect(head.startsWith("retry: 5000\n\n")).toBe(true);
    const session = JSON.parse(/event: session\ndata: (.*)\n/.exec(head)![1]!);
    expect(session).toEqual({ sid: expect.stringMatching(/^[a-f0-9]{8}$/), tier: "full", intervalMs: 20 });
    expect(service.liveCount("full")).toBe(1);

    const ping = await app.request(`/api/system/resources/stream/${session.sid}/ping`, { method: "POST" });
    expect(await ping.json()).toEqual({ ok: true, data: { alive: true } });

    const del = await app.request(`/api/system/resources/stream/${session.sid}`, { method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true, data: { stopped: true } });
    expect(service.liveCount()).toBe(0);
    const again = await app.request(`/api/system/resources/stream/${session.sid}`, { method: "DELETE" });
    expect(await again.json()).toEqual({ ok: true, data: { stopped: false } });
  });

  test("default tier is light", async () => {
    const { app, service } = harness();
    cleanup = () => service.shutdown();
    const res = await app.request("/api/system/resources/stream");
    const head = await readUntil(res.body!.getReader(), "event: session");
    expect(head).toContain('"tier":"light"');
  });

  test("ping of an unknown, expired or malformed sid → 404", async () => {
    const { app, service } = harness();
    cleanup = () => service.shutdown();
    expect((await app.request("/api/system/resources/stream/deadbeef/ping", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/system/resources/stream/%3Cscript%3E/ping", { method: "POST" })).status).toBe(404);
  });

  test("429 once five leases are live; a slot frees when a lease expires", async () => {
    const { app, service, advanceClock } = harness();
    cleanup = () => service.shutdown();
    for (let i = 0; i < MAX_STREAM_SUBSCRIBERS; i++) {
      expect((await app.request("/api/system/resources/stream")).status).toBe(200);
    }
    expect((await app.request("/api/system/resources/stream")).status).toBe(429);
    advanceClock(2000);
    expect((await app.request("/api/system/resources/stream")).status).toBe(200);
  });
});

describe("POST /api/system/resources/kill", () => {
  test("400 without JSON content type or the X-PPM-Request header, and on a malformed body", async () => {
    const { app, service, killed } = harness();
    cleanup = () => service.shutdown();
    const body = JSON.stringify({ pid: 400, startedAt: 20 });
    expect((await app.request("/api/system/resources/kill", { method: "POST", body, headers: { "Content-Type": "application/json" } })).status).toBe(400);
    expect((await app.request("/api/system/resources/kill", { method: "POST", body, headers: { "Content-Type": "text/plain", "X-PPM-Request": "1" } })).status).toBe(400);
    expect((await app.request("/api/system/resources/kill", { method: "POST", body: "{not json", headers: KILL_HEADERS })).status).toBe(400);
    expect((await app.request("/api/system/resources/kill", { method: "POST", body: JSON.stringify({ pid: "400" }), headers: KILL_HEADERS })).status).toBe(400);
    expect(killed).toEqual([]);
  });

  test("403 guarded (reason in body), 404 gone, 409 recycled, 200 killed", async () => {
    const { app, service, killed } = harness();
    cleanup = () => service.shutdown();
    const post = (b: unknown) => app.request("/api/system/resources/kill", { method: "POST", body: JSON.stringify(b), headers: KILL_HEADERS });

    const guarded = await post({ pid: 300, startedAt: 10 });
    expect(guarded.status).toBe(403);
    expect((await guarded.json()).error).toContain("PPM process");

    expect((await post({ pid: 9999, startedAt: 0 })).status).toBe(404);
    expect((await post({ pid: 400, startedAt: 999_999 })).status).toBe(409);

    const ok = await post({ pid: 400, startedAt: 20 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, data: { pid: 400, tree: false, method: "signal", killed: [400] } });
    expect(killed).toEqual([400]);
  });
});

describe("POST /api/system/resources/kill — re-query failure", () => {
  test("a collector that throws during the live re-query yields a 500 JSON envelope, not a Hono text error", async () => {
    const { app, service } = harness();
    cleanup = () => service.shutdown();
    (service as unknown as { collectors: PlatformCollectors }).collectors.processes.collect = async () => { throw new Error("session restarting"); };
    const res = await app.request("/api/system/resources/kill", { method: "POST", body: JSON.stringify({ pid: 400, startedAt: 20 }), headers: KILL_HEADERS });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: false, error: "Could not verify the process — try again" });
  });
});

describe("mounting", () => {
  test("the resource routes are mounted under /api/system AFTER the auth middleware, so kill is never public", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../../src/server/index.ts"), "utf-8");
    const auth = src.indexOf('app.use("/api/*", authMiddleware)');
    const mount = src.indexOf('app.route("/api/system", resourceRoutes)');
    expect(auth).toBeGreaterThan(0);
    expect(mount).toBeGreaterThan(auth);
  });
});
