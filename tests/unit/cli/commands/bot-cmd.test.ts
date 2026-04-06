import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { PPMBotMemory } from "../../../../src/services/ppmbot/ppmbot-memory.ts";

/**
 * Tests for `ppm bot memory save/list/forget` CLI commands.
 *
 * We test the underlying PPMBotMemory operations that the CLI delegates to,
 * using the same _global project scope the CLI uses. This validates the
 * data layer without spawning a child process for each test.
 */
describe("ppm bot memory CLI", () => {
  let memory: PPMBotMemory;

  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    memory = new PPMBotMemory();
  });

  describe("save", () => {
    it("should save a fact to _global", () => {
      const id = memory.saveOne("_global", "User prefers Vietnamese", "preference");
      expect(id).toBeGreaterThan(0);
      const results = memory.getSummary("_global");
      expect(results.length).toBe(1);
      expect(results[0]!.content).toBe("User prefers Vietnamese");
      expect(results[0]!.category).toBe("preference");
      expect(results[0]!.project).toBe("_global");
    });

    it("should save with default category fact", () => {
      memory.saveOne("_global", "Some general fact");
      const results = memory.getSummary("_global");
      expect(results[0]!.category).toBe("fact");
    });

    it("should save with each valid category", () => {
      const categories = ["fact", "decision", "preference", "architecture", "issue"] as const;
      for (const cat of categories) {
        memory.saveOne("_global", `Memory for ${cat}`, cat);
      }
      const results = memory.getSummary("_global");
      expect(results.length).toBe(5);
    });

    it("should allow multiple distinct memories", () => {
      memory.saveOne("_global", "Address user as anh", "preference");
      memory.saveOne("_global", "User prefers dark theme for all interfaces", "preference");
      const results = memory.getSummary("_global");
      expect(results.length).toBe(2);
    });

    it("should save with optional session ID", () => {
      const id = memory.saveOne("_global", "Fact with session", "fact", "sess-abc-123");
      expect(id).toBeGreaterThan(0);
    });
  });

  describe("list", () => {
    it("should return empty array when no memories", () => {
      const results = memory.getSummary("_global");
      expect(results).toEqual([]);
    });

    it("should list all _global memories", () => {
      memory.saveOne("_global", "Pref A", "preference");
      memory.saveOne("_global", "Fact B", "fact");
      memory.saveOne("_global", "Decision C", "decision");
      const results = memory.getSummary("_global");
      expect(results.length).toBe(3);
    });

    it("should not include project-specific memories", () => {
      memory.saveOne("_global", "Global fact", "fact");
      memory.saveOne("myproject", "Project fact", "fact");
      // _global getSummary only returns _global memories
      const results = memory.getSummary("_global");
      expect(results.length).toBe(1);
      expect(results[0]!.content).toBe("Global fact");
    });

    it("should respect limit", () => {
      for (let i = 0; i < 10; i++) {
        memory.saveOne("_global", `Unique fact number ${i} about topic${i}`, "fact");
      }
      const results = memory.getSummary("_global", 3);
      expect(results.length).toBe(3);
    });
  });

  describe("forget", () => {
    it("should delete matching _global memories", () => {
      memory.saveOne("_global", "User prefers Vietnamese language", "preference");
      memory.saveOne("_global", "User likes dark theme", "preference");
      const deleted = memory.forget("_global", "Vietnamese");
      expect(deleted).toBe(1);
      const remaining = memory.getSummary("_global");
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.content).toContain("dark theme");
    });

    it("should return 0 when nothing matches", () => {
      memory.saveOne("_global", "Some fact", "fact");
      const deleted = memory.forget("_global", "nonexistent");
      expect(deleted).toBe(0);
    });

    it("should handle empty topic gracefully", () => {
      const deleted = memory.forget("_global", "");
      expect(deleted).toBe(0);
    });

    it("should delete multiple matching memories", () => {
      memory.saveOne("_global", "Bun runtime is fast for server workloads", "fact");
      memory.saveOne("_global", "Bun test framework is excellent for unit testing", "fact");
      memory.saveOne("_global", "Uses React for frontend rendering", "fact");
      const deleted = memory.forget("_global", "Bun");
      // FTS5 matches content containing "Bun"
      expect(deleted).toBe(2);
      const remaining = memory.getSummary("_global");
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.content).toContain("React");
    });
  });

  describe("cross-project visibility", () => {
    it("_global memories visible from any project", () => {
      memory.saveOne("_global", "User name is Hien", "preference");
      // getSummary for a different project should include _global
      const results = memory.getSummary("other-project");
      expect(results.length).toBe(1);
      expect(results[0]!.content).toBe("User name is Hien");
    });

    it("project memories NOT visible in _global scope", () => {
      memory.saveOne("myproject", "Project-specific fact", "fact");
      const results = memory.getSummary("_global");
      expect(results.length).toBe(0);
    });

    it("both _global and project memories visible from project scope", () => {
      memory.saveOne("_global", "Global preference", "preference");
      memory.saveOne("myproject", "Project fact", "fact");
      const results = memory.getSummary("myproject");
      expect(results.length).toBe(2);
    });
  });
});

describe("ppm bot memory CLI integration", () => {
  it("should execute save subcommand via CLI", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "save", "Test CLI memory", "-c", "preference"],
      {
        cwd: "/Users/hienlh/Projects/ppm",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PPM_HOME: await createTempDir() },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Saved memory");
    expect(stdout).toContain("[preference]");
  });

  it("should execute list subcommand via CLI", async () => {
    const tmpDir = await createTempDir();
    const env = { ...process.env, PPM_HOME: tmpDir };
    const cwd = "/Users/hienlh/Projects/ppm";

    // Save first
    const save = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "save", "CLI list test fact", "-c", "fact"],
      { cwd, stdout: "pipe", stderr: "pipe", env },
    );
    await save.exited;

    // Then list
    const list = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "list"],
      { cwd, stdout: "pipe", stderr: "pipe", env },
    );
    const stdout = await new Response(list.stdout).text();
    const exitCode = await list.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("CLI list test fact");
  });

  it("should execute forget subcommand via CLI", async () => {
    const tmpDir = await createTempDir();
    const env = { ...process.env, PPM_HOME: tmpDir };
    const cwd = "/Users/hienlh/Projects/ppm";

    // Save first
    const save = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "save", "Forgettable memory about TypeScript"],
      { cwd, stdout: "pipe", stderr: "pipe", env },
    );
    await save.exited;

    // Forget
    const forget = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "forget", "TypeScript"],
      { cwd, stdout: "pipe", stderr: "pipe", env },
    );
    const stdout = await new Response(forget.stdout).text();
    const exitCode = await forget.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Deleted");
  });

  it("should output JSON with --json flag", async () => {
    const tmpDir = await createTempDir();
    const env = { ...process.env, PPM_HOME: tmpDir };
    const cwd = "/Users/hienlh/Projects/ppm";

    // Save first
    const save = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "save", "JSON test memory"],
      { cwd, stdout: "pipe", stderr: "pipe", env },
    );
    await save.exited;

    // List with --json
    const list = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "list", "--json"],
      { cwd, stdout: "pipe", stderr: "pipe", env },
    );
    const stdout = await new Response(list.stdout).text();
    const exitCode = await list.exited;
    expect(exitCode).toBe(0);
    // JSON output may be multi-line; find the start bracket and parse from there
    const startIdx = stdout.indexOf("[");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(stdout.slice(startIdx));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].content).toBe("JSON test memory");
  });
});

async function createTempDir(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(tmpdir(), "ppm-test-"));
}
