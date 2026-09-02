import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fsOpsRoutes } from "../../../src/server/routes/fs-ops.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

const app = new Hono().route("/fs", fsOpsRoutes);
let dir: string;

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(path: string, body: unknown) {
  return app.request(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-ops-routes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /fs/stat", () => {
  it("requires a path", async () => {
    expect((await app.request("/fs/stat")).status).toBe(400);
  });

  it("describes an existing file", async () => {
    writeFileSync(join(dir, "a.txt"), "abc");
    const res = await app.request(`/fs/stat?path=${encodeURIComponent(join(dir, "a.txt"))}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.kind).toBe("file");
    expect(json.data.size).toBe(3);
  });

  it("answers 404 for a missing file", async () => {
    const res = await app.request(`/fs/stat?path=${encodeURIComponent(join(dir, "ghost"))}`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("ENOENT");
  });
});

describe("POST /fs/copy and /fs/move", () => {
  it("copies a file", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const res = await post("/fs/copy", { source: join(dir, "a.txt"), destination: join(dir, "b.txt") });
    expect(res.status).toBe(200);
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("a");
  });

  it("answers 409 EEXIST on a collision so the client can prompt", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    const res = await post("/fs/copy", { source: join(dir, "a.txt"), destination: join(dir, "b.txt") });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("EEXIST");
  });

  it("answers 400 when a directory would be copied into itself", async () => {
    mkdirSync(join(dir, "src"));
    const res = await post("/fs/copy", {
      source: join(dir, "src"),
      destination: join(dir, "src", "inner"),
    });
    expect(res.status).toBe(400);
  });

  it("moves a file", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const res = await post("/fs/move", { source: join(dir, "a.txt"), destination: join(dir, "b.txt") });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("validates the body", async () => {
    expect((await post("/fs/move", { source: join(dir, "a.txt") })).status).toBe(400);
  });
});

describe("POST /fs/rename, /fs/touch, /fs/mkdir-equivalents", () => {
  it("renames in place", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const res = await post("/fs/rename", { path: join(dir, "a.txt"), newName: "b.txt" });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, "b.txt"))).toBe(true);
  });

  it("refuses a protected root", async () => {
    const res = await post("/fs/rename", { path: homedir(), newName: "x" });
    expect(res.status).toBe(403);
  });

  it("creates an empty file", async () => {
    const res = await post("/fs/touch", { path: join(dir, "new.txt") });
    expect(res.status).toBe(201);
    expect(existsSync(join(dir, "new.txt"))).toBe(true);
  });
});

describe("DELETE /fs/delete", () => {
  it("removes permanently when asked", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const res = await del("/fs/delete", { path: join(dir, "a.txt"), permanent: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.trashed).toBe(false);
    expect(json.data.permanent).toBe(true);
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("requires a path", async () => {
    expect((await del("/fs/delete", {})).status).toBe(400);
  });

  it("refuses the PPM directory", async () => {
    const res = await del("/fs/delete", { path: getPpmDir(), permanent: true });
    expect(res.status).toBe(403);
  });

  it("refuses a drive or filesystem root", async () => {
    const root = process.platform === "win32" ? resolve(dir).slice(0, 3) : "/";
    const res = await del("/fs/delete", { path: root, permanent: true });
    expect(res.status).toBe(403);
  });

  it("accepts /fs/rmdir as an alias", async () => {
    mkdirSync(join(dir, "tree"));
    const res = await del("/fs/rmdir", { path: join(dir, "tree"), permanent: true });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, "tree"))).toBe(false);
  });
});
