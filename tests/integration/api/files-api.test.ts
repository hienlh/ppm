import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { buildTestApp, createTempDir, cleanupDir } from "../../setup.ts";
import type { Hono } from "hono";

let tmpDir: string;
let app: Hono;

beforeEach(() => {
  tmpDir = createTempDir({
    "index.ts": "export const x = 1;",
    "sub/util.ts": "export const y = 2;",
  });
  app = buildTestApp({ projects: [{ path: tmpDir, name: "test-proj" }] });
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe("GET /api/files/tree/:project", () => {
  test("returns file tree for registered project", async () => {
    const res = await app.request(`/api/files/tree/test-proj`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { name: string }[] };
    expect(body.ok).toBe(true);
    const names = body.data.map((e) => e.name);
    expect(names).toContain("index.ts");
  });

  test("returns 400 for unregistered path", async () => {
    const res = await app.request(`/api/files/tree/${encodeURIComponent("/tmp/not-registered")}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/files/read", () => {
  test("returns file content", async () => {
    const path = encodeURIComponent(join(tmpDir, "index.ts"));
    const res = await app.request(`/api/files/read?path=${path}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { content: string; encoding: string } };
    expect(body.ok).toBe(true);
    expect(body.data.content).toContain("export const x");
  });

  test("returns 400 when path query param missing", async () => {
    const res = await app.request("/api/files/read");
    expect(res.status).toBe(400);
  });

  test("returns 400 for path outside project", async () => {
    const res = await app.request(`/api/files/read?path=${encodeURIComponent("/etc/hosts")}`);
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/files/write", () => {
  test("writes content to existing file", async () => {
    const filePath = join(tmpDir, "index.ts");
    const res = await app.request("/api/files/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "const updated = true;" }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(filePath, "utf8")).toBe("const updated = true;");
  });

  test("creates new file via write", async () => {
    const filePath = join(tmpDir, "brand-new.ts");
    const res = await app.request("/api/files/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "const z = 3;" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(filePath)).toBe(true);
  });

  test("returns 400 when path missing", async () => {
    const res = await app.request("/api/files/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "oops" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/files/create", () => {
  test("creates a file", async () => {
    const filePath = join(tmpDir, "created.txt");
    const res = await app.request("/api/files/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, type: "file" }),
    });
    expect(res.status).toBe(201);
    expect(existsSync(filePath)).toBe(true);
  });

  test("creates a directory", async () => {
    const dirPath = join(tmpDir, "new-dir");
    const res = await app.request("/api/files/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath, type: "directory" }),
    });
    expect(res.status).toBe(201);
    expect(existsSync(dirPath)).toBe(true);
  });

  test("returns 400 when path missing", async () => {
    const res = await app.request("/api/files/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "file" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/files/delete", () => {
  test("deletes a file", async () => {
    const filePath = join(tmpDir, "index.ts");
    const res = await app.request(`/api/files/delete?path=${encodeURIComponent(filePath)}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(existsSync(filePath)).toBe(false);
  });

  test("returns 400 when path param missing", async () => {
    const res = await app.request("/api/files/delete", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  test("returns 400 for nonexistent file", async () => {
    const filePath = join(tmpDir, "ghost.txt");
    const res = await app.request(`/api/files/delete?path=${encodeURIComponent(filePath)}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/files/rename", () => {
  test("renames a file", async () => {
    const oldPath = join(tmpDir, "index.ts");
    const newPath = join(tmpDir, "main.ts");
    const res = await app.request("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath, newPath }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });

  test("returns 400 when oldPath or newPath missing", async () => {
    const res = await app.request("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: join(tmpDir, "index.ts") }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for path traversal destination", async () => {
    const oldPath = join(tmpDir, "index.ts");
    const res = await app.request("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath, newPath: "/tmp/escaped.ts" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Security: path traversal", () => {
  test("read rejects ../ traversal", async () => {
    const traversal = encodeURIComponent(join(tmpDir, "../../etc/passwd"));
    const res = await app.request(`/api/files/read?path=${traversal}`);
    expect(res.status).toBe(400);
  });

  test("write rejects ../ traversal", async () => {
    const res = await app.request("/api/files/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(tmpDir, "../escape.txt"), content: "x" }),
    });
    expect(res.status).toBe(400);
  });
});
