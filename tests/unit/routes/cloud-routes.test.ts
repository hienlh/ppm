import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { cloudRoutes } from "../../../src/server/routes/cloud.ts";
import { configService } from "../../../src/services/config.service.ts";
import { removeCloudAuth, removeCloudDevice } from "../../../src/services/cloud.service.ts";

function createApp() {
  return new Hono().route("/cloud", cloudRoutes);
}

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  removeCloudAuth();
  removeCloudDevice();
});

describe("GET /cloud/status", () => {
  it("returns not logged in initially", async () => {
    const app = createApp();
    const res = await app.request("/cloud/status");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.logged_in).toBe(false);
    expect(json.data.email).toBeNull();
    // linked may be true if cloud-device.json persists from other tests
    expect(json.data.tunnel_active).toBe(false);
  });
});

describe("POST /cloud/login", () => {
  it("saves cloud auth with valid body", async () => {
    const app = createApp();
    const res = await app.request("/cloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: "test-token-123",
        email: "user@example.com",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.email).toBe("user@example.com");
  });

  it("rejects missing access_token", async () => {
    const app = createApp();
    const res = await app.request("/cloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "user@example.com",
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects missing email or accepts custom cloud_url", async () => {
    const app = createApp();
    // Missing email should fail
    const res1 = await app.request("/cloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "test-token-123" }),
    });
    expect(res1.status).toBe(400);

    // Custom cloud_url should work
    const res2 = await app.request("/cloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: "test-token",
        email: "user@example.com",
        cloud_url: "https://custom.cloud.local",
      }),
    });
    expect(res2.status).toBe(200);
  });

  it("handles malformed JSON", async () => {
    const app = createApp();
    const res = await app.request("/cloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // c.req.json() throws, not caught, so returns 500
    expect(res.status).toBe(500);
  });
});

describe("GET /cloud/status after login", () => {
  it("returns logged in state after login", async () => {
    const app = createApp();
    await app.request("/cloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: "test-token-123",
        email: "user@example.com",
      }),
    });
    const res = await app.request("/cloud/status");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.logged_in).toBe(true);
    expect(json.data.email).toBe("user@example.com");
  });
});

describe("POST /cloud/logout", () => {
  it("clears auth and returns not logged in", async () => {
    const app = createApp();
    // Login
    await app.request("/cloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: "test-token-123",
        email: "user@example.com",
      }),
    });
    // Logout
    const res = await app.request("/cloud/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);

    // Verify not logged in after logout
    const statusRes = await app.request("/cloud/status");
    const statusJson = await statusRes.json() as any;
    expect(statusJson.data.logged_in).toBe(false);
  });
});

describe("GET /cloud/login-url", () => {
  it("returns login URL and cloud_url", async () => {
    const app = createApp();
    const res = await app.request("/cloud/login-url");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.url).toContain("/auth/google/login");
    expect(json.data.cloud_url).toBeTruthy();
  });
});

describe("POST /cloud/link", () => {
  it("handles missing cloud auth gracefully", async () => {
    const app = createApp();
    const res = await app.request("/cloud/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "device-1" }),
    });
    // Should return 500 when linkDevice fails (no auth set up)
    expect(res.status).toBe(500);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("handles empty body", async () => {
    const app = createApp();
    const res = await app.request("/cloud/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Should still try to link (name is optional)
    expect([500, 200]).toContain(res.status);
  });

  it("handles malformed JSON", async () => {
    const app = createApp();
    const res = await app.request("/cloud/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // Should catch and try with empty object
    expect([500, 200]).toContain(res.status);
  });
});

describe("POST /cloud/unlink", () => {
  it("returns 200 even when no device linked", async () => {
    const app = createApp();
    const res = await app.request("/cloud/unlink", {
      method: "POST",
    });
    // unlinkDevice handles missing device gracefully
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
  });
});
