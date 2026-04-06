import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { portForwardingRoutes, activeTunnels, stopAllPortTunnels } from "../../../src/server/routes/port-forwarding.ts";

function createApp() {
  return new Hono().route("/api/preview", portForwardingRoutes);
}

/** Create a fake tunnel entry for testing (no real process) */
function injectFakeTunnel(port: number, url: string) {
  activeTunnels.set(port, {
    port,
    url,
    process: { pid: -1, kill: () => {} } as any,
    startedAt: Date.now(),
  });
}

beforeEach(() => {
  activeTunnels.clear();
});

describe("port forwarding routes", () => {
  // --- POST /api/preview/tunnel (validation) ---
  describe("POST /api/preview/tunnel", () => {
    it("rejects missing port", async () => {
      const app = createApp();
      const res = await app.request("/api/preview/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it("rejects port 0", async () => {
      const app = createApp();
      const res = await app.request("/api/preview/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: 0 }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects port > 65535", async () => {
      const app = createApp();
      const res = await app.request("/api/preview/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: 70000 }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects negative port", async () => {
      const app = createApp();
      const res = await app.request("/api/preview/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: -1 }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const app = createApp();
      const res = await app.request("/api/preview/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("returns existing tunnel if already running", async () => {
      injectFakeTunnel(3000, "https://test-tunnel.trycloudflare.com");
      const app = createApp();
      const res = await app.request("/api/preview/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: 3000 }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.port).toBe(3000);
      expect(json.data.url).toBe("https://test-tunnel.trycloudflare.com");
    });
  });

  // --- GET /api/preview/tunnels ---
  describe("GET /api/preview/tunnels", () => {
    it("returns empty list when no tunnels", async () => {
      const app = createApp();
      const res = await app.request("/api/preview/tunnels");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toEqual([]);
    });

    it("returns active tunnels", async () => {
      injectFakeTunnel(3000, "https://a.trycloudflare.com");
      injectFakeTunnel(5174, "https://b.trycloudflare.com");
      const app = createApp();
      const res = await app.request("/api/preview/tunnels");
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0].port).toBe(3000);
      expect(json.data[1].port).toBe(5174);
      expect(json.data[0].url).toBe("https://a.trycloudflare.com");
      expect(json.data[1].url).toBe("https://b.trycloudflare.com");
      expect(typeof json.data[0].startedAt).toBe("number");
    });
  });

  // --- DELETE /api/preview/tunnel/:port ---
  describe("DELETE /api/preview/tunnel/:port", () => {
    it("stops and removes an active tunnel", async () => {
      let killed = false;
      activeTunnels.set(8080, {
        port: 8080,
        url: "https://x.trycloudflare.com",
        process: { pid: -1, kill: () => { killed = true; } } as any,
        startedAt: Date.now(),
      });

      const app = createApp();
      const res = await app.request("/api/preview/tunnel/8080", { method: "DELETE" });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.port).toBe(8080);
      expect(killed).toBe(true);
      expect(activeTunnels.has(8080)).toBe(false);
    });

    it("returns 404 for non-existent tunnel", async () => {
      const app = createApp();
      const res = await app.request("/api/preview/tunnel/9999", { method: "DELETE" });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // --- stopAllPortTunnels ---
  describe("stopAllPortTunnels", () => {
    it("kills all tunnels and clears the map", () => {
      const kills: number[] = [];
      activeTunnels.set(3000, {
        port: 3000, url: "https://a.trycloudflare.com",
        process: { pid: -1, kill: () => kills.push(3000) } as any,
        startedAt: Date.now(),
      });
      activeTunnels.set(5174, {
        port: 5174, url: "https://b.trycloudflare.com",
        process: { pid: -1, kill: () => kills.push(5174) } as any,
        startedAt: Date.now(),
      });

      stopAllPortTunnels();
      expect(activeTunnels.size).toBe(0);
      expect(kills).toContain(3000);
      expect(kills).toContain(5174);
    });

    it("handles kill() throwing without crashing", () => {
      activeTunnels.set(4000, {
        port: 4000, url: "https://c.trycloudflare.com",
        process: { pid: -1, kill: () => { throw new Error("already dead"); } } as any,
        startedAt: Date.now(),
      });

      expect(() => stopAllPortTunnels()).not.toThrow();
      expect(activeTunnels.size).toBe(0);
    });
  });
});
