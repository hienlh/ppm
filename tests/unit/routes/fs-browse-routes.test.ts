import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { fsBrowseRoutes } from "../../../src/server/routes/fs-browse.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

function createApp() {
  return new Hono().route("/fs", fsBrowseRoutes);
}

let dir: string;

beforeEach(() => {
  setDb(openTestDb());
  dir = mkdtempSync(join(tmpdir(), "fs-browse-routes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const q = (p: string) => encodeURIComponent(p);

describe("GET /fs/browse — path handling", () => {
  it("returns ok with default path when none provided", async () => {
    const res = await createApp().request("/fs/browse");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.sep).toBeDefined();
  });

  it("lists a temp directory with entry kinds", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const res = await createApp().request(`/fs/browse?path=${q(dir)}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.entries[0].kind).toBe("file");
  });

  it("accepts showHidden", async () => {
    writeFileSync(join(dir, ".dotfile"), "x");
    const hidden = await (await createApp().request(`/fs/browse?path=${q(dir)}&showHidden=true`)).json();
    expect(hidden.data.entries.some((e: { name: string }) => e.name === ".dotfile")).toBe(true);
  });

  it("returns 404 for a missing directory", async () => {
    const res = await createApp().request(`/fs/browse?path=${q(join(dir, "nope"))}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /fs/list — query validation", () => {
  it("rejects missing dir query param", async () => {
    const res = await createApp().request("/fs/list");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("dir");
  });

  it("returns ok with a valid dir", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const res = await createApp().request(`/fs/list?dir=${q(dir)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(1);
  });
});

describe("GET /fs/read", () => {
  it("rejects missing path query param", async () => {
    const res = await createApp().request("/fs/read");
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent file", async () => {
    const res = await createApp().request(`/fs/read?path=${q(join(dir, "ghost.txt"))}`);
    expect(res.status).toBe(404);
  });

  it("reads an existing file", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const res = await createApp().request(`/fs/read?path=${q(join(dir, "a.txt"))}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.content).toBe("hello");
  });

  it("refuses the PPM config database", async () => {
    const res = await createApp().request(`/fs/read?path=${q(resolve(getPpmDir(), "ppm.db"))}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /fs/raw and download tokens", () => {
  it("rejects missing path query param", async () => {
    expect((await createApp().request("/fs/raw")).status).toBe(400);
  });

  it("returns 404 for a nonexistent file", async () => {
    const res = await createApp().request(`/fs/raw?path=${q(join(dir, "ghost.bin"))}`);
    expect(res.status).toBe(404);
  });

  it("serves a file with an RFC 5987 filename on download", async () => {
    const file = join(dir, "héllo wörld.txt");
    writeFileSync(file, "test content");
    const res = await createApp().request(`/fs/raw?path=${q(file)}&download=true`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("filename*=UTF-8''");
    expect(await res.text()).toBe("test content");
  });

  it("percent-encodes characters that are not RFC 5987 attr-chars", async () => {
    // `*` is illegal in a Windows filename, so it is only part of the fixture
    // where the filesystem accepts it.
    const name = process.platform === "win32" ? "re'port (v2).txt" : "re'port (v2)*.txt";
    const file = join(dir, name);
    writeFileSync(file, "x");
    const res = await createApp().request(`/fs/raw?path=${q(file)}&download=true`);
    const disposition = res.headers.get("Content-Disposition")!;
    const encodedName = disposition.split("UTF-8''")[1]!;
    expect(encodedName).not.toMatch(/['()*]/);
    expect(encodedName).toContain("%27");
  });

  it("does not let the browser cache a download", async () => {
    const file = join(dir, "doc.txt");
    writeFileSync(file, "v1");
    const app = createApp();
    const download = await app.request(`/fs/raw?path=${q(file)}&download=true`);
    expect(download.headers.get("Cache-Control")).toBe("no-store");
    const inline = await app.request(`/fs/raw?path=${q(file)}`);
    expect(inline.headers.get("Cache-Control")).toContain("max-age");
  });

  it("refuses the PPM directory", async () => {
    const res = await createApp().request(`/fs/raw?path=${q(resolve(getPpmDir(), "ppm.db"))}`);
    expect(res.status).toBe(403);
  });

  it("spends a download token once and rejects the replay", async () => {
    const app = createApp();
    const file = join(dir, "doc.txt");
    writeFileSync(file, "content");
    const tokenRes = await app.request("/fs/download/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: file }),
    });
    const { token } = (await tokenRes.json()).data;

    const first = await app.request(`/fs/raw?path=${q(file)}&download=true&dl_token=${token}`);
    expect(first.status).toBe(200);
    const replay = await app.request(`/fs/raw?path=${q(file)}&download=true&dl_token=${token}`);
    expect(replay.status).toBe(403);
  });

  it("rejects a token used for a different file", async () => {
    const app = createApp();
    const file = join(dir, "doc.txt");
    const other = join(dir, "other.txt");
    writeFileSync(file, "a");
    writeFileSync(other, "b");
    const tokenRes = await app.request("/fs/download/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: file }),
    });
    const { token } = (await tokenRes.json()).data;
    const res = await app.request(`/fs/raw?path=${q(other)}&download=true&dl_token=${token}`);
    expect(res.status).toBe(403);
  });

  it("refuses to mint a token for the PPM directory", async () => {
    const res = await createApp().request("/fs/download/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: resolve(getPpmDir(), "ppm.db") }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /fs/docx-html", () => {
  it("requires a path", async () => {
    expect((await createApp().request("/fs/docx-html")).status).toBe(400);
  });

  it.if(process.platform === "win32")("refuses a UNC path, which is unsupported", async () => {
    const res = await createApp().request(`/fs/docx-html?path=${q("\\\\server\\share\\f.docx")}`);
    expect(res.status).toBe(403);
  });

  it("refuses the PPM directory", async () => {
    const res = await createApp().request(`/fs/docx-html?path=${q(resolve(getPpmDir(), "x.docx"))}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /fs/mkdir", () => {
  it("git-inits by default so the project picker keeps working", async () => {
    const target = join(dir, "project");
    const res = await createApp().request("/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.gitInitialized).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  it("skips git init when the caller opts out", async () => {
    const target = join(dir, "plain");
    const res = await createApp().request("/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target, gitInit: false }),
    });
    expect(res.status).toBe(201);
    expect(existsSync(join(target, ".git"))).toBe(false);
  });

  it("answers 409 when the directory already exists", async () => {
    const res = await createApp().request("/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir, gitInit: false }),
    });
    expect(res.status).toBe(409);
  });
});

describe("PUT /fs/write — body validation", () => {
  it("rejects missing path field", async () => {
    const res = await createApp().request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing content field", async () => {
    const res = await createApp().request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(dir, "a.txt") }),
    });
    expect(res.status).toBe(400);
  });

  it("writes a file", async () => {
    const target = join(dir, "written.txt");
    const res = await createApp().request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target, content: "hello world" }),
    });
    expect(res.status).toBe(200);
    expect(await Bun.file(target).text()).toBe("hello world");
  });

  it("refuses to write into the PPM directory", async () => {
    const res = await createApp().request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: resolve(getPpmDir(), "evil.txt"), content: "x" }),
    });
    expect(res.status).toBe(403);
  });
});
