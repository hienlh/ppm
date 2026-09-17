import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexNativeMemory } from "../../../src/services/codex-native-memory.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(legacy = false) {
  const home = mkdtempSync(join(tmpdir(), "ppm-native-memory-"));
  homes.push(home);
  const project = join(home, "project");
  const state = new Database(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, memory_mode TEXT)");
  const memories = legacy ? state : new Database(join(home, "memories_1.sqlite"));
  memories.exec("CREATE TABLE stage1_outputs (thread_id TEXT, raw_memory TEXT, rollout_summary TEXT, generated_at INTEGER)");
  const put = (id: string, cwd: string, content: string, mode = "enabled") => {
    state.query("INSERT INTO threads VALUES (?,?,?)").run(id, cwd, mode);
    memories.query("INSERT INTO stage1_outputs VALUES (?,?,?,?)").run(id, content, "PRIVATE ROLLOUT", Date.now());
  };
  const close = () => { if (memories !== state) memories.close(); state.close(); };
  return { home, project, put, close };
}

test("reads existing native project memory without transcripts or another project's memory", () => {
  const { home, project, put, close } = fixture();
  put("one", project, "Existing durable fact");
  put("other", `${project}-other`, "PRIVATE OTHER PROJECT");
  put("disabled", project, "PRIVATE DISABLED", "disabled");
  close();
  const result = readCodexNativeMemory(project, [home]);
  expect(result).toHaveLength(1);
  expect(result[0]?.content).toBe("Existing durable fact");
  expect(result[0]?.path).toContain("memories_1.sqlite#stage1_outputs/one");
});

test("supports legacy native state memory and bounds oversized entries", () => {
  const { home, project, put, close } = fixture(true);
  put("one", project, "Legacy native fact");
  put("large", project, "x".repeat(13_000));
  close();
  const result = readCodexNativeMemory(project, [home]);
  expect(result).toHaveLength(2);
  expect(result.find((item) => item.path.endsWith("/one"))?.content).toBe("Legacy native fact");
  const large = result.find((item) => item.path.endsWith("/large"))!;
  expect(large.content).toContain("x".repeat(12_000));
  expect(large.content).toContain("Excerpt truncated");
  expect(large.content.length).toBeLessThan(12_200);
});

test("deduplicates accounts and tolerates absent or incompatible schemas", () => {
  const { home, project, put, close } = fixture();
  put("one", project, "Existing fact");
  close();
  expect(readCodexNativeMemory(project, [home, home, join(home, "missing")])).toHaveLength(1);
  const invalid = new Database(join(home, "state_99.sqlite"));
  invalid.exec("CREATE TABLE unrelated (id TEXT)");
  invalid.close();
  expect(readCodexNativeMemory(project, [home])).toEqual([]);
});

test("resolves a project directory alias before matching native thread paths", () => {
  const { home, project, put, close } = fixture();
  mkdirSync(project);
  const alias = join(home, "project-alias");
  symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  put("one", project, "Canonical project fact");
  close();
  expect(readCodexNativeMemory(alias, [home])[0]?.content).toBe("Canonical project fact");
});
