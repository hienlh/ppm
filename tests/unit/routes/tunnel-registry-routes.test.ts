import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import type { TunnelEntry } from "../../../src/services/tunnel-registry-parse.ts";
// Captured BEFORE mock.module() runs — Bun's module mocks are process-global
// and outlive this file, so a full-replacement stub here would leak into any
// later-loaded test that imports the real module (e.g. supervisor.ts pulling
// in findPortListenerPid/isPpmProcess/etc.) and break it with a missing-export
// SyntaxError. Spreading the real exports keeps every non-overridden export intact.
import * as RealWindowsProcessTree from "../../../src/services/windows-process-tree.ts";
import * as RealTailscaleForward from "../../../src/services/port-forward/tailscale-forward.ts";
import type { TailscaleForward } from "../../../src/services/port-forward/tailscale-forward.ts";
import { forgetFramingOriginsForTest, framingOrigins } from "../../../src/services/port-forward/frame-ancestors.ts";

// Shared mutable state the mocks read from.
const state: {
  list: TunnelEntry[]; isCf: boolean; killed: number[];
  tailscale: TailscaleForward[]; tailscaleError: string | null; tailscaleStopped: number[];
} = {
  list: [],
  isCf: true,
  killed: [],
  tailscale: [],
  tailscaleError: null,
  tailscaleStopped: [],
};

mock.module("../../../src/services/tunnel-registry.service.ts", () => ({
  listTunnels: async () => state.list,
  isCloudflaredPid: (_pid: number) => state.isCf,
  invalidateTunnelCache: () => {},
}));

mock.module("../../../src/services/windows-process-tree.ts", () => ({
  ...RealWindowsProcessTree,
  killProcessTree: (pid: number) => { state.killed.push(pid); },
}));

mock.module("../../../src/server/routes/tunnel-spawn.ts", () => ({
  activeTunnels: new Map(),
  spawnTunnelProcess: async (_port: number) => ({
    process: { pid: 111 } as any,
    url: "https://new.trycloudflare.com",
  }),
  registerTunnel: () => {},
}));

mock.module("../../../src/services/port-forward/tailscale-forward.ts", () => ({
  ...RealTailscaleForward,
  listTailscaleForwards: () => state.tailscale,
  readTailscaleAvailability: async () => ({ available: true, dnsName: "host.tail.ts.net" }),
  startTailscaleForward: async (port: number) => {
    if (state.tailscaleError) throw new Error(state.tailscaleError);
    const forward = { port, servePort: port, url: `https://host.tail.ts.net:${port}/`, pid: 900, startedAt: 1 };
    state.tailscale.push(forward);
    return forward;
  },
  stopTailscaleForwardByPid: (pid: number) => {
    if (!state.tailscale.some((f) => f.pid === pid)) return false;
    state.tailscaleStopped.push(pid);
    return true;
  },
}));

const { tunnelRegistryRoutes } = await import("../../../src/server/routes/tunnels.ts");

function app() {
  return new Hono().route("/api/tunnels", tunnelRegistryRoutes);
}
const entry = (over: Partial<TunnelEntry>): TunnelEntry => ({
  pid: 1, port: 3000, url: null, source: "external", protected: false, status: "running", ...over,
});

beforeEach(() => {
  state.list = [];
  state.isCf = true;
  state.killed = [];
  state.tailscale = [];
  state.tailscaleError = null;
  state.tailscaleStopped = [];
});

const post = (body: unknown) => app().request("/api/tunnels", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

describe("GET /api/tunnels", () => {
  it("returns the unified list", async () => {
    state.list = [entry({ pid: 42, source: "ppm", url: "https://a.trycloudflare.com" })];
    const res = await app().request("/api/tunnels");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].pid).toBe(42);
  });

  it("lists Tailscale forwards after the cloudflared processes, marked as such", async () => {
    state.list = [entry({ pid: 42, source: "ppm" })];
    state.tailscale = [{ port: 5173, servePort: 5173, url: "https://host.tail.ts.net:5173/", pid: 77, startedAt: 5 }];
    const json = await (await app().request("/api/tunnels")).json();
    expect(json.data.map((t: TunnelEntry) => [t.pid, t.via])).toEqual([[42, undefined], [77, "tailscale"]]);
    expect(json.data[1]).toMatchObject({ port: 5173, url: "https://host.tail.ts.net:5173/", source: "ppm", protected: false });
  });
});

describe("GET /api/tunnels/transports", () => {
  it("answers whether Tailscale can carry a forward", async () => {
    const json = await (await app().request("/api/tunnels/transports")).json();
    expect(json.data).toEqual({ tailscale: { available: true, dnsName: "host.tail.ts.net" } });
  });
});

describe("POST /api/tunnels/frame-ancestors", () => {
  const ask = (body: unknown) => app().request("/api/tunnels/frame-ancestors", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("lets the origin PPM is open at frame forwarded pages", async () => {
    forgetFramingOriginsForTest();
    const res = await ask({ origin: "http://192.168.1.20:3210" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ origin: "http://192.168.1.20:3210" });
    expect(framingOrigins()).toEqual(["http://192.168.1.20:3210"]);
    forgetFramingOriginsForTest();
  });

  it("refuses what a Content-Security-Policy cannot name", async () => {
    forgetFramingOriginsForTest();
    for (const body of [{ origin: "http://[::1]:3210" }, { origin: "http://a.example; script-src *" }, {}]) {
      expect((await ask(body)).status).toBe(400);
    }
    expect(framingOrigins()).toEqual([]);
  });
});

describe("POST /api/tunnels", () => {
  it("rejects invalid port", async () => {
    const res = await app().request("/api/tunnels", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("starts a tunnel for a valid port", async () => {
    const res = await app().request("/api/tunnels", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 3000 }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.url).toBe("https://new.trycloudflare.com");
    expect(json.data.via).toBe("cloudflare");
  });

  it("forwards over Tailscale when asked", async () => {
    const res = await post({ port: 5173, via: "tailscale" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ port: 5173, url: "https://host.tail.ts.net:5173/", via: "tailscale" });
  });

  it("reports why a Tailscale forward could not start", async () => {
    state.tailscaleError = "HTTPS certificates are off in this tailnet (Tailscale admin → DNS)";
    const res = await post({ port: 5173, via: "tailscale" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(state.tailscaleError);
  });

  it("rejects an unknown transport and a fractional port", async () => {
    expect((await post({ port: 5173, via: "ngrok" })).status).toBe(400);
    expect((await post({ port: 5173.5 })).status).toBe(400);
  });
});

describe("DELETE /api/tunnels/:pid", () => {
  it("404 when pid not in registry", async () => {
    const res = await app().request("/api/tunnels/9999", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(state.killed).toHaveLength(0);
  });

  it("409 for a protected app tunnel (no force path)", async () => {
    state.list = [entry({ pid: 500, source: "app", protected: true })];
    const res = await app().request("/api/tunnels/500", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(state.killed).toHaveLength(0);
  });

  it("409 when the PID is no longer cloudflared (image spoof / reuse)", async () => {
    state.list = [entry({ pid: 600 })];
    state.isCf = false;
    const res = await app().request("/api/tunnels/600", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(state.killed).toHaveLength(0);
  });

  it("stops a Tailscale forward without touching any cloudflared", async () => {
    state.tailscale = [{ port: 5173, servePort: 5173, url: "https://host.tail.ts.net:5173/", pid: 77, startedAt: 5 }];
    const res = await app().request("/api/tunnels/77", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.tailscaleStopped).toEqual([77]);
    expect(state.killed).toHaveLength(0);
  });

  it("kills a verified external tunnel", async () => {
    state.list = [entry({ pid: 700 })];
    const res = await app().request("/api/tunnels/700", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.killed).toContain(700);
  });
});
