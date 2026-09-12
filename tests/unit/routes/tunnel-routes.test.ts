import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { tunnelRoutes } from "../../../src/server/routes/tunnel.ts";
import { configService } from "../../../src/services/config.service.ts";
import { tunnelService } from "../../../src/services/tunnel.service.ts";

function createApp() {
  return new Hono().route("/tunnel", tunnelRoutes);
}

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  tunnelService.stopTunnel();
});

describe("GET /tunnel", () => {
  it("returns inactive tunnel initially", async () => {
    const app = createApp();
    const res = await app.request("/tunnel");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.active).toBe(false);
    expect(json.data.url).toBeNull();
    // localUrl may or may not be set depending on network
    expect(typeof json.data.localUrl).toBe("string" || "object");
  });

  it("returns response with expected structure", async () => {
    const app = createApp();
    const res = await app.request("/tunnel");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect("active" in json.data).toBe(true);
    expect("url" in json.data).toBe(true);
    expect("localUrl" in json.data).toBe(true);
  });
});

describe("POST /tunnel/stop", () => {
  it("returns stopped:true when no tunnel running", async () => {
    const app = createApp();
    const res = await app.request("/tunnel/stop", { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.stopped).toBe(true);
  });

  it("idempotent — can call stop multiple times", async () => {
    const app = createApp();
    const res1 = await app.request("/tunnel/stop", { method: "POST" });
    const res2 = await app.request("/tunnel/stop", { method: "POST" });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const json1 = await res1.json() as any;
    const json2 = await res2.json() as any;
    expect(json1.data.stopped).toBe(true);
    expect(json2.data.stopped).toBe(true);
  });
});

describe("GET /tunnel after stop", () => {
  it("shows inactive tunnel after stop", async () => {
    const app = createApp();
    await app.request("/tunnel/stop", { method: "POST" });
    const res = await app.request("/tunnel");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.active).toBe(false);
    expect(json.data.url).toBeNull();
  });
});

// POST /tunnel/start is tested by integration tests
// Unit test skipped because it spawns cloudflared process which hangs in test env
// Real test requires cloudflared binary installed and available

describe("POST /tunnel/enabled — the master switch", () => {
  it("defaults to on, so an untouched install keeps sharing", async () => {
    const app = createApp();
    const res = await app.request("/tunnel");
    const json = await res.json() as any;
    expect(json.data.enabled).toBe(true);
  });

  it("persists off and reports it back on the status route", async () => {
    const app = createApp();
    const res = await app.request("/tunnel/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.enabled).toBe(false);

    expect(configService.get("tunnel").enabled).toBe(false);
    const status = await (await app.request("/tunnel")).json() as any;
    expect(status.data.enabled).toBe(false);
  });

  it("round-trips back on", async () => {
    const app = createApp();
    const post = (enabled: boolean) => app.request("/tunnel/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await post(false);
    await post(true);
    expect(configService.get("tunnel").enabled).toBe(true);
  });

  // Turning the tunnel off is not the same as giving up a configured domain:
  // the hostname has to survive so turning it back on needs no re-setup.
  it("leaves a configured named tunnel intact when switched off", async () => {
    configService.set("tunnel", {
      enabled: true,
      mode: "named",
      namedTunnelName: "ppm-host",
      namedTunnelHostname: "ppm.hienle.tech",
      namedTunnelToken: "tok",
      zoneID: "a".repeat(32),
      accountID: "b".repeat(32),
    });
    const app = createApp();
    await app.request("/tunnel/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const tunnel = configService.get("tunnel");
    expect(tunnel.enabled).toBe(false);
    expect(tunnel.mode).toBe("named");
    expect(tunnel.namedTunnelHostname).toBe("ppm.hienle.tech");
    expect(tunnel.namedTunnelToken).toBe("tok");
  });

  it("rejects a non-boolean body without touching the stored value", async () => {
    const app = createApp();
    for (const body of ['{"enabled":"false"}', '{"enabled":0}', '{}', "not-json"]) {
      const res = await app.request("/tunnel/enabled", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(configService.get("tunnel").enabled).toBe(true);
  });
});

