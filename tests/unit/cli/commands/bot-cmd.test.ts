import { describe, it, expect, beforeEach } from "bun:test";
import {
  openTestDb,
  setDb,
  createPPMBotSession,
  getRecentPPMBotSessions,
  deactivatePPMBotSession,
  getSessionTitles,
  getPinnedSessionIds,
  getApprovedPairedChats,
} from "../../../../src/services/db.service.ts";
import { PPMBotMemory } from "../../../../src/services/ppmbot/ppmbot-memory.ts";
import { resolveChatId } from "../../../../src/cli/commands/bot-cmd.ts";

// ── resolveChatId ──────────────────────────────────────────────────

describe("resolveChatId", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  it("should return --chat value when provided", async () => {
    const result = await resolveChatId("12345");
    expect(result).toBe("12345");
  });

  it("should throw when no paired chats exist", async () => {
    await expect(resolveChatId()).rejects.toThrow("No paired Telegram chats");
  });

  it("should auto-detect single approved chat", async () => {
    // Insert a paired chat directly
    const db = (await import("../../../../src/services/db.service.ts")).getDb();
    db.query(
      `INSERT INTO clawbot_paired_chats (telegram_chat_id, telegram_user_id, display_name, status, approved_at)
       VALUES ('99999', '111', 'TestUser', 'approved', unixepoch())`,
    ).run();

    const result = await resolveChatId();
    expect(result).toBe("99999");
  });

  it("should throw when multiple paired chats exist", async () => {
    const db = (await import("../../../../src/services/db.service.ts")).getDb();
    db.query(
      `INSERT INTO clawbot_paired_chats (telegram_chat_id, telegram_user_id, display_name, status, approved_at)
       VALUES ('11111', '1', 'User1', 'approved', unixepoch())`,
    ).run();
    db.query(
      `INSERT INTO clawbot_paired_chats (telegram_chat_id, telegram_user_id, display_name, status, approved_at)
       VALUES ('22222', '2', 'User2', 'approved', unixepoch())`,
    ).run();

    await expect(resolveChatId()).rejects.toThrow("Multiple paired chats");
  });
});

// ── Memory CLI (unit) ──────────────────────────────────────────────

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
  });

  describe("list", () => {
    it("should return empty array when no memories", () => {
      expect(memory.getSummary("_global")).toEqual([]);
    });

    it("should not include project-specific memories", () => {
      memory.saveOne("_global", "Global fact", "fact");
      memory.saveOne("myproject", "Project fact", "fact");
      const results = memory.getSummary("_global");
      expect(results.length).toBe(1);
      expect(results[0]!.content).toBe("Global fact");
    });

    it("should respect limit", () => {
      for (let i = 0; i < 10; i++) {
        memory.saveOne("_global", `Unique fact number ${i} about topic${i}`, "fact");
      }
      expect(memory.getSummary("_global", 3).length).toBe(3);
    });
  });

  describe("forget", () => {
    it("should delete matching _global memories", () => {
      memory.saveOne("_global", "User prefers Vietnamese language", "preference");
      memory.saveOne("_global", "User likes dark theme", "preference");
      const deleted = memory.forget("_global", "Vietnamese");
      expect(deleted).toBe(1);
      expect(memory.getSummary("_global").length).toBe(1);
    });

    it("should return 0 when nothing matches", () => {
      memory.saveOne("_global", "Some fact", "fact");
      expect(memory.forget("_global", "nonexistent")).toBe(0);
    });

    it("should handle empty topic gracefully", () => {
      expect(memory.forget("_global", "")).toBe(0);
    });
  });

  describe("cross-project visibility", () => {
    it("_global memories visible from any project", () => {
      memory.saveOne("_global", "User name is Hien", "preference");
      const results = memory.getSummary("other-project");
      expect(results.length).toBe(1);
    });

    it("project memories NOT visible in _global scope", () => {
      memory.saveOne("myproject", "Project-specific fact", "fact");
      expect(memory.getSummary("_global").length).toBe(0);
    });

    it("both _global and project memories visible from project scope", () => {
      memory.saveOne("_global", "Global preference", "preference");
      memory.saveOne("myproject", "Project fact", "fact");
      expect(memory.getSummary("myproject").length).toBe(2);
    });
  });
});

// ── Session/Project DB operations (unit) ───────────────────────────

describe("ppm bot session/project CLI", () => {
  const CHAT_ID = "88888";

  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  describe("session list", () => {
    it("should list sessions for a chat", () => {
      createPPMBotSession(CHAT_ID, "sess-1", "claude", "project-a", "/tmp/a");
      createPPMBotSession(CHAT_ID, "sess-2", "claude", "project-a", "/tmp/a");
      const sessions = getRecentPPMBotSessions(CHAT_ID, 10);
      expect(sessions.length).toBe(2);
    });

    it("should return empty when no sessions", () => {
      const sessions = getRecentPPMBotSessions(CHAT_ID, 10);
      expect(sessions.length).toBe(0);
    });

    it("should enrich sessions with titles and pins", () => {
      createPPMBotSession(CHAT_ID, "sess-1", "claude", "proj", "/tmp/p");
      const sessions = getRecentPPMBotSessions(CHAT_ID, 10);
      const titles = getSessionTitles(sessions.map((s) => s.session_id));
      const pinnedIds = getPinnedSessionIds();
      // Just verify these functions don't crash — titles/pins may be empty
      expect(typeof titles).toBe("object");
      expect(pinnedIds instanceof Set).toBe(true);
    });
  });

  describe("session stop (deactivate)", () => {
    it("should deactivate a session", () => {
      createPPMBotSession(CHAT_ID, "sess-stop-1", "claude", "proj", "/tmp/p");
      let sessions = getRecentPPMBotSessions(CHAT_ID, 10);
      expect(sessions[0]!.is_active).toBe(1);

      deactivatePPMBotSession("sess-stop-1");
      sessions = getRecentPPMBotSessions(CHAT_ID, 10);
      expect(sessions[0]!.is_active).toBe(0);
    });
  });

  describe("project list (distinct names)", () => {
    it("should return distinct project names from sessions", () => {
      createPPMBotSession(CHAT_ID, "s1", "claude", "alpha", "/tmp/a");
      createPPMBotSession(CHAT_ID, "s2", "claude", "beta", "/tmp/b");
      createPPMBotSession(CHAT_ID, "s3", "claude", "alpha", "/tmp/a");

      const { getDistinctPPMBotProjectNames } = require("../../../../src/services/db.service.ts");
      const names = getDistinctPPMBotProjectNames();
      expect(names).toContain("alpha");
      expect(names).toContain("beta");
      // No duplicates
      expect(names.filter((n: string) => n === "alpha").length).toBe(1);
    });
  });
});

// ── CLI integration tests ──────────────────────────────────────────

describe("ppm bot CLI integration", () => {
  it("should execute memory save via CLI", async () => {
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
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("Saved memory");
    expect(stdout).toContain("[preference]");
  });

  it("should execute version via CLI", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "version"],
      {
        cwd: "/Users/hienlh/Projects/ppm",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PPM_HOME: await createTempDir() },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("PPM v");
  });

  it("should execute help via CLI", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "help"],
      {
        cwd: "/Users/hienlh/Projects/ppm",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PPM_HOME: await createTempDir() },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("PPMBot CLI Commands");
    expect(stdout).toContain("ppm bot project");
    expect(stdout).toContain("ppm bot session");
    expect(stdout).toContain("ppm bot memory");
  });

  it("should execute project list via CLI", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "project", "list"],
      {
        cwd: "/Users/hienlh/Projects/ppm",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PPM_HOME: await createTempDir() },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    // New DB has no projects, so "No projects" is expected
    expect(stdout).toContain("No projects");
  });

  it("should execute status via CLI (no active session)", async () => {
    const tmpDir = await createTempDir();
    const env = { ...process.env, PPM_HOME: tmpDir };

    // Insert a paired chat so resolveChatId works
    const { Database } = await import("bun:sqlite");
    const { resolve } = await import("node:path");
    const dbPath = resolve(tmpDir, "ppm.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    // Need to run migrations — just use the CLI which auto-inits
    db.close();

    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "status", "--chat", "99999"],
      {
        cwd: "/Users/hienlh/Projects/ppm",
        stdout: "pipe",
        stderr: "pipe",
        env,
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("No active session");
  });

  it("should execute session list via CLI (empty)", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "session", "list", "--chat", "99999"],
      {
        cwd: "/Users/hienlh/Projects/ppm",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PPM_HOME: await createTempDir() },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("No sessions");
  });

  it("should output JSON with --json flag on memory list", async () => {
    const tmpDir = await createTempDir();
    const env = { ...process.env, PPM_HOME: tmpDir };
    const cwd = "/Users/hienlh/Projects/ppm";

    const save = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "save", "JSON test memory"],
      { cwd, stdout: "pipe", stderr: "pipe", env },
    );
    await save.exited;

    const list = Bun.spawn(
      ["bun", "run", "src/index.ts", "bot", "memory", "list", "--json"],
      { cwd, stdout: "pipe", stderr: "pipe", env },
    );
    const stdout = await new Response(list.stdout).text();
    expect(await list.exited).toBe(0);
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
