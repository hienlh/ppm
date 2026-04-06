import { describe, it, expect, afterAll, beforeAll, setDefaultTimeout } from "bun:test";
import { Hono } from "hono";
import { portForwardingRoutes, activeTunnels, stopAllPortTunnels } from "../../src/server/routes/port-forwarding.ts";

setDefaultTimeout(60_000);

/**
 * Integration test: starts a real local HTTP server, creates a Cloudflare
 * tunnel via the preview API, then verifies the tunnel URL serves content.
 * Requires internet + cloudflared binary (auto-downloaded on first run).
 */

const TEST_PORT = 19880; // Unique port — avoid conflict with supervisor-resilience (19876)
const TEST_RESPONSE = "ppm-browser-preview-integration-test-ok";

let testServer: ReturnType<typeof Bun.serve> | null = null;

function createApp() {
  return new Hono().route("/api/preview", portForwardingRoutes);
}

beforeAll(() => {
  // Start a simple HTTP server for the tunnel to proxy to
  testServer = Bun.serve({
    port: TEST_PORT,
    hostname: "127.0.0.1",
    fetch() {
      return new Response(TEST_RESPONSE, {
        headers: { "Content-Type": "text/plain" },
      });
    },
  });
});

afterAll(() => {
  stopAllPortTunnels();
  testServer?.stop(true);
});

describe("port forwarding tunnel integration", () => {
  let tunnelUrl: string | null = null;

  it("creates a tunnel for a running localhost port", async () => {
    const app = createApp();
    const res = await app.request("/api/preview/tunnel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: TEST_PORT }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.port).toBe(TEST_PORT);
    expect(json.data.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);

    tunnelUrl = json.data.url;
    expect(activeTunnels.has(TEST_PORT)).toBe(true);
  });

  it("tunnel URL serves content from localhost", async () => {
    expect(tunnelUrl).not.toBeNull();

    // Verify local server is reachable first
    const localRes = await fetch(`http://127.0.0.1:${TEST_PORT}/`);
    expect(await localRes.text()).toBe(TEST_RESPONSE);

    // Wait for tunnel connection to register before first attempt
    await Bun.sleep(5_000);

    // Use curl — Bun's DNS resolver caches failures during propagation
    let body = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      const proc = Bun.spawn(
        ["curl", "-s", "-L", "--max-time", "10", "-H", "Accept: text/plain", tunnelUrl!],
        { stdout: "pipe", stderr: "pipe" },
      );
      body = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      if (body.includes(TEST_RESPONSE)) break;
      if (attempt === 0) console.log(`[test] first curl: body="${body.slice(0, 100)}" stderr="${stderr.slice(0, 100)}"`);
      await Bun.sleep(3_000);
    }

    expect(body).toContain(TEST_RESPONSE);
  });

  it("returns existing tunnel on duplicate request", async () => {
    const app = createApp();
    const res = await app.request("/api/preview/tunnel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: TEST_PORT }),
    });

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.url).toBe(tunnelUrl);
  });

  it("lists the active tunnel", async () => {
    const app = createApp();
    const res = await app.request("/api/preview/tunnels");
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
    const entry = json.data.find((t: any) => t.port === TEST_PORT);
    expect(entry).toBeDefined();
    expect(entry.url).toBe(tunnelUrl);
  });

  it("stops the tunnel", async () => {
    const app = createApp();
    const res = await app.request(`/api/preview/tunnel/${TEST_PORT}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(activeTunnels.has(TEST_PORT)).toBe(false);
  });

  it("tunnel URL stops working after deletion", async () => {
    expect(tunnelUrl).not.toBeNull();
    // Give cloudflared time to shut down
    await Bun.sleep(3_000);

    const proc = Bun.spawn(["curl", "-s", "--max-time", "5", tunnelUrl!], {
      stdout: "pipe", stderr: "pipe",
    });
    const body = await new Response(proc.stdout).text();
    await proc.exited;

    expect(body).not.toContain(TEST_RESPONSE);
  });
});
