import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { listCursorSessions, loadCursorHistory } from "../../src/providers/cursor-cli/cursor-history";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures/cursor-chats");

// These fixture sessions are copied from real Cursor ~/.cursor/chats/ databases
const SESSION_574 = "574da70a-6915-486c-aafa-65f0a4df63ac";
const SESSION_305 = "3058cb6a-67a7-4569-bf23-f02eb2c2b187";

describe("Cursor history — real data fixtures", () => {
  describe("listCursorSessions", () => {
    it("should list sessions from fixture directory", async () => {
      const sessions = await listCursorSessions("cursor", FIXTURES_DIR);
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(SESSION_574);
      expect(ids).toContain(SESSION_305);
    });

    it("should read session title from meta table (hex-encoded JSON)", async () => {
      const sessions = await listCursorSessions("cursor", FIXTURES_DIR);
      const s574 = sessions.find((s) => s.id === SESSION_574);
      // Meta name for 574da70a starts with "Hãy sửa lại theo yêu cầu sau"
      expect(s574?.title).toStartWith("Hãy sửa lại theo yêu cầu sau");
    });

    it("should read session title for cursor-agent created session", async () => {
      const sessions = await listCursorSessions("cursor", FIXTURES_DIR);
      const s305 = sessions.find((s) => s.id === SESSION_305);
      expect(s305?.title).toBe("New Agent");
    });

    it("should extract createdAt from meta", async () => {
      const sessions = await listCursorSessions("cursor", FIXTURES_DIR);
      const s574 = sessions.find((s) => s.id === SESSION_574);
      expect(s574?.createdAt).toBeDefined();
      // Should be a valid ISO date
      const date = new Date(s574!.createdAt);
      expect(date.getTime()).not.toBeNaN();
    });

    it("should set providerId on all sessions", async () => {
      const sessions = await listCursorSessions("cursor", FIXTURES_DIR);
      for (const s of sessions) {
        expect(s.providerId).toBe("cursor");
      }
    });

    it("should sort sessions by createdAt descending", async () => {
      const sessions = await listCursorSessions("cursor", FIXTURES_DIR);
      for (let i = 1; i < sessions.length; i++) {
        const prev = new Date(sessions[i - 1].createdAt).getTime();
        const curr = new Date(sessions[i].createdAt).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    });

    it("should return empty array for non-existent directory", async () => {
      const result = await listCursorSessions("cursor", "/nonexistent/path");
      expect(result).toEqual([]);
    });
  });

  describe("loadCursorHistory", () => {
    it("should load messages from a real session (fallback scan)", async () => {
      const messages = await loadCursorHistory(SESSION_574, undefined, FIXTURES_DIR);
      expect(messages.length).toBeGreaterThan(0);
    });

    it("should parse role and content from structured messages", async () => {
      const messages = await loadCursorHistory(SESSION_305, undefined, FIXTURES_DIR);
      expect(messages.length).toBeGreaterThan(0);
      // At least one message should have role "user" or "assistant" or "system"
      const roles = messages.map((m) => m.role);
      expect(roles.some((r) => ["user", "assistant", "system"].includes(r))).toBe(true);
    });

    it("should extract text from content parts array", async () => {
      const messages = await loadCursorHistory(SESSION_305, undefined, FIXTURES_DIR);
      // The user message should contain "Test cursor" (content parts format)
      const userMsgs = messages.filter((m) => m.role === "user");
      const hasTestContent = userMsgs.some((m) =>
        m.content.includes("Test cursor") || m.content.includes("user_query"),
      );
      expect(hasTestContent).toBe(true);
    });

    it("should skip binary DAG metadata blobs", async () => {
      const messages = await loadCursorHistory(SESSION_574, undefined, FIXTURES_DIR);
      // No message content should start with binary characters
      for (const msg of messages) {
        expect(msg.content.length).toBeGreaterThan(0);
        // Content should be readable text, not binary garbage
        const firstChar = msg.content.charCodeAt(0);
        expect(firstChar).toBeGreaterThanOrEqual(0x20);
      }
    });

    it("should return empty for non-existent session", async () => {
      const messages = await loadCursorHistory("non-existent-session", undefined, FIXTURES_DIR);
      expect(messages).toEqual([]);
    });

    it("should return empty for non-existent chatsDir", async () => {
      const messages = await loadCursorHistory(SESSION_574, undefined, "/nonexistent/path");
      expect(messages).toEqual([]);
    });

    it("should set id and timestamp on each message", async () => {
      const messages = await loadCursorHistory(SESSION_305, undefined, FIXTURES_DIR);
      for (const msg of messages) {
        expect(msg.id).toBeDefined();
        expect(msg.id.length).toBeGreaterThan(0);
        expect(msg.timestamp).toBeDefined();
        expect(new Date(msg.timestamp).getTime()).not.toBeNaN();
      }
    });
  });
});
