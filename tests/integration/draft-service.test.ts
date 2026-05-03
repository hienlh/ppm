import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

/**
 * Integration tests for DraftService
 * Tests the service layer for draft content persistence and retrieval
 */

let testDb: Database;

function resetDb() {
  // Clear tables but keep schema
  testDb.exec("DELETE FROM chat_drafts");
  testDb.exec("DELETE FROM session_metadata");
}

beforeEach(() => {
  const { openTestDb, setDb } = require("../../src/services/db.service.ts");
  testDb = openTestDb();
  setDb(testDb);
  resetDb();
});

afterEach(() => {
  if (testDb) {
    testDb.close();
  }
});

describe("DraftService", () => {
  const { draftService } = require("../../src/services/draft.service.ts");

  describe("get()", () => {
    it("returns null for non-existent draft", () => {
      const result = draftService.get("/project/path", "session-123");
      expect(result).toBeNull();
    });

    it("returns null when project_path and session_id don't match", () => {
      draftService.upsert("/project/a", "session-1", "content");
      const result = draftService.get("/project/b", "session-1");
      expect(result).toBeNull();
    });

    it("returns draft when it exists", () => {
      draftService.upsert("/project/path", "session-123", "test content");
      const result = draftService.get("/project/path", "session-123");

      expect(result).not.toBeNull();
      expect(result?.content).toBe("test content");
      expect(result?.attachments).toBe("[]");
      expect(result?.updatedAt).toBeTruthy();
    });
  });

  describe("upsert()", () => {
    it("creates a new draft", () => {
      draftService.upsert("/project/path", "session-1", "hello world");
      const result = draftService.get("/project/path", "session-1");

      expect(result).not.toBeNull();
      expect(result?.content).toBe("hello world");
    });

    it("overwrites existing draft (same project_path + session_id)", () => {
      draftService.upsert("/project/path", "session-1", "first content");
      draftService.upsert("/project/path", "session-1", "second content");
      const result = draftService.get("/project/path", "session-1");

      expect(result?.content).toBe("second content");
    });

    it("stores attachments as JSON string", () => {
      const attachments = JSON.stringify([{ name: "file.txt", size: 100 }]);
      draftService.upsert("/project/path", "session-1", "content", attachments);
      const result = draftService.get("/project/path", "session-1");

      expect(result?.attachments).toBe(attachments);
      // Verify it's valid JSON
      expect(() => JSON.parse(result?.attachments ?? "")).not.toThrow();
    });

    it("defaults attachments to empty array if not provided", () => {
      draftService.upsert("/project/path", "session-1", "content");
      const result = draftService.get("/project/path", "session-1");

      expect(result?.attachments).toBe("[]");
    });

    it("truncates content silently at 50KB", () => {
      const largeContent = "x".repeat(60 * 1024); // 60KB
      draftService.upsert("/project/path", "session-1", largeContent);
      const result = draftService.get("/project/path", "session-1");

      // Should be truncated to 50KB max
      expect(result?.content.length).toBeLessThanOrEqual(50 * 1024);
      expect(result?.content.length).toBe(50 * 1024);
    });

    it("allows content exactly at 50KB limit", () => {
      const contentAt50KB = "y".repeat(50 * 1024);
      draftService.upsert("/project/path", "session-1", contentAt50KB);
      const result = draftService.get("/project/path", "session-1");

      expect(result?.content.length).toBe(50 * 1024);
      expect(result?.content).toBe(contentAt50KB);
    });

    it("allows content under 50KB limit", () => {
      const contentUnder = "z".repeat(25 * 1024);
      draftService.upsert("/project/path", "session-1", contentUnder);
      const result = draftService.get("/project/path", "session-1");

      expect(result?.content).toBe(contentUnder);
    });

    it("keeps separate drafts for different projects", () => {
      draftService.upsert("/project/a", "session-1", "content-a");
      draftService.upsert("/project/b", "session-1", "content-b");

      const resultA = draftService.get("/project/a", "session-1");
      const resultB = draftService.get("/project/b", "session-1");

      expect(resultA?.content).toBe("content-a");
      expect(resultB?.content).toBe("content-b");
    });

    it("keeps separate drafts for different sessions in same project", () => {
      draftService.upsert("/project/path", "session-1", "session-1-content");
      draftService.upsert("/project/path", "session-2", "session-2-content");

      const result1 = draftService.get("/project/path", "session-1");
      const result2 = draftService.get("/project/path", "session-2");

      expect(result1?.content).toBe("session-1-content");
      expect(result2?.content).toBe("session-2-content");
    });

    it("updates updatedAt timestamp on upsert", async () => {
      draftService.upsert("/project/path", "session-1", "content");
      const first = draftService.get("/project/path", "session-1");

      // SQLite datetime() has second-level precision, so wait 1+ second
      await new Promise(r => setTimeout(r, 1100));

      draftService.upsert("/project/path", "session-1", "updated content");
      const second = draftService.get("/project/path", "session-1");

      expect(first?.updatedAt).toBeTruthy();
      expect(second?.updatedAt).toBeTruthy();
      // Timestamps should differ (SQLite datetime() precision is seconds)
      expect(second?.updatedAt).not.toBe(first?.updatedAt);
    });
  });

  describe("delete()", () => {
    it("removes a draft", () => {
      draftService.upsert("/project/path", "session-1", "content");
      expect(draftService.get("/project/path", "session-1")).not.toBeNull();

      draftService.delete("/project/path", "session-1");
      expect(draftService.get("/project/path", "session-1")).toBeNull();
    });

    it("is a no-op when draft doesn't exist", () => {
      expect(() => {
        draftService.delete("/project/path", "non-existent");
      }).not.toThrow();
    });

    it("does not affect other drafts", () => {
      draftService.upsert("/project/path", "session-1", "content-1");
      draftService.upsert("/project/path", "session-2", "content-2");

      draftService.delete("/project/path", "session-1");

      expect(draftService.get("/project/path", "session-1")).toBeNull();
      expect(draftService.get("/project/path", "session-2")).not.toBeNull();
    });

    it("only deletes from the exact project_path", () => {
      draftService.upsert("/project/a", "session-1", "content-a");
      draftService.upsert("/project/b", "session-1", "content-b");

      draftService.delete("/project/a", "session-1");

      expect(draftService.get("/project/a", "session-1")).toBeNull();
      expect(draftService.get("/project/b", "session-1")).not.toBeNull();
    });
  });

  describe("deleteOrphaned()", () => {
    it("returns the count of deleted drafts", () => {
      draftService.upsert("/project/path", "orphan-session-1", "content");
      draftService.upsert("/project/path", "orphan-session-2", "content");

      const count = draftService.deleteOrphaned();
      expect(count).toBe(2);
    });

    it("does not delete __new__ session drafts", () => {
      draftService.upsert("/project/path", "__new__", "unsaved content");
      draftService.deleteOrphaned();

      const result = draftService.get("/project/path", "__new__");
      expect(result).not.toBeNull();
      expect(result?.content).toBe("unsaved content");
    });

    it("deletes tab-* session drafts if not in session_metadata", () => {
      draftService.upsert("/project/path", "tab-editor-1", "editor content");
      draftService.upsert("/project/path", "tab-settings-1", "settings content");
      const count = draftService.deleteOrphaned();

      // tab-* sessions ARE deleted if not in session_metadata
      expect(count).toBe(2);
      expect(draftService.get("/project/path", "tab-editor-1")).toBeNull();
      expect(draftService.get("/project/path", "tab-settings-1")).toBeNull();
    });

    it("preserves tab-* session drafts if in session_metadata", () => {
      const { setSessionMetadata } = require("../../src/services/db.service.ts");

      draftService.upsert("/project/path", "tab-editor-1", "editor content");
      setSessionMetadata("tab-editor-1", "project", "/project/path");

      const count = draftService.deleteOrphaned();

      // tab-* sessions are preserved if they're in session_metadata
      expect(count).toBe(0);
      expect(draftService.get("/project/path", "tab-editor-1")).not.toBeNull();
    });

    it("deletes drafts whose session_id is not in session_metadata", () => {
      // Create a draft without corresponding session_metadata entry
      draftService.upsert("/project/path", "orphaned-id", "orphaned content");

      const deletedCount = draftService.deleteOrphaned();

      expect(deletedCount).toBe(1);
      expect(draftService.get("/project/path", "orphaned-id")).toBeNull();
    });

    it("keeps drafts whose session_id is in session_metadata", () => {
      const { setSessionMetadata } = require("../../src/services/db.service.ts");

      const sessionId = "active-session-123";
      draftService.upsert("/project/path", sessionId, "active content");
      setSessionMetadata(sessionId, "test-project", "/project/path");

      const deletedCount = draftService.deleteOrphaned();

      expect(deletedCount).toBe(0);
      expect(draftService.get("/project/path", sessionId)).not.toBeNull();
    });

    it("handles mixed orphaned and active drafts correctly", () => {
      const { setSessionMetadata } = require("../../src/services/db.service.ts");

      // Orphaned drafts (will be deleted)
      draftService.upsert("/project/path", "orphaned-1", "content");
      draftService.upsert("/project/path", "orphaned-2", "content");

      // Active drafts (have session_metadata - preserved)
      const activeSession1 = "active-1";
      const activeSession2 = "active-2";
      draftService.upsert("/project/path", activeSession1, "active content 1");
      draftService.upsert("/project/path", activeSession2, "active content 2");
      setSessionMetadata(activeSession1, "project", "/project/path");
      setSessionMetadata(activeSession2, "project", "/project/path");

      // Special __new__ session (preserved)
      draftService.upsert("/project/path", "__new__", "new session");

      // tab-* sessions without session_metadata (deleted)
      draftService.upsert("/project/path", "tab-editor", "editor tab");

      const deletedCount = draftService.deleteOrphaned();

      // Should delete: orphaned-1, orphaned-2, tab-editor (3 total)
      expect(deletedCount).toBe(3);
      expect(draftService.get("/project/path", "orphaned-1")).toBeNull();
      expect(draftService.get("/project/path", "orphaned-2")).toBeNull();
      expect(draftService.get("/project/path", "tab-editor")).toBeNull();
      // Should preserve: active sessions and __new__
      expect(draftService.get("/project/path", activeSession1)).not.toBeNull();
      expect(draftService.get("/project/path", activeSession2)).not.toBeNull();
      expect(draftService.get("/project/path", "__new__")).not.toBeNull();
    });
  });

  describe("Integration: round-trip operations", () => {
    it("upsert → get → delete → get returns expected values", () => {
      const projectPath = "/project/test";
      const sessionId = "session-roundtrip";
      const content = "roundtrip test content";
      const attachments = JSON.stringify({ files: ["a.txt"] });

      // Initially null
      expect(draftService.get(projectPath, sessionId)).toBeNull();

      // After upsert, content is retrievable
      draftService.upsert(projectPath, sessionId, content, attachments);
      const draft = draftService.get(projectPath, sessionId);
      expect(draft?.content).toBe(content);
      expect(draft?.attachments).toBe(attachments);

      // After delete, it's gone
      draftService.delete(projectPath, sessionId);
      expect(draftService.get(projectPath, sessionId)).toBeNull();
    });

    it("multiple upserts accumulate updates only for matching key", () => {
      const projectPath = "/project/test";
      const sessionId = "session-multi";

      draftService.upsert(projectPath, sessionId, "v1");
      draftService.upsert(projectPath, sessionId, "v2");
      draftService.upsert(projectPath, sessionId, "v3");

      const result = draftService.get(projectPath, sessionId);
      expect(result?.content).toBe("v3");
    });
  });

  describe("Edge cases", () => {
    it("handles empty string content", () => {
      draftService.upsert("/project/path", "session-1", "");
      const result = draftService.get("/project/path", "session-1");

      expect(result?.content).toBe("");
    });

    it("handles unicode and special characters in content", () => {
      const special = "こんにちは 🚀 <script>alert('xss')</script>";
      draftService.upsert("/project/path", "session-1", special);
      const result = draftService.get("/project/path", "session-1");

      expect(result?.content).toBe(special);
    });

    it("handles very long project paths", () => {
      const longPath = "/" + "x".repeat(500) + "/project";
      draftService.upsert(longPath, "session-1", "content");
      const result = draftService.get(longPath, "session-1");

      expect(result?.content).toBe("content");
    });

    it("handles attachments with nested JSON structures", () => {
      const complex = JSON.stringify({
        files: [
          { name: "a.txt", tags: ["tag1", "tag2"], metadata: { size: 100 } }
        ]
      });
      draftService.upsert("/project/path", "session-1", "content", complex);
      const result = draftService.get("/project/path", "session-1");

      expect(JSON.parse(result?.attachments ?? "{}")).toEqual(JSON.parse(complex));
    });
  });
});
