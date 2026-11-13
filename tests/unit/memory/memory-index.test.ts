/**
 * The memory search index (`index.db`): schema, `fold`, reconcile against the Markdown files,
 * text search, vectors and the rebuild of a corrupt file. Everything lives under a temp
 * PPM_HOME; every Database a test opens is closed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { serializeMemoryFile } from "../../../src/services/memory/memory-file.ts";
import { globalMemoryDir, memoryIndexPath, memoryRoot, projectMemoryDir, projectMemoryKey } from "../../../src/services/memory/memory-paths.ts";
import type { MemoryType } from "../../../src/services/memory/memory-types.ts";

const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-memory-index-"));
process.env.PPM_HOME = home;
_resetPpmDir();

// Loaded dynamically so a missing module fails the assertions below, not the file's load.
const MODULE = "../../../src/services/memory/memory-index.ts";
let mod: any = null;
const opened: { close(): void }[] = [];

beforeAll(async () => {
  mod = await import(MODULE).catch(() => null);
});

afterAll(() => {
  for (const idx of opened) {
    try { idx.close(); } catch { /* already closed */ }
  }
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

function api() {
  expect(mod).not.toBeNull();
  return mod;
}

let seq = 0;
/** A fresh index file and memory folder for one test. */
function fresh() {
  const m = api();
  const base = join(home, `case-${++seq}`);
  const dir = join(base, "projects", "abcdef0123456789");
  mkdirSync(dir, { recursive: true });
  const index = m.MemoryIndex.open(join(base, "index.db"));
  opened.push(index);
  return { m, base, dir, index, key: "abcdef0123456789" };
}

interface Fields { name?: string; description?: string; body?: string; type?: MemoryType; archived?: boolean; updated?: string }
function writeMemory(dir: string, id: string, f: Fields = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(path, serializeMemoryFile({
    name: f.name ?? id,
    description: f.description ?? `about ${id}`,
    type: f.type ?? "project",
    source: "ppm",
    created: "2026-11-12T00:00:00Z",
    updated: f.updated ?? "2026-11-12T00:00:00Z",
    archived: f.archived,
    body: f.body ?? `body of ${id}`,
  }));
  return path;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("fold", () => {
  test("maps đ/Đ to d/D and leaves everything else", () => {
    const { fold } = api();
    expect(fold("Đồng bộ đội")).toBe("Dồng bộ dội");
    expect(fold("plain text")).toBe("plain text");
  });
});

describe("opening", () => {
  test("creates the file in WAL mode with the three tables", () => {
    const { base, index } = fresh();
    const path = join(base, "index.db");
    expect(existsSync(path)).toBe(true);
    const probe = new Database(path, { readonly: true });
    try {
      expect((probe.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      const names = (probe.query("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name);
      expect(names).toContain("memories");
      expect(names).toContain("memories_fts");
      expect(names).toContain("vectors");
    } finally {
      probe.close();
    }
    expect(index.brokenPath).toBeUndefined();
  });
});

describe("reconcile", () => {
  test("indexes new Markdown files only, a file without frontmatter by its file name", async () => {
    const { dir, index, key } = fresh();
    writeMemory(dir, "m-aaaa0001", { name: "First" });
    writeMemory(dir, "m-aaaa0002", { name: "Second" });
    writeFileSync(join(dir, "loose-note.md"), "just a line of text\nmore\n");
    writeFileSync(join(dir, "project.json"), "{}\n");
    writeFileSync(join(dir, ".m-aaaa0003.md.tmp"), "half written");

    const r = await index.reconcile(dir, "project", key);
    expect(r.read).toBe(3);
    const rows = index.list([key]);
    expect(ids(rows)).toEqual(["loose-note", "m-aaaa0001", "m-aaaa0002"]);
    const loose = rows.find((x: any) => x.id === "loose-note");
    expect(loose.name).toBe("loose-note");
    expect(loose.description).toBe("just a line of text");
    expect(loose.scope).toBe("project");
    expect(loose.projectKey).toBe(key);
    expect(rows.find((x: any) => x.id === "m-aaaa0001").name).toBe("First");
  });

  test("re-reads only files whose mtime or size moved, and reflects a hand edit", async () => {
    const { dir, index, key } = fresh();
    const a = writeMemory(dir, "m-bbbb0001", { body: "the original walrus text" });
    const b = writeMemory(dir, "m-bbbb0002");
    writeMemory(dir, "m-bbbb0003");
    expect((await index.reconcile(dir, "project", key)).read).toBe(3);
    expect((await index.reconcile(dir, "project", key)).read).toBe(0);

    // A hand edit that changes the size.
    writeFileSync(a, readFileSync(a, "utf8").replace("the original walrus text", "an edited narwhal paragraph, longer"));
    expect((await index.reconcile(dir, "project", key)).read).toBe(1);
    expect(index.textSearch("narwhal", [key], 10).map((h: any) => h.id)).toEqual(["m-bbbb0001"]);
    expect(index.textSearch("walrus", [key], 10)).toEqual([]);

    // Same size, only the mtime moved.
    const st = statSync(b);
    utimesSync(b, st.atime, new Date(st.mtimeMs + 5_000));
    expect((await index.reconcile(dir, "project", key)).read).toBe(1);
  });

  test("drops the rows and vectors of deleted files", async () => {
    const { dir, index, key } = fresh();
    const gone = writeMemory(dir, "m-cccc0001", { name: "Platypus facts" });
    writeMemory(dir, "m-cccc0002");
    await index.reconcile(dir, "project", key);
    index.putVector({ id: "m-cccc0001", scope: "project", projectKey: key, model: "test:m", revision: "r1", vector: new Float32Array([1, 0]) });
    expect(index.textSearch("platypus", [key], 10).length).toBe(1);

    unlinkSync(gone);
    const r = await index.reconcile(dir, "project", key);
    expect(r.removed).toBe(1);
    expect(ids(index.list([key]))).toEqual(["m-cccc0002"]);
    expect(index.textSearch("platypus", [key], 10)).toEqual([]);
    expect(index.getVectors([key], "test:m")).toEqual([]);
  });

  test("a missing folder is an empty one", async () => {
    const { base, index } = fresh();
    const r = await index.reconcile(join(base, "nowhere"), "project", "0000000000000000");
    expect(r.read).toBe(0);
    expect(index.list(["0000000000000000"])).toEqual([]);
  });

  test("keeps archived memories listed only on request", async () => {
    const { dir, index, key } = fresh();
    writeMemory(dir, "m-dddd0001");
    writeMemory(dir, "m-dddd0002", { archived: true });
    await index.reconcile(dir, "project", key);
    expect(ids(index.list([key]))).toEqual(["m-dddd0001"]);
    expect(ids(index.list([key], { includeArchived: true }))).toEqual(["m-dddd0001", "m-dddd0002"]);
  });

  test("yields to the event loop while reconciling 500 files", async () => {
    const { dir, index, key } = fresh();
    for (let i = 0; i < 500; i++) writeMemory(dir, `m-${String(i).padStart(8, "0")}`, { body: `memory number ${i}` });

    let done = false;
    let ticks = 0;
    const tick = () => {
      if (done) return;
      ticks++;
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    const r = await index.reconcile(dir, "project", key);
    done = true;
    expect(r.read).toBe(500);
    expect(index.list([key]).length).toBe(500);
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe("textSearch", () => {
  test("ranks name over description over body, normalised to the top hit, archived excluded", async () => {
    const { dir, index, key } = fresh();
    writeMemory(dir, "in-body", { name: "Alpha note", description: "something general here", body: "a paragraph that mentions zebra once among other words" });
    writeMemory(dir, "in-desc", { name: "Beta note", description: "something about zebra here", body: "a paragraph that mentions nothing special among other words" });
    writeMemory(dir, "in-name", { name: "Zebra note", description: "something general here", body: "a paragraph that mentions nothing special among other words" });
    writeMemory(dir, "archived", { name: "Zebra archived", description: "zebra zebra", body: "zebra", archived: true });
    await index.reconcile(dir, "project", key);

    const hits = index.textSearch("zebra", [key], 10);
    expect(hits.map((h: any) => h.id)).toEqual(["in-name", "in-desc", "in-body"]);
    expect(hits[0].score).toBe(1);
    expect(hits[1].score).toBeLessThan(1);
    expect(hits[2].score).toBeLessThan(hits[1].score);
    expect(hits[2].score).toBeGreaterThan(0);
    expect(hits[0].name).toBe("Zebra note");
    expect(index.textSearch("zebra", [key], 2).length).toBe(2);
  });

  test("ORs the query's words and searches only the keys asked for", async () => {
    const { m, base, dir, index, key } = fresh();
    const g = join(base, "global");
    writeMemory(dir, "p-one", { body: "talks about gondolas" });
    writeMemory(dir, "p-two", { body: "talks about funiculars" });
    writeMemory(g, "g-one", { body: "global gondolas too" });
    const other = join(base, "projects", "ffffffffffffffff");
    writeMemory(other, "o-one", { body: "other project gondolas" });
    await index.reconcile(dir, "project", key);
    await index.reconcile(g, "global", m.GLOBAL_MEMORY_KEY);
    await index.reconcile(other, "project", "ffffffffffffffff");

    expect(ids(index.textSearch("gondolas funiculars", [key], 10))).toEqual(["p-one", "p-two"]);
    const both = index.textSearch("gondolas", [key, m.GLOBAL_MEMORY_KEY], 10);
    expect(ids(both)).toEqual(["g-one", "p-one"]);
    expect(both.find((h: any) => h.id === "g-one").scope).toBe("global");
    // Punctuation and FTS syntax in a query are words, not operators.
    expect(index.textSearch('gondolas" OR NOT (', [key], 10).map((h: any) => h.id)).toEqual(["p-one"]);
    expect(index.textSearch("   ", [key], 10)).toEqual([]);
  });

  test("matches Vietnamese with or without diacritics, đ included", async () => {
    const { dir, index, key } = fresh();
    writeMemory(dir, "vi-accent", { name: "Đồng bộ memory", body: "Cách đồng bộ dữ liệu giữa các máy" });
    writeMemory(dir, "vi-plain", { name: "Plain note", body: "dong bo du lieu khong dau" });
    writeMemory(dir, "unrelated", { name: "Unrelated", body: "nothing in common" });
    await index.reconcile(dir, "project", key);

    expect(ids(index.textSearch("dong bo", [key], 10))).toEqual(["vi-accent", "vi-plain"]);
    expect(ids(index.textSearch("đồng bộ", [key], 10))).toEqual(["vi-accent", "vi-plain"]);
    expect(ids(index.textSearch("ĐỒNG", [key], 10))).toEqual(["vi-accent", "vi-plain"]);
    expect(ids(index.textSearch("dữ liệu", [key], 10))).toEqual(["vi-accent", "vi-plain"]);
  });
});

describe("vectors", () => {
  test("put, get by model and delete by model", () => {
    const { index, key } = fresh();
    const put = (id: string, model: string, revision: string, v: number[]) =>
      index.putVector({ id, scope: "project", projectKey: key, model, revision, vector: new Float32Array(v) });
    put("a", "local:e5", "r1", [0.25, 0.5, 0.75]);
    put("b", "local:e5", "r1", [1, 0, 0]);
    put("a", "api:x#y", "r1", [9, 9]);
    put("a", "local:e5", "r2", [0.5, 0.5, 0.5]); // replaces a's local:e5 vector

    const local = index.getVectors([key], "local:e5").sort((x: any, y: any) => x.id.localeCompare(y.id));
    expect(local.map((v: any) => [v.id, v.revision, v.model, Array.from(v.vector)])).toEqual([
      ["a", "r2", "local:e5", [0.5, 0.5, 0.5]],
      ["b", "r1", "local:e5", [1, 0, 0]],
    ]);
    expect(local[0].vector).toBeInstanceOf(Float32Array);
    expect(index.getVectors(["0000000000000000"], "local:e5")).toEqual([]);

    expect(index.deleteVectorsByModel("local:e5")).toBe(2);
    expect(index.getVectors([key], "local:e5")).toEqual([]);
    expect(index.getVectors([key], "api:x#y").map((v: any) => Array.from(v.vector))).toEqual([[9, 9]]);
  });
});

describe("a corrupt or unopenable index", () => {
  test("is renamed index.db.broken-* and rebuilt from the Markdown with no memory lost", async () => {
    const m = api();
    const projectPath = join(home, "some-project");
    const pdir = projectMemoryDir(projectPath);
    const pkey = projectMemoryKey(projectPath);
    writeMemory(pdir, "m-eeee0001", { name: "Project otter" });
    writeMemory(pdir, "m-eeee0002", { name: "Project heron" });
    writeMemory(globalMemoryDir(), "m-ffff0001", { name: "Global otter" });
    const before = readFileSync(join(pdir, "m-eeee0001.md"), "utf8");

    const first = m.MemoryIndex.open(memoryIndexPath());
    opened.push(first);
    await first.reconcile(pdir, "project", pkey);
    await first.reconcile(globalMemoryDir(), "global", m.GLOBAL_MEMORY_KEY);
    first.close();

    const garbage = new Uint8Array(8192);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 131 + 7) % 251;
    writeFileSync(memoryIndexPath(), garbage);

    const idx = m.MemoryIndex.open(memoryIndexPath());
    opened.push(idx);
    expect(idx.brokenPath).toMatch(/index\.db\.broken-[^/\\]+$/);
    expect(existsSync(idx.brokenPath)).toBe(true);
    expect(readdirSync(dirname(memoryIndexPath())).some((n) => n.startsWith("index.db.broken-"))).toBe(true);

    await idx.reconcileAll();
    expect(ids(idx.list([pkey, m.GLOBAL_MEMORY_KEY]))).toEqual(["m-eeee0001", "m-eeee0002", "m-ffff0001"]);
    expect(ids(idx.textSearch("otter", [pkey, m.GLOBAL_MEMORY_KEY], 10))).toEqual(["m-eeee0001", "m-ffff0001"]);
    expect(readFileSync(join(pdir, "m-eeee0001.md"), "utf8")).toBe(before);
    expect(memoryIndexPath().startsWith(memoryRoot())).toBe(true);
    idx.close();
  });

  test("an index path that cannot be opened at all is moved aside too", async () => {
    const { m, base } = fresh();
    const path = join(base, "blocked", "index.db");
    mkdirSync(join(path, "inside"), { recursive: true }); // a directory where the file should be
    const idx = m.MemoryIndex.open(path);
    opened.push(idx);
    expect(idx.brokenPath).toMatch(/index\.db\.broken-/);
    expect(statSync(path).isFile()).toBe(true);
    const dir = join(base, "blocked", "mem");
    writeMemory(dir, "m-gggg0001", { name: "Recovered" });
    await idx.reconcile(dir, "project", "1111111111111111");
    expect(idx.list(["1111111111111111"]).map((r: any) => r.name)).toEqual(["Recovered"]);
  });
});
