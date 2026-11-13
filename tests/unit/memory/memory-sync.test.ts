import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { globalMemoryDir, memoryRoot, projectMemoryDir, projectMemoryKey } from "../../../src/services/memory/memory-paths.ts";
import { memoryStore } from "../../../src/services/memory/memory-store.ts";
import { closeMemoryIndex, getMemoryIndex, GLOBAL_MEMORY_KEY } from "../../../src/services/memory/memory-index.ts";
import { importClaudeMemories } from "../../../src/services/memory/import-claude.ts";
import { importCodexMemories } from "../../../src/services/memory/import-codex.ts";
import { importAntigravity } from "../../../src/services/memory/import-antigravity.ts";
import { parseMemoryFile } from "../../../src/services/memory/memory-file.ts";
import { createMemorySync, type MemorySyncDeps } from "../../../src/services/memory/memory-sync.ts";

const originalPpmHome = process.env.PPM_HOME;
let root: string;
let claudeHome: string;
let codexHome: string;
let agyHome: string;
let projectPath: string;

const encode = (path: string) => realpathSync(path).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const claudeDirOf = (project: string) => join(claudeHome, "projects", encode(project), "memory");

function put(path: string, text: string, mtimeSec?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}

function claudeMemory(project: string, stem: string, body: string, opts: { name?: string; mtime?: number } = {}) {
  put(
    join(claudeDirOf(project), `${stem}.md`),
    `---\nname: ${opts.name ?? stem}\ndescription: about ${stem}\ntype: feedback\n---\n${body}\n`,
    opts.mtime,
  );
}

function newProject(name: string): string {
  const dir = join(root, "projects", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read through an assertion, so a missing file fails the test as an assertion rather than ENOENT. */
function readExisting(path: string): string {
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8");
}
const statusFile = () => JSON.parse(readExisting(join(memoryRoot(), "sync-status.json")));
const copyPath = (id: string, project = projectPath) => join(projectMemoryDir(project), `${id}.md`);
const readCopy = (id: string, project = projectPath) =>
  parseMemoryFile(readExisting(copyPath(id, project)), id, "project");

/** Real importers on the fake homes, counted, so a test can tell whether a sync read the sources. */
function countedImporters() {
  const calls = { claude: 0, codex: 0, antigravity: 0 };
  const importers: NonNullable<MemorySyncDeps["importers"]> = {
    claude: (p, h) => { calls.claude++; return importClaudeMemories(p, h); },
    codex: (p, h) => { calls.codex++; return importCodexMemories(p, h); },
    antigravity: (p, h) => { calls.antigravity++; return importAntigravity(p, h); },
  };
  return { calls, importers };
}

function makeSync(over: Partial<MemorySyncDeps> = {}) {
  const counted = countedImporters();
  const sync = createMemorySync({
    claudeHome,
    codexHomes: [codexHome],
    antigravityHome: agyHome,
    importers: counted.importers,
    listProjects: () => [projectPath],
    ...over,
  });
  return { sync, calls: counted.calls };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-memory-sync-"));
  process.env.PPM_HOME = join(root, "ppm");
  _resetPpmDir();
  claudeHome = join(root, "claude-home");
  codexHome = join(root, "codex-home");
  agyHome = join(root, "agy-home");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(join(agyHome, ".gemini", "antigravity", "knowledge"), { recursive: true });
  projectPath = newProject("alpha");
});

afterEach(() => {
  closeMemoryIndex();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(root, { recursive: true, force: true });
});

describe("ensureSynced", () => {
  it("creates a copy of every Claude memory on the first sync, and indexes it", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.");
    claudeMemory(projectPath, "tea", "Tea at 3 pm.");
    const { sync } = makeSync();

    await sync.ensureSynced(projectPath);

    const zsh = readCopy("claude-zsh");
    expect(zsh.source).toBe("claude");
    expect(zsh.body).toBe("The Bash tool runs zsh.");
    expect(zsh.origin).toBe(join(claudeDirOf(projectPath), "zsh.md"));
    expect(zsh.originHash).toBeTruthy();
    expect(existsSync(copyPath("claude-tea"))).toBe(true);
    const ids = getMemoryIndex().list([projectMemoryKey(projectPath)]).map((r) => r.id).sort();
    expect(ids).toEqual(["claude-tea", "claude-zsh"]);
  });

  it("calls no importer and reads no memory when nothing changed", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.");
    const { sync, calls } = makeSync();
    await sync.ensureSynced(projectPath);
    expect(calls.claude).toBe(1);

    const list = spyOn(memoryStore, "list");
    const read = spyOn(memoryStore, "read");
    const write = spyOn(memoryStore, "write");
    try {
      await sync.ensureSynced(projectPath);
      await sync.ensureSynced(projectPath);
      expect(calls).toEqual({ claude: 1, codex: 1, antigravity: 1 });
      expect(list).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("keeps the fingerprint in sync-status.json, so a restarted server does not import again", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.");
    await makeSync().sync.ensureSynced(projectPath);
    expect(typeof statusFile().fingerprint[projectMemoryKey(projectPath)]).toBe("string");

    const { sync, calls } = makeSync();
    await sync.ensureSynced(projectPath);
    expect(calls).toEqual({ claude: 0, codex: 0, antigravity: 0 });
  });

  it("updates the copy when the source file changes (new origin_hash)", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.", { mtime: 1_700_000_000 });
    const { sync, calls } = makeSync();
    await sync.ensureSynced(projectPath);
    const before = readCopy("claude-zsh");

    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh, quote every list.", { mtime: 1_700_000_100 });
    await sync.ensureSynced(projectPath);

    expect(calls.claude).toBe(2);
    const after = readCopy("claude-zsh");
    expect(after.body).toBe("The Bash tool runs zsh, quote every list.");
    expect(after.originHash).not.toBe(before.originHash);
    expect(after.created).toBe(before.created);
  });

  it("leaves an unchanged copy untouched when another source file changes", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.", { mtime: 1_700_000_000 });
    claudeMemory(projectPath, "tea", "Tea at 3 pm.", { mtime: 1_700_000_000 });
    const { sync } = makeSync();
    await sync.ensureSynced(projectPath);
    const teaBefore = readExisting(copyPath("claude-tea"));

    claudeMemory(projectPath, "zsh", "zsh, really.", { mtime: 1_700_000_200 });
    await sync.ensureSynced(projectPath);
    expect(readFileSync(copyPath("claude-tea"), "utf8")).toBe(teaBefore);
  });

  it("archives the copy of a vanished item, keeps its file, and un-archives it when it comes back", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.", { mtime: 1_700_000_000 });
    claudeMemory(projectPath, "tea", "Tea at 3 pm.", { mtime: 1_700_000_000 });
    const { sync } = makeSync();
    await sync.ensureSynced(projectPath);

    unlinkSync(join(claudeDirOf(projectPath), "tea.md"));
    await sync.ensureSynced(projectPath);
    expect(existsSync(copyPath("claude-tea"))).toBe(true);
    expect(readCopy("claude-tea").archived).toBe(true);
    expect(readCopy("claude-zsh").archived).toBeUndefined();
    const active = getMemoryIndex().list([projectMemoryKey(projectPath)]).map((r) => r.id);
    expect(active).toEqual(["claude-zsh"]);

    claudeMemory(projectPath, "tea", "Tea at 3 pm.", { mtime: 1_700_000_000 });
    await sync.ensureSynced(projectPath);
    expect(readCopy("claude-tea").archived).toBeUndefined();
    expect(getMemoryIndex().list([projectMemoryKey(projectPath)]).map((r) => r.id).sort()).toEqual(["claude-tea", "claude-zsh"]);
  });

  it("never archives a memory written in PPM", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.", { mtime: 1_700_000_000 });
    const { sync } = makeSync();
    await sync.ensureSynced(projectPath);
    const own = await memoryStore.write(
      { scope: "project", projectPath, name: "mine", description: "my own", type: "user", body: "kept" },
      { caller: "tool" },
    );
    unlinkSync(join(claudeDirOf(projectPath), "zsh.md"));
    await sync.ensureSynced(projectPath);
    const mine = await memoryStore.read(own.record.id, "project", projectPath);
    expect(mine?.archived).toBeUndefined();
  });

  it("keeps syncing the other providers when one fails, and records the error", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.");
    put(join(codexHome, "memories", "memory_summary.md"), "v1\n# Codex learned things\nAlways run tests.\n");
    const { sync } = makeSync({
      importers: {
        claude: () => Promise.reject(new Error("claude folder is on fire")),
        codex: (p, h) => importCodexMemories(p, h),
        antigravity: (p, h) => importAntigravity(p, h),
      },
    });

    await sync.ensureSynced(projectPath);

    expect(existsSync(join(globalMemoryDir(), "codex-summary.md"))).toBe(true);
    const status = statusFile();
    expect(status.providers.claude.error).toContain("claude folder is on fire");
    expect(status.providers.codex.error).toBeNull();
    expect(status.providers.codex.count).toBe(1);
    expect(typeof status.providers.codex.syncedAt).toBe("string");
  });

  it("does not archive a provider's copies when its import reported an error", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.", { mtime: 1_700_000_000 });
    let fail = false;
    const { sync } = makeSync({
      importers: {
        claude: async (p, h) => (fail ? { items: [], skipped: [], error: "locked" } : importClaudeMemories(p, h)),
        codex: (p, h) => importCodexMemories(p, h),
        antigravity: (p, h) => importAntigravity(p, h),
      },
    });
    await sync.ensureSynced(projectPath);
    fail = true;
    claudeMemory(projectPath, "zsh", "changed", { mtime: 1_700_000_300 });
    await sync.ensureSynced(projectPath);
    expect(readCopy("claude-zsh").archived).toBeUndefined();
    expect(statusFile().providers.claude.error).toBe("locked");
  });

  it("records skipped items and redacted secrets per provider in sync-status.json", async () => {
    claudeMemory(projectPath, "keys", "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz and api_key=supersecret99");
    const knowledge = join(agyHome, ".gemini", "antigravity", "knowledge");
    put(join(knowledge, "good", "metadata.json"), JSON.stringify({ title: "Deploy steps", summary: "how we deploy" }));
    put(join(knowledge, "bad", "metadata.json"), "{ not json");
    const { sync } = makeSync();

    await sync.ensureSynced(projectPath);

    const status = statusFile();
    expect(status.providers.claude.redacted).toBe(2);
    expect(status.providers.claude.count).toBe(1);
    expect(status.providers.antigravity.count).toBe(1);
    expect(status.providers.antigravity.skipped).toHaveLength(1);
    expect(status.providers.antigravity.skipped[0]).toContain("bad");
    expect(readCopy("claude-keys").body).not.toContain("supersecret99");
    expect(await sync.status(projectPath)).toEqual(status.providers);
  });

  it("lets concurrent callers share one run", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.");
    const { sync, calls } = makeSync();
    const [a, b] = await Promise.all([sync.ensureSynced(projectPath), sync.ensureSynced(projectPath)]);
    expect(calls.claude).toBe(1);
    expect(a).toBe(b);
  });

  it("syncs global sources (Codex summary, Antigravity items) once, fingerprinted apart from the project", async () => {
    put(join(codexHome, "memories", "memory_summary.md"), "v1\n# Codex learned things\nAlways run tests.\n");
    const knowledge = join(agyHome, ".gemini", "antigravity", "knowledge");
    put(join(knowledge, "deploy", "metadata.json"), JSON.stringify({ title: "Deploy steps", summary: "how we deploy" }));
    put(join(knowledge, "deploy", "artifacts", "steps.md"), "1. build\n2. ship\n");
    const beta = newProject("beta");
    const { sync, calls } = makeSync({ listProjects: () => [projectPath, beta] });

    await sync.ensureSynced(projectPath);
    expect(existsSync(join(globalMemoryDir(), "codex-summary.md"))).toBe(true);
    const agy = parseMemoryFile(readExisting(join(globalMemoryDir(), "agy-deploy.md")), "agy-deploy", "global");
    expect(agy.source).toBe("antigravity");
    expect(agy.name).toBe("Deploy steps");
    const ids = getMemoryIndex().list([GLOBAL_MEMORY_KEY]).map((r) => r.id).sort();
    expect(ids).toEqual(["agy-deploy", "codex-summary"]);
    expect(typeof statusFile().fingerprint[GLOBAL_MEMORY_KEY]).toBe("string");

    // Another project: its own sources are new, the global ones are not.
    await sync.ensureSynced(beta);
    expect(calls.antigravity).toBe(1);
    expect(calls.claude).toBe(2);

    // A global item vanishes: archived, file kept.
    rmSync(join(knowledge, "deploy"), { recursive: true });
    await sync.ensureSynced(beta);
    expect(calls.antigravity).toBe(2);
    const archived = parseMemoryFile(readExisting(join(globalMemoryDir(), "agy-deploy.md")), "agy-deploy", "global");
    expect(archived.archived).toBe(true);
  });

  it("re-imports Codex when its database files change", async () => {
    const { sync, calls } = makeSync();
    await sync.ensureSynced(projectPath);
    expect(calls.codex).toBe(1);
    put(join(codexHome, "state_5.sqlite"), "x");
    await sync.ensureSynced(projectPath);
    expect(calls.codex).toBe(2);
  });
});

describe("syncAll", () => {
  it("syncs every configured project, even when nothing changed", async () => {
    const beta = newProject("beta");
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.");
    claudeMemory(beta, "tea", "Tea at 3 pm.");
    const { sync, calls } = makeSync({ listProjects: () => [projectPath, beta] });

    await sync.syncAll();
    expect(existsSync(copyPath("claude-zsh"))).toBe(true);
    expect(existsSync(copyPath("claude-tea", beta))).toBe(true);
    expect(calls.claude).toBe(2);

    await sync.syncAll();
    expect(calls.claude).toBe(4);
  });

  it("goes on with the next project when one fails", async () => {
    const beta = newProject("beta");
    claudeMemory(beta, "tea", "Tea at 3 pm.");
    const { sync } = makeSync({
      listProjects: () => [projectPath, beta],
      importers: {
        claude: (p, h) => (p === projectPath ? Promise.reject(new Error("boom")) : importClaudeMemories(p, h)),
        codex: (p, h) => importCodexMemories(p, h),
        antigravity: (p, h) => importAntigravity(p, h),
      },
    });
    await sync.syncAll();
    expect(existsSync(copyPath("claude-tea", beta))).toBe(true);
  });
});

describe("listeners", () => {
  it("fires onChange after a sync that changed memories, not after one that changed nothing", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.", { mtime: 1_700_000_000 });
    const { sync } = makeSync();
    const changes: unknown[] = [];
    sync.setChangeListener((change) => changes.push(change));

    await sync.ensureSynced(projectPath);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ projectPath });

    await sync.ensureSynced(projectPath);
    expect(changes).toHaveLength(1);

    claudeMemory(projectPath, "zsh", "changed body", { mtime: 1_700_000_500 });
    await sync.ensureSynced(projectPath);
    expect(changes).toHaveLength(2);
  });

  it("runs afterSync hooks once the index is reconciled, and a failing hook breaks nothing", async () => {
    claudeMemory(projectPath, "zsh", "The Bash tool runs zsh.");
    const { sync } = makeSync();
    const seen: string[][] = [];
    sync.afterSync(() => { throw new Error("hook failed"); });
    const off = sync.afterSync(({ keys }) => {
      seen.push(getMemoryIndex().list(keys).map((r) => r.id));
    });

    await sync.ensureSynced(projectPath);
    expect(seen).toEqual([["claude-zsh"]]);

    off();
    claudeMemory(projectPath, "tea", "Tea at 3 pm.");
    await sync.ensureSynced(projectPath);
    expect(seen).toHaveLength(1);
  });
});
