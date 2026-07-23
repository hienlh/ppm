import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import type { TunnelEntry } from "../../../src/services/tunnel-registry-parse.ts";

// Shared mutable state the mocks read from.
const state: { list: TunnelEntry[]; isCf: boolean; killed: number[] } = {
  list: [],
  isCf: true,
  killed: [],
};

mock.module("../../../src/services/tunnel-registry.service.ts", () => ({
  listTunnels: async () => state.list,
  isCloudflaredPid: (_pid: number) => state.isCf,
  invalidateTunnelCache: () => {},
}));

mock.module("../../../src/services/windows-process-tree.ts", () => ({
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

  it("kills a verified external tunnel", async () => {
    state.list = [entry({ pid: 700 })];
    const res = await app().request("/api/tunnels/700", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.killed).toContain(700);
  });
});
