import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fsUploadRoutes } from "../../../src/server/routes/fs-upload.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

const app = new Hono().route("/fs", fsUploadRoutes);
let dir: string;

function put(path: string, body: BodyInit | null) {
  return app.request(path, { method: "PUT", body });
}

function uploadUrl(target: string, overwrite?: boolean): string {
  const q = `path=${encodeURIComponent(target)}${overwrite ? "&overwrite=1" : ""}`;
  return `/fs/upload?${q}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-upload-routes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PUT /fs/upload", () => {
  it("requires a path", async () => {
    const res = await put("/fs/upload", "abc");
    expect(res.status).toBe(400);
  });

  it("streams the body to disk and answers with path + size", async () => {
    const target = join(dir, "a.txt");
    const res = await put(uploadUrl(target), "hello world");
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.path).toBe(target);
    expect(json.data.size).toBe(11);
    expect(readFileSync(target, "utf-8")).toBe("hello world");
    // No leftover tmp file once the write lands.
    expect(existsSync(`${target}.ppm-upload-tmp`)).toBe(false);
  });

  it("creates missing nested parent directories (a folder drop)", async () => {
    const target = join(dir, "sub", "nested", "b.txt");
    const res = await put(uploadUrl(target), "nested");
    expect(res.status).toBe(201);
    expect(readFileSync(target, "utf-8")).toBe("nested");
  });

  it("uploads into an existing read-only-flagged directory (Windows Desktop/Documents)", async () => {
    // Windows marks its known folders with the ReadOnly attribute; Bun's recursive mkdir
    // reports EEXIST for such an existing directory, which must never read as a collision.
    const readOnlyDir = join(dir, "Desktop");
    mkdirSync(readOnlyDir);
    if (process.platform === "win32") Bun.spawnSync(["attrib", "+R", readOnlyDir]);
    const target = join(readOnlyDir, "fresh.7z");
    const res = await put(uploadUrl(target), "payload");
    expect(res.status).toBe(201);
    expect(readFileSync(target, "utf-8")).toBe("payload");
  });

  it("answers 409 EEXIST when the target exists and overwrite is not set", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "original");
    const res = await put(uploadUrl(target), "replacement");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("EEXIST");
    expect(readFileSync(target, "utf-8")).toBe("original");
  });

  it("overwrite=1 replaces the existing file", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "original");
    const res = await put(uploadUrl(target, true), "replacement");
    expect(res.status).toBe(201);
    expect(readFileSync(target, "utf-8")).toBe("replacement");
  });

  it("refuses to upload onto an existing directory", async () => {
    const target = join(dir, "adir");
    mkdirSync(target);
    const res = await put(uploadUrl(target, true), "x");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("EISDIR");
  });

  it("refuses the PPM directory subtree", async () => {
    const target = join(getPpmDir(), "sneaky.txt");
    const res = await put(uploadUrl(target), "x");
    expect(res.status).toBe(403);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a protected root", async () => {
    const res = await put(uploadUrl(homedir()), "x");
    expect(res.status).toBe(403);
  });

  it("answers 400 when an ancestor directory is actually a file", async () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const target = join(blocker, "child.txt");
    const res = await put(uploadUrl(target), "x");
    expect(res.status).toBe(400);
    expect(existsSync(target)).toBe(false);
  });

  it("cleans up the tmp file when the client aborts mid-upload", async () => {
    // A real `Bun.serve` + a real aborted `fetch`, not a hand-built `ReadableStream` fed
    // straight into the service: constructing a stream that errors synchronously hangs
    // `Bun.write`'s Response-body path on this host/Bun version instead of rejecting, which
    // a raw network disconnect does not trigger — the server-side stream reader sees a real
    // socket error, not a manually-thrown one.
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const target = join(dir, "aborted.txt");
      const controller = new AbortController();
      const slowBody = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          ctrl.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      });
      const request = fetch(`http://127.0.0.1:${server.port}${uploadUrl(target)}`, {
        method: "PUT",
        body: slowBody,
        signal: controller.signal,
        // @ts-expect-error `duplex` is required for a streaming body but missing from this
        // lib's RequestInit typings.
        duplex: "half",
      });
      setTimeout(() => controller.abort(), 60);
      await expect(request).rejects.toThrow();
      // Give the server a moment to notice the dropped connection and run its cleanup.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}${".ppm-upload-tmp"}`)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
