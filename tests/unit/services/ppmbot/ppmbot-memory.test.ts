import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { PPMBotMemory } from "../../../../src/services/ppmbot/ppmbot-memory.ts";

describe("PPMBot Memory", () => {
  let memory: PPMBotMemory;

  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    memory = new PPMBotMemory();
  });

  describe("saveOne + getSummary", () => {
    it("should save and retrieve a fact", () => {
      memory.saveOne("myproject", "Uses PostgreSQL database", "architecture");
      const results = memory.getSummary("myproject");
      expect(results.length).toBe(1);
      expect(results[0]!.content).toBe("Uses PostgreSQL database");
      expect(results[0]!.category).toBe("architecture");
    });

    it("should include _global memories in getSummary", () => {
      memory.saveOne("_global", "User prefers concise responses", "preference");
      memory.saveOne("myproject", "API uses REST", "architecture");
      const results = memory.getSummary("myproject");
      expect(results.length).toBe(2);
    });

    it("should save with default category fact", () => {
      memory.saveOne("_global", "Some fact");
      const results = memory.getSummary("_global");
      expect(results[0]!.category).toBe("fact");
    });

    it("should save with session ID", () => {
      const id = memory.saveOne("_global", "Saved with session", "preference", "sess-123");
      expect(id).toBeGreaterThan(0);
    });

    it("should keep distinct memories separate", () => {
      memory.saveOne("_global", "User prefers formal language", "preference");
      memory.saveOne("_global", "Dark theme is preferred for UI", "preference");
      const results = memory.getSummary("_global");
      expect(results.length).toBe(2);
    });

    it("should respect limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        memory.saveOne("_global", `Fact number ${i}`, "fact");
      }
      const results = memory.getSummary("_global", 5);
      expect(results.length).toBe(5);
    });
  });

  describe("forget", () => {
    it("should delete memories matching topic", () => {
      memory.saveOne("myproject", "Uses PostgreSQL database", "architecture");
      memory.saveOne("myproject", "Frontend is React", "architecture");
      const deleted = memory.forget("myproject", "PostgreSQL");
      expect(deleted).toBe(1);
      expect(memory.getSummary("myproject").length).toBe(1);
    });

    it("should return 0 when no match", () => {
      memory.saveOne("_global", "Uses Bun runtime", "architecture");
      const deleted = memory.forget("_global", "nonexistent");
      expect(deleted).toBe(0);
    });

    it("should handle empty/invalid FTS query gracefully", () => {
      const deleted = memory.forget("_global", "");
      expect(deleted).toBe(0);
    });

    it("should sanitize special characters in topic", () => {
      memory.saveOne("_global", "Some fact about testing", "fact");
      // These special chars should be stripped, not crash FTS
      const deleted = memory.forget("_global", "testing (AND) OR 'quotes'");
      expect(deleted).toBeGreaterThanOrEqual(0);
    });
  });

  describe("buildRecallPrompt", () => {
    it("should return empty string for no memories", () => {
      expect(memory.buildRecallPrompt([])).toBe("");
    });

    it("should group memories by category", () => {
      const prompt = memory.buildRecallPrompt([
        { id: 1, content: "Uses Bun", category: "architecture", importance: 1, project: "p" },
        { id: 2, content: "Prefer concise", category: "preference", importance: 1, project: "p" },
      ]);
      expect(prompt).toContain("### Architectures");
      expect(prompt).toContain("### Preferences");
      expect(prompt).toContain("Uses Bun");
    });

    it("should contain section header", () => {
      const prompt = memory.buildRecallPrompt([
        { id: 1, content: "test", category: "fact", importance: 1, project: "p" },
      ]);
      expect(prompt).toContain("## User Identity & Preferences");
    });
  });
});
