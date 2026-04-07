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
  configService.load("nonexistent.yaml");
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
