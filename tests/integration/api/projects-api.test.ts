import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync } from "fs";
import { buildTestApp, createTempDir, cleanupDir } from "../../setup.ts";
import type { Hono } from "hono";

let tmpDir: string;
let app: Hono;

beforeEach(() => {
  tmpDir = createTempDir();
  app = buildTestApp({ projects: [] });
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe("GET /api/projects", () => {
  test("returns empty list initially", async () => {
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  test("returns registered projects", async () => {
    const projDir = join(tmpDir, "proj1");
    mkdirSync(projDir);
    app = buildTestApp({ projects: [{ path: projDir, name: "proj1" }] });
    const res = await app.request("/api/projects");
    const body = await res.json() as { ok: boolean; data: { name: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.name).toBe("proj1");
  });
});

describe("POST /api/projects", () => {
  test("adds a project", async () => {
    const projDir = join(tmpDir, "new-proj");
    mkdirSync(projDir);
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projDir, name: "new-proj" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns 400 when path is missing", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-path" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("returns 400 when project already exists", async () => {
    const projDir = join(tmpDir, "dup");
    mkdirSync(projDir);
    app = buildTestApp({ projects: [{ path: projDir, name: "dup" }] });
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projDir, name: "dup" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/projects/:name", () => {
  test("removes a project by name", async () => {
    const projDir = join(tmpDir, "del-proj");
    mkdirSync(projDir);
    app = buildTestApp({ projects: [{ path: projDir, name: "del-proj" }] });
    const res = await app.request("/api/projects/del-proj", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns 404 for unknown project", async () => {
    const res = await app.request("/api/projects/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe("Auth middleware", () => {
  test("returns 401 without token when auth enabled", async () => {
    app = buildTestApp({
      projects: [],
      auth: { enabled: true, token: "secret123" },
    });
    const res = await app.request("/api/projects");
    expect(res.status).toBe(401);
  });

  test("allows request with valid Bearer token", async () => {
    app = buildTestApp({
      projects: [],
      auth: { enabled: true, token: "secret123" },
    });
    const res = await app.request("/api/projects", {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(res.status).toBe(200);
  });

  test("returns 401 with wrong token", async () => {
    app = buildTestApp({
      projects: [],
      auth: { enabled: true, token: "secret123" },
    });
    const res = await app.request("/api/projects", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });
});
