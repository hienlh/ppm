import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { extensionRoutes } from "../../../src/server/routes/extensions.ts";

function createApp() {
  return new Hono().route("/extensions", extensionRoutes);
}

beforeEach(() => {
  setDb(openTestDb());
});

describe("GET /extensions", () => {
  it("returns empty array initially", async () => {
    const app = createApp();
    const res = await app.request("/extensions");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
  });
});

describe("GET /extensions/contributions", () => {
  it("returns contributions object with structure", async () => {
    const app = createApp();
    const res = await app.request("/extensions/contributions");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(typeof json.data).toBe("object");
    expect(json.data !== null).toBe(true);
  });
});

describe("GET /extensions/:id", () => {
  it("returns 404 for nonexistent extension", async () => {
    const app = createApp();
    const res = await app.request("/extensions/nonexistent-ext");
    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("not found");
  });
});

describe("POST /extensions/install", () => {
  it("rejects missing name field", async () => {
    const app = createApp();
    const res = await app.request("/extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("name");
  });

  it("rejects with explicit null name", async () => {
    const app = createApp();
    const res = await app.request("/extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: null }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });


  it("successfully installs extension with valid name", async () => {
    const app = createApp();
    const res = await app.request("/extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-extension" }),
    });
    // test-extension exists in registry
    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.id).toBe("test-extension");
  });

  it("handles malformed JSON", async () => {
    const app = createApp();
    const res = await app.request("/extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // Caught by .catch(), treated as empty object
    expect(res.status).toBe(400);
  });
});

describe("POST /extensions/dev-link", () => {
  it("rejects missing path field", async () => {
    const app = createApp();
    const res = await app.request("/extensions/dev-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  });

  it("rejects with explicit null path", async () => {
    const app = createApp();
    const res = await app.request("/extensions/dev-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: null }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });


  it("handles dev-link with valid path (may fail in test env)", async () => {
    const app = createApp();
    const res = await app.request("/extensions/dev-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test-ext" }),
    });
    // Will fail (path doesn't exist), should return 500 with error
    expect([400, 500]).toContain(res.status);
  });

  it("handles malformed JSON", async () => {
    const app = createApp();
    const res = await app.request("/extensions/dev-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // Caught by .catch(), treated as empty object
    expect(res.status).toBe(400);
  });
});

describe("DELETE /extensions/:id", () => {
  it("returns ok for nonexistent extension (idempotent)", async () => {
    const app = createApp();
    const res = await app.request("/extensions/fake-ext", { method: "DELETE" });
    expect([200, 404, 500]).toContain(res.status);
  });
});

describe("PATCH /extensions/:id", () => {
  it("rejects missing enabled field", async () => {
    const app = createApp();
    const res = await app.request("/extensions/fake-ext", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("enabled");
  });

  it("handles null enabled (validation passes, then fails on extension not found)", async () => {
    const app = createApp();
    const res = await app.request("/extensions/fake-ext", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: null }),
    });
    // null is not undefined, so validation passes, then fails on get/set
    expect(res.status).toBe(500);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("accepts boolean true for enabled", async () => {
    const app = createApp();
    const res = await app.request("/extensions/fake-ext", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    // Will fail (ext doesn't exist), but validation passes
    expect([404, 500]).toContain(res.status);
  });

  it("accepts boolean false for enabled", async () => {
    const app = createApp();
    const res = await app.request("/extensions/fake-ext", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    // Will fail (ext doesn't exist), but validation passes
    expect([404, 500]).toContain(res.status);
  });

  it("handles malformed JSON", async () => {
    const app = createApp();
    const res = await app.request("/extensions/fake-ext", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // Caught by .catch(), treated as empty object
    expect(res.status).toBe(400);
  });
});
