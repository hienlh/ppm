/**
 * The Codex importer against fake Codex homes in temp dirs. Every database is created here
 * with bun:sqlite in the schema read from openai/codex; nothing touches the real `~/.codex`.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_TYPES, type NativeMemory } from "../../../src/services/memory/memory-types.ts";

type ImportResult = { items: NativeMemory[]; skipped: string[]; error?: string };
type Importer = (projectPath: string, codexHomes?: string[]) => Promise<ImportResult>;

/** Loaded on demand so a missing module fails the assertion, not the file's load. */
async function importer(): Promise<Importer> {
  const mod = (await import("../../../src/services/memory/import-codex.ts").catch(() => ({}))) as { importCodexMemories?: Importer };
  expect(typeof mod.importCodexMemories).toBe("function");
  return mod.importCodexMemories!;
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix = "ppm-import-codex-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const STAGE1 = `CREATE TABLE stage1_outputs (
  thread_id TEXT PRIMARY KEY, source_updated_at INTEGER, raw_memory TEXT, rollout_summary TEXT,
  rollout_slug TEXT, generated_at INTEGER, usage_count INTEGER, last_usage INTEGER,
  selected_for_phase2 INTEGER, selected_for_phase2_source_updated_at INTEGER)`;

interface Row { raw?: string | null; summary?: string | null; slug?: string | null }

/** A fake Codex home: `state_<n>.sqlite` threads + a memories database holding stage1_outputs. */
function codexHome(home = tempDir(), opts: { state?: number; memories?: string } = {}) {
  mkdirSync(home, { recursive: true });
  const state = new Database(join(home, `state_${opts.state ?? 5}.sqlite`));
  state.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT, memory_mode TEXT, updated_at INTEGER)");
  const memoriesFile = opts.memories ?? "memories_1.sqlite";
  const memories = new Database(join(home, memoriesFile));
  memories.exec(STAGE1.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
  const thread = (id: string, cwd: string, mode = "enabled") =>
    state.query("INSERT OR REPLACE INTO threads VALUES (?,?,?,?)").run(id, cwd, mode, Date.now());
  const output = (id: string, row: Row, db = memories) =>
    db.query("INSERT OR REPLACE INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at, usage_count) VALUES (?,?,?,?,?,?,0)")
      .run(id, 1, row.raw ?? null, row.summary ?? null, row.slug ?? null, Date.now());
  const put = (id: string, cwd: string, row: Row, mode = "enabled") => { thread(id, cwd, mode); output(id, row); };
  const close = () => { memories.close(); state.close(); };
  return { home, memoriesPath: join(home, memoriesFile), statePath: join(home, `state_${opts.state ?? 5}.sqlite`), thread, output, put, close };
}

const raw = (description: string, body: string) =>
  `---\ndescription: ${description}\ntask: fix the build\ntask_group: build\ntask_outcome: success\ncwd: /x\nkeywords: [bun, build]\n---\n${body}\n`;

const T1 = "0199aa11-1111-7000-8000-000000000001";
const T2 = "0199bb22-2222-7000-8000-000000000002";
const T3 = "0199cc33-3333-7000-8000-000000000003";

test("imports one project memory per stage1_outputs row of a thread with this exact cwd", async () => {
  const importCodexMemories = await importer();
  const project = join(tempDir(), "project");
  mkdirSync(project);
  const h = codexHome();
  h.put(T1, project, { raw: raw("Build with bun", "Run `bun run build` before tests."), summary: "# Fixed the build script\nDetails…", slug: "fixed-build" });
  h.put(T2, `${project}-other`, { raw: raw("OTHER PROJECT", "PRIVATE OTHER"), summary: "# Other" });
  h.put(T3, join(project, "sub"), { raw: raw("SUBDIR", "PRIVATE SUBDIR"), summary: "# Sub" });
  h.close();

  const result = await importCodexMemories(project, [h.home]);
  expect(result.error).toBeUndefined();
  expect(result.items).toHaveLength(1);
  const item = result.items[0]!;
  expect(item.id).toBe("codex-0199aa11");
  expect(item.scope).toBe("project");
  expect(item.name).toBe("Fixed the build script");
  expect(item.description).toBe("Build with bun");
  expect(item.body).toContain("Run `bun run build` before tests.");
  expect(item.body).toBe(raw("Build with bun", "Run `bun run build` before tests.").trim());
  expect(item.origin).toBe(`codex:${T1}`);
  expect(item.originHash).toMatch(/^[0-9a-f]{16,}$/);
  expect((MEMORY_TYPES as readonly string[]).includes(item.type)).toBe(true);
  expect(JSON.stringify(result.items)).not.toContain("PRIVATE");
});

test("threads whose memory_mode is disabled are left out", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const h = codexHome();
  h.put(T1, project, { raw: raw("kept", "KEPT"), summary: "# Kept" });
  h.put(T2, project, { raw: raw("off", "PRIVATE DISABLED"), summary: "# Off" }, "disabled");
  h.close();
  const result = await importCodexMemories(project, [h.home]);
  expect(result.items.map((m) => m.id)).toEqual(["codex-0199aa11"]);
});

test("matches thread cwds with a trailing slash and a project reached through a symlink", async () => {
  const importCodexMemories = await importer();
  const root = tempDir();
  const project = join(root, "project");
  mkdirSync(project);
  const alias = join(root, "alias");
  symlinkSync(project, alias, "dir");
  const h = codexHome();
  h.put(T1, `${project}/`, { raw: raw("slash", "SLASH"), summary: "# Slash" });
  h.close();
  const result = await importCodexMemories(alias, [h.home]);
  expect(result.items.map((m) => m.id)).toEqual(["codex-0199aa11"]);
});

test("name falls back to rollout_slug, body to rollout_summary", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const h = codexHome();
  h.put(T1, project, { raw: raw("No heading here", "Body one"), summary: "no heading, just prose", slug: "slug-for-one" });
  h.put(T2, project, { raw: "", summary: "# Only a summary\nThe summary body." , slug: "two" });
  h.put(T3, project, { raw: null, summary: "# Summary three\nThree.", slug: null });
  h.close();
  const byId = new Map((await importCodexMemories(project, [h.home])).items.map((m) => [m.id, m]));
  expect(byId.get("codex-0199aa11")?.name).toBe("slug-for-one");
  expect(byId.get("codex-0199aa11")?.description).toBe("No heading here");
  expect(byId.get("codex-0199bb22")?.name).toBe("Only a summary");
  expect(byId.get("codex-0199bb22")?.body).toBe("# Only a summary\nThe summary body.");
  expect(byId.get("codex-0199cc33")?.body).toBe("# Summary three\nThree.");
  for (const m of byId.values()) expect(typeof m.description).toBe("string");
});

test("a row with neither raw_memory nor rollout_summary is skipped with a reason", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const h = codexHome();
  h.put(T1, project, { raw: "", summary: "", slug: "empty" });
  h.close();
  const result = await importCodexMemories(project, [h.home]);
  expect(result.items).toEqual([]);
  expect(result.skipped.length).toBe(1);
  expect(result.skipped[0]).toContain(T1);
});

test("originHash is stable for the same row and moves when the row changes", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const h = codexHome();
  h.put(T1, project, { raw: raw("d", "v1 body"), summary: "# S" });
  const first = (await importCodexMemories(project, [h.home])).items[0]!.originHash;
  const again = (await importCodexMemories(project, [h.home])).items[0]!.originHash;
  h.output(T1, { raw: raw("d", "v2 body"), summary: "# S" });
  const changed = (await importCodexMemories(project, [h.home])).items[0]!.originHash;
  h.close();
  expect(again).toBe(first);
  expect(changed).not.toBe(first);
});

test("uses the newest state_N database, comparing N as a number", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const home = tempDir();
  const old = codexHome(home, { state: 9 });
  old.put(T1, project, { raw: raw("old", "OLD"), summary: "# Old" });
  old.close();
  const fresh = codexHome(home, { state: 10 });
  fresh.thread(T2, project);
  fresh.output(T2, { raw: raw("new", "NEW"), summary: "# New" });
  fresh.close();
  const result = await importCodexMemories(project, [home]);
  expect(result.items.map((m) => m.id)).toEqual(["codex-0199bb22"]);
});

test("several homes are merged and a home named twice is read once", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const a = codexHome();
  a.put(T1, project, { raw: raw("a", "A"), summary: "# A" });
  a.close();
  const b = codexHome();
  b.put(T2, project, { raw: raw("b", "B"), summary: "# B" });
  b.close();
  const result = await importCodexMemories(project, [a.home, b.home, a.home]);
  expect(result.error).toBeUndefined();
  expect(result.items.map((m) => m.id).sort()).toEqual(["codex-0199aa11", "codex-0199bb22"]);
});

test("reads both the v1 and the v2 memories databases, one memory per thread", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const home = tempDir();
  const v1 = codexHome(home);
  v1.put(T1, project, { raw: raw("from v1", "V1"), summary: "# V1" });
  v1.put(T3, project, { raw: raw("both v1", "BOTH"), summary: "# Both" });
  v1.close();
  const v2 = codexHome(home, { memories: "memories_v2_1.sqlite" });
  v2.put(T2, project, { raw: raw("from v2", "V2"), summary: "# V2" });
  v2.put(T3, project, { raw: raw("both v2", "BOTH"), summary: "# Both" });
  v2.close();
  const result = await importCodexMemories(project, [home]);
  expect(result.error).toBeUndefined();
  const ids = result.items.map((m) => m.id).sort();
  expect(ids).toEqual(["codex-0199aa11", "codex-0199bb22", "codex-0199cc33"]);
  const descriptions = result.items.map((m) => m.description);
  expect(descriptions).toContain("from v1");
  expect(descriptions).toContain("from v2");
});

test("memory_summary.md of v1 and v2 becomes one global codex-summary without the v1 line", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const home = tempDir();
  mkdirSync(join(home, "memories"));
  mkdirSync(join(home, "memories_v2"));
  writeFileSync(join(home, "memories", "memory_summary.md"), "v1\n# What I know\nUser prefers bun over npm.\n");
  writeFileSync(join(home, "memories_v2", "memory_summary.md"), "v1\nThe v2 summary line.\n");
  writeFileSync(join(home, "memories", "MEMORY.md"), "PRIVATE CONSOLIDATED INDEX\n");
  const result = await importCodexMemories(project, [home]);
  expect(result.error).toBeUndefined();
  const summaries = result.items.filter((m) => m.id === "codex-summary");
  expect(summaries).toHaveLength(1);
  const s = summaries[0]!;
  expect(s.scope).toBe("global");
  expect(s.body).toContain("User prefers bun over npm.");
  expect(s.body).toContain("The v2 summary line.");
  expect(s.body.split("\n").some((line) => line.trim() === "v1")).toBe(false);
  expect(s.name.length).toBeGreaterThan(0);
  expect(s.originHash).toMatch(/^[0-9a-f]{16,}$/);
  expect(JSON.stringify(result.items)).not.toContain("PRIVATE");
});

test("opens the databases read-only: bytes and mtime unchanged after an import", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const h = codexHome();
  h.put(T1, project, { raw: raw("ro", "RO"), summary: "# RO" });
  h.close();
  const before = [h.memoriesPath, h.statePath].map((p) => ({ bytes: readFileSync(p), mtime: statSync(p).mtimeMs }));
  await new Promise((r) => setTimeout(r, 20));
  const result = await importCodexMemories(project, [h.home]);
  expect(result.items).toHaveLength(1);
  const after = [h.memoriesPath, h.statePath].map((p) => ({ bytes: readFileSync(p), mtime: statSync(p).mtimeMs }));
  for (let i = 0; i < before.length; i++) {
    expect(after[i]!.mtime).toBe(before[i]!.mtime);
    expect(Buffer.compare(after[i]!.bytes, before[i]!.bytes)).toBe(0);
  }
});

test("a missing or empty Codex home is zero items, not an error", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const empty = tempDir();
  const result = await importCodexMemories(project, [join(empty, "does-not-exist"), empty]);
  expect(result).toEqual({ items: [], skipped: [] });
});

test("a memories database without stage1_outputs is an error with a reason, not a throw", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const home = tempDir();
  const state = new Database(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, memory_mode TEXT)");
  state.query("INSERT INTO threads VALUES (?,?,?)").run(T1, project, "enabled");
  state.close();
  const memories = new Database(join(home, "memories_1.sqlite"));
  memories.exec("CREATE TABLE unrelated (id TEXT)");
  memories.close();
  const result = await importCodexMemories(project, [home]);
  expect(result.items).toEqual([]);
  expect(result.error).toBeString();
  expect(result.error!).toContain("stage1_outputs");
});

test("a locked memories database is an error with a reason, and other homes still import", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const locked = codexHome();
  locked.put(T1, project, { raw: raw("locked", "LOCKED"), summary: "# Locked" });
  locked.close();
  const ok = codexHome();
  ok.put(T2, project, { raw: raw("ok", "OK"), summary: "# OK" });
  ok.close();
  const holder = new Database(locked.memoriesPath);
  try {
    holder.exec("PRAGMA journal_mode = DELETE");
    holder.exec("BEGIN EXCLUSIVE");
    const result = await importCodexMemories(project, [locked.home, ok.home]);
    expect(result.error).toBeString();
    expect(result.error!).toMatch(/lock|busy/i);
    expect(result.items.map((m) => m.id)).toEqual(["codex-0199bb22"]);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("a garbage file in place of a database is an error with a reason, not a throw", async () => {
  const importCodexMemories = await importer();
  const project = tempDir();
  const home = tempDir();
  const state = new Database(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, memory_mode TEXT)");
  state.query("INSERT INTO threads VALUES (?,?,?)").run(T1, project, "enabled");
  state.close();
  writeFileSync(join(home, "memories_1.sqlite"), "this is not a sqlite database at all\n".repeat(200));
  const result = await importCodexMemories(project, [home]);
  expect(result.items).toEqual([]);
  expect(result.error).toBeString();
  expect(result.error!).toMatch(/not a database|malformed|memories_1\.sqlite/i);

  const garbageState = tempDir();
  writeFileSync(join(garbageState, "state_5.sqlite"), "garbage ".repeat(500));
  const m = new Database(join(garbageState, "memories_1.sqlite"));
  m.exec(STAGE1);
  m.close();
  const second = await importCodexMemories(project, [garbageState]);
  expect(second.items).toEqual([]);
  expect(second.error).toBeString();
});
