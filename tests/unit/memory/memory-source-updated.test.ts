import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Found by syncing the real Claude memories (2026-11-12): every copy carried the sync time as
// `updated`, so the session list's "newest first" was the file-name order and ~20 of 109 made it in.
const ppmHome = mkdtempSync(join(tmpdir(), "ppm-mem-updated-"));
process.env.PPM_HOME = ppmHome;

const { createMemorySync } = await import("../../../src/services/memory/memory-sync.ts");
const { memoryStore } = await import("../../../src/services/memory/memory-store.ts");
const { importClaudeMemories } = await import("../../../src/services/memory/import-claude.ts");

const project = mkdtempSync(join(tmpdir(), "ppm-mem-proj-"));
const claudeHome = mkdtempSync(join(tmpdir(), "ppm-mem-claude-"));

describe("imported memories keep the source's change time", () => {
  beforeAll(async () => {
    const { claudeMemoryDir } = await import("../../../src/services/memory/import-claude.ts");
    const dir = await claudeMemoryDir(project, claudeHome);
    mkdirSync(dir, { recursive: true });
    const file = (name: string, when: string) => {
      const path = join(dir, `${name}.md`);
      writeFileSync(path, `---\nname: ${name}\ndescription: ${name} memory\n---\nbody of ${name}\n`);
      const t = new Date(when);
      utimesSync(path, t, t);
    };
    file("old-one", "2026-01-02T03:04:05Z");
    file("new-one", "2026-11-01T00:00:00Z");
  });

  test("the Claude importer reports each file's mtime", async () => {
    const { items } = await importClaudeMemories(project, { claudeHome });
    const byId = Object.fromEntries(items.map((i) => [i.id, i.sourceUpdated]));
    expect(byId["claude-old-one"]).toBe("2026-01-02T03:04:05.000Z");
    expect(byId["claude-new-one"]).toBe("2026-11-01T00:00:00.000Z");
  });

  test("a synced copy's created/updated are the source's time, not the sync's", async () => {
    const sync = createMemorySync({ claudeHome, codexHomes: [], antigravityHome: mkdtempSync(join(tmpdir(), "ppm-mem-agy-")) });
    await sync.ensureSynced(project);
    const old = await memoryStore.read("claude-old-one", "project", project);
    expect(old.updated.slice(0, 19)).toBe("2026-01-02T03:04:05");
    expect(old.created.slice(0, 19)).toBe("2026-01-02T03:04:05");
  });

  test("a tool write still stamps now", async () => {
    const before = Date.now();
    const { record } = await memoryStore.write(
      { scope: "project", projectPath: project, name: "n", description: "d", type: "project", body: "b", updated: "2000-01-01T00:00:00Z" },
      { caller: "tool" },
    );
    expect(Date.parse(record.updated)).toBeGreaterThanOrEqual(before - 1000);
  });
});
