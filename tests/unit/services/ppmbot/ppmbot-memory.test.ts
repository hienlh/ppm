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

  describe("saveOne + recall", () => {
    it("should save and recall a fact", () => {
      memory.saveOne("myproject", "Uses PostgreSQL database", "architecture");
      const results = memory.recall("myproject");
      expect(results.length).toBe(1);
      expect(results[0]!.content).toBe("Uses PostgreSQL database");
      expect(results[0]!.category).toBe("architecture");
    });

    it("should recall by FTS query", () => {
      memory.saveOne("myproject", "Uses PostgreSQL for persistence", "architecture");
      memory.saveOne("myproject", "Frontend is React with Tailwind", "architecture");
      const results = memory.recall("myproject", "PostgreSQL");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.content).toContain("PostgreSQL");
    });

    it("should include _global memories in recall", () => {
      memory.saveOne("_global", "User prefers concise responses", "preference");
      memory.saveOne("myproject", "API uses REST", "architecture");
      const results = memory.recall("myproject");
      expect(results.length).toBe(2);
    });
  });

  describe("save (batch)", () => {
    it("should insert multiple facts", () => {
      const count = memory.save("myproject", [
        { content: "Fact one", category: "fact" },
        { content: "Fact two", category: "decision" },
      ]);
      expect(count).toBe(2);
      expect(memory.getSummary("myproject").length).toBe(2);
    });

    it("should skip empty content", () => {
      const count = memory.save("myproject", [
        { content: "", category: "fact" },
        { content: "Real fact", category: "fact" },
      ]);
      expect(count).toBe(1);
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
  });

  describe("parseExtractionResponse", () => {
    it("should parse valid JSON array", () => {
      const input = '[{"content":"Uses Bun runtime","category":"architecture","importance":1.5}]';
      const facts = memory.parseExtractionResponse(input);
      expect(facts.length).toBe(1);
      expect(facts[0]!.content).toBe("Uses Bun runtime");
      expect(facts[0]!.importance).toBe(1.5);
    });

    it("should handle markdown-fenced JSON", () => {
      const input = '```json\n[{"content":"test","category":"fact"}]\n```';
      const facts = memory.parseExtractionResponse(input);
      expect(facts.length).toBe(1);
    });

    it("should return empty for invalid JSON", () => {
      const facts = memory.parseExtractionResponse("This is not JSON");
      expect(facts).toEqual([]);
    });

    it("should return empty for empty array", () => {
      const facts = memory.parseExtractionResponse("[]");
      expect(facts).toEqual([]);
    });

    it("should clamp importance to 0-2 range", () => {
      const input = '[{"content":"test","category":"fact","importance":5.0}]';
      const facts = memory.parseExtractionResponse(input);
      expect(facts[0]!.importance).toBe(2);
    });

    it("should default invalid category to fact", () => {
      const input = '[{"content":"test","category":"invalid_category"}]';
      const facts = memory.parseExtractionResponse(input);
      expect(facts[0]!.category).toBe("fact");
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
  });

  describe("extractiveMemoryFallback", () => {
    it("should extract decisions from text", () => {
      const text = "We decided to use PostgreSQL for the database";
      const facts = memory.extractiveMemoryFallback(text);
      expect(facts.length).toBeGreaterThanOrEqual(1);
      expect(facts[0]!.category).toBe("decision");
    });

    it("should extract preferences from text", () => {
      const text = "I prefer using TypeScript over JavaScript";
      const facts = memory.extractiveMemoryFallback(text);
      expect(facts.length).toBeGreaterThanOrEqual(1);
      expect(facts[0]!.category).toBe("preference");
    });

    it("should return empty for text with no patterns", () => {
      const facts = memory.extractiveMemoryFallback("Hello world");
      expect(facts).toEqual([]);
    });
  });
});
