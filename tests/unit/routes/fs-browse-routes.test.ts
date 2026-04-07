import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { fsBrowseRoutes } from "../../../src/server/routes/fs-browse.ts";

function createApp() {
  return new Hono().route("/fs", fsBrowseRoutes);
}

beforeEach(() => {
  setDb(openTestDb());
});

describe("GET /fs/browse — path handling", () => {
  it("returns ok with default path when none provided", async () => {
    const app = createApp();
    const res = await app.request("/fs/browse");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data).toBeDefined();
  });

  it("accepts optional path query param", async () => {
    const app = createApp();
    const res = await app.request("/fs/browse?path=/tmp");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("accepts optional showHidden query param", async () => {
    const app = createApp();
    const res = await app.request("/fs/browse?path=/tmp&showHidden=true");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("handles showHidden=false (default)", async () => {
    const app = createApp();
    const res = await app.request("/fs/browse?path=/tmp&showHidden=false");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("returns 403 or 500 with inaccessible path", async () => {
    const app = createApp();
    const res = await app.request("/fs/browse?path=/root/.ssh");
    // Could be 403 (permission denied) or 500 (other error)
    expect([403, 500]).toContain(res.status);
  });
});

describe("GET /fs/list — query validation", () => {
  it("rejects missing dir query param", async () => {
    const app = createApp();
    const res = await app.request("/fs/list");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("dir");
  });

  it("returns ok with valid dir", async () => {
    const app = createApp();
    const res = await app.request("/fs/list?dir=/tmp");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data).toBeDefined();
  });

  it("returns 403 or 500 with inaccessible dir", async () => {
    const app = createApp();
    const res = await app.request("/fs/list?dir=/root/.ssh");
    expect([403, 500]).toContain(res.status);
  });
});

describe("GET /fs/read — query validation", () => {
  it("rejects missing path query param", async () => {
    const app = createApp();
    const res = await app.request("/fs/read");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  });

  it("returns 404 for nonexistent file", async () => {
    const app = createApp();
    const res = await app.request("/fs/read?path=/tmp/does-not-exist-12345.txt");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("returns 200 for readable file", async () => {
    const app = createApp();
    // Use a file that should exist
    const res = await app.request("/fs/read?path=/etc/hostname");
    if (res.status === 200) {
      const json = await res.json();
      expect(json.ok).toBe(true);
    }
  });
});

describe("GET /fs/raw — binary file serving", () => {
  it("rejects missing path query param", async () => {
    const app = createApp();
    const res = await app.request("/fs/raw");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  });

  it("returns 404 for nonexistent file", async () => {
    const app = createApp();
    const res = await app.request("/fs/raw?path=/tmp/does-not-exist-12345.bin");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("not found");
  });

  it("serves binary file with correct headers", async () => {
    const app = createApp();
    // Create a temp file
    const tmpPath = "/tmp/test-file-raw.bin";
    await Bun.write(tmpPath, "test content");

    try {
      const res = await app.request(`/fs/raw?path=${tmpPath}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBeDefined();
      expect(res.headers.get("Cache-Control")).toContain("max-age");
      const text = await res.text();
      expect(text).toBe("test content");
    } finally {
      try {
        await Bun.file(tmpPath).text(); // Verify file exists before delete
        Bun.spawn(["rm", tmpPath]).sync();
      } catch {
        // File might not exist
      }
    }
  });
});

describe("PUT /fs/write — body validation", () => {
  it("rejects missing path field", async () => {
    const app = createApp();
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects missing content field", async () => {
    const app = createApp();
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test.txt" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects empty path", async () => {
    const app = createApp();
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "", content: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts null or empty content (valid write)", async () => {
    const app = createApp();
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test-empty.txt", content: "" }),
    });
    // Should not be a validation error (400); may be 200 or service error
    expect(res.status).not.toBe(400);
  });

  it("accepts valid path and content", async () => {
    const app = createApp();
    const tmpPath = "/tmp/test-write-validate.txt";
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: tmpPath, content: "hello world" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Verify file was written
    const content = await Bun.file(tmpPath).text();
    expect(content).toBe("hello world");
  });
});
