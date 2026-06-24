import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb, getDb } from "../../../src/services/db.service.ts";
import {
  setSessionUnread,
  clearSessionUnread,
  getAllUnread,
  incrementSessionUnread,
  getSessionTitle,
  setSessionTitle,
} from "../../../src/services/db.service.ts";

describe("Session Unread Tracking — setSessionUnread", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  describe("setSessionUnread — creating & updating", () => {
    it("creates row when no session_metadata exists yet", () => {
      const sessionId = "test-session-1";
      setSessionUnread(sessionId, "message");

      const db = getDb();
      const row = db.query(
        "SELECT session_id, unread_count, unread_type, last_known_title FROM session_metadata WHERE session_id = ?",
      ).get(sessionId) as { session_id: string; unread_count: number; unread_type: string | null; last_known_title: string | null } | null;

      expect(row).not.toBeNull();
      expect(row!.session_id).toBe(sessionId);
      expect(row!.unread_count).toBe(1);
      expect(row!.unread_type).toBe("message");
      expect(row!.last_known_title).toBeNull();
    });

    it("persists project_name on insert so unread stays clearable cross-device", () => {
      const sessionId = "test-session-proj";
      setSessionUnread(sessionId, "done", "Title", "my-project");

      const row = getDb().query(
        "SELECT project_name FROM session_metadata WHERE session_id = ?",
      ).get(sessionId) as { project_name: string | null };
      expect(row.project_name).toBe("my-project");

      const entry = getAllUnread().find((e) => e.sessionId === sessionId);
      expect(entry?.projectName).toBe("my-project");
    });

    it("preserves existing project_name on conflict (does not null it out)", () => {
      const sessionId = "test-session-proj2";
      setSessionUnread(sessionId, "done", "Title", "orig-project");
      // Re-mark without a project name — existing one must be kept
      setSessionUnread(sessionId, "done", "Title");

      const row = getDb().query(
        "SELECT project_name FROM session_metadata WHERE session_id = ?",
      ).get(sessionId) as { project_name: string | null };
      expect(row.project_name).toBe("orig-project");
    });

    it("idempotent: calling twice keeps unread_count=1", () => {
      const sessionId = "test-session-2";
      setSessionUnread(sessionId, "message");
      setSessionUnread(sessionId, "message");

      const db = getDb();
      const row = db.query("SELECT unread_count FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        unread_count: number;
      };
      expect(row.unread_count).toBe(1);
    });

    it("updates unread_count to 1 even if previously incremented", () => {
      const sessionId = "test-session-3";
      // First, set to create the row, then increment twice to get count=3
      setSessionUnread(sessionId, "message");
      incrementSessionUnread(sessionId, "message");
      incrementSessionUnread(sessionId, "message");

      const db = getDb();
      let row = db.query("SELECT unread_count FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        unread_count: number;
      };
      expect(row.unread_count).toBe(3);

      // Now setSessionUnread should set it back to 1
      setSessionUnread(sessionId, "message");
      row = db.query("SELECT unread_count FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        unread_count: number;
      };
      expect(row.unread_count).toBe(1);
    });

    it("accepts optional title parameter and stores it", () => {
      const sessionId = "test-session-4";
      const title = "My Important Chat";
      setSessionUnread(sessionId, "notification", title);

      const db = getDb();
      const row = db.query("SELECT last_known_title FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        last_known_title: string | null;
      };
      expect(row.last_known_title).toBe(title);
    });

    it("stores null for title when not provided", () => {
      const sessionId = "test-session-5";
      setSessionUnread(sessionId, "message");

      const db = getDb();
      const row = db.query("SELECT last_known_title FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        last_known_title: string | null;
      };
      expect(row.last_known_title).toBeNull();
    });

    it("updates unread_type to the new value", () => {
      const sessionId = "test-session-6";
      setSessionUnread(sessionId, "message");

      const db = getDb();
      let row = db.query("SELECT unread_type FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        unread_type: string | null;
      };
      expect(row.unread_type).toBe("message");

      // Change type
      setSessionUnread(sessionId, "notification");
      row = db.query("SELECT unread_type FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        unread_type: string | null;
      };
      expect(row.unread_type).toBe("notification");
    });

    it("preserves last_known_title if not overwriting with null", () => {
      const sessionId = "test-session-7";
      const title = "Original Title";
      setSessionUnread(sessionId, "message", title);

      const db = getDb();
      let row = db.query("SELECT last_known_title FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        last_known_title: string | null;
      };
      expect(row.last_known_title).toBe(title);

      // Call again without title param — should preserve
      setSessionUnread(sessionId, "notification");
      row = db.query("SELECT last_known_title FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        last_known_title: string | null;
      };
      expect(row.last_known_title).toBe(title);
    });
  });

  describe("clearSessionUnread", () => {
    it("resets unread_count to 0", () => {
      const sessionId = "test-session-clear-1";
      setSessionUnread(sessionId, "message");

      clearSessionUnread(sessionId);

      const db = getDb();
      const row = db.query("SELECT unread_count FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        unread_count: number;
      };
      expect(row.unread_count).toBe(0);
    });

    it("sets unread_type to NULL", () => {
      const sessionId = "test-session-clear-2";
      setSessionUnread(sessionId, "message");

      clearSessionUnread(sessionId);

      const db = getDb();
      const row = db.query("SELECT unread_type FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        unread_type: string | null;
      };
      expect(row.unread_type).toBeNull();
    });

    it("idempotent: clearing an already-clear session is safe", () => {
      const sessionId = "test-session-clear-3";
      clearSessionUnread(sessionId);
      clearSessionUnread(sessionId);

      const db = getDb();
      const row = db.query("SELECT unread_count FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        unread_count: number | null;
      } | null;

      // Row might not exist, or unread_count=0 if it was created by the first clear
      expect(row?.unread_count ?? 0).toBe(0);
    });

    it("preserves last_known_title after clear", () => {
      const sessionId = "test-session-clear-4";
      const title = "My Chat";
      setSessionUnread(sessionId, "message", title);

      clearSessionUnread(sessionId);

      const db = getDb();
      const row = db.query("SELECT last_known_title FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        last_known_title: string | null;
      };
      expect(row.last_known_title).toBe(title);
    });
  });

  describe("getAllUnread", () => {
    it("returns empty array when no unread sessions", () => {
      const unread = getAllUnread();
      expect(unread).toHaveLength(0);
    });

    it("returns sessions with unread_count > 0", () => {
      setSessionUnread("session-1", "message");
      setSessionUnread("session-2", "notification");
      setSessionUnread("session-3", "message");

      const unread = getAllUnread();
      expect(unread).toHaveLength(3);
    });

    it("excludes sessions with unread_count = 0", () => {
      setSessionUnread("session-1", "message");
      clearSessionUnread("session-1");
      setSessionUnread("session-2", "notification");

      const unread = getAllUnread();
      expect(unread).toHaveLength(1);
      expect(unread[0]!.sessionId).toBe("session-2");
    });

    it("includes correct unreadCount and unreadType", () => {
      setSessionUnread("session-unread-test", "custom_type");

      const unread = getAllUnread();
      const entry = unread.find((u) => u.sessionId === "session-unread-test");

      expect(entry).not.toBeNull();
      expect(entry!.unreadCount).toBe(1);
      expect(entry!.unreadType).toBe("custom_type");
    });

    it("includes sessionTitle from session_titles if available", () => {
      const sessionId = "session-with-title";
      setSessionUnread(sessionId, "message");
      setSessionTitle(sessionId, "User-Set Title");

      const unread = getAllUnread();
      const entry = unread.find((u) => u.sessionId === sessionId);

      expect(entry).not.toBeNull();
      expect(entry!.sessionTitle).toBe("User-Set Title");
    });

    it("falls back to last_known_title when no session_titles entry", () => {
      const sessionId = "session-no-title-record";
      const storedTitle = "Snapshot Title";
      setSessionUnread(sessionId, "message", storedTitle);

      const unread = getAllUnread();
      const entry = unread.find((u) => u.sessionId === sessionId);

      expect(entry).not.toBeNull();
      expect(entry!.sessionTitle).toBe(storedTitle);
    });

    it("prefers session_titles over last_known_title (COALESCE)", () => {
      const sessionId = "session-dual-title";
      const storedTitle = "Stored at Unread Time";
      const userTitle = "User-Set Title";

      setSessionUnread(sessionId, "message", storedTitle);
      setSessionTitle(sessionId, userTitle);

      const unread = getAllUnread();
      const entry = unread.find((u) => u.sessionId === sessionId);

      expect(entry).not.toBeNull();
      expect(entry!.sessionTitle).toBe(userTitle);
    });

    it("includes projectName when set", () => {
      const db = getDb();
      const sessionId = "session-with-project";

      // Set metadata with project name
      db.query(
        "INSERT INTO session_metadata (session_id, project_name, unread_count, unread_type) VALUES (?, ?, ?, ?)",
      ).run(sessionId, "my-project", 1, "message");

      const unread = getAllUnread();
      const entry = unread.find((u) => u.sessionId === sessionId);

      expect(entry).not.toBeNull();
      expect(entry!.projectName).toBe("my-project");
    });

    it("returns null for projectName when not set", () => {
      setSessionUnread("session-no-project", "message");

      const unread = getAllUnread();
      const entry = unread.find((u) => u.sessionId === "session-no-project");

      expect(entry).not.toBeNull();
      expect(entry!.projectName).toBeNull();
    });

    it("correctly handles multiple unread sessions with mixed data", () => {
      // Session 1: only unread
      setSessionUnread("s1", "message");

      // Session 2: unread + title
      setSessionUnread("s2", "notification", "Chat 2");

      // Session 3: unread + title + project
      const db = getDb();
      db.query(
        "INSERT INTO session_metadata (session_id, project_name, unread_count, unread_type, last_known_title) VALUES (?, ?, ?, ?, ?)",
      ).run("s3", "project-a", 1, "alert", "Chat 3");

      const unread = getAllUnread();
      expect(unread).toHaveLength(3);

      const s1 = unread.find((u) => u.sessionId === "s1");
      expect(s1!.sessionTitle).toBeNull();
      expect(s1!.projectName).toBeNull();

      const s2 = unread.find((u) => u.sessionId === "s2");
      expect(s2!.sessionTitle).toBe("Chat 2");
      expect(s2!.projectName).toBeNull();

      const s3 = unread.find((u) => u.sessionId === "s3");
      expect(s3!.sessionTitle).toBe("Chat 3");
      expect(s3!.projectName).toBe("project-a");
    });
  });

  describe("integration: setSessionUnread + clearSessionUnread + getAllUnread", () => {
    it("full workflow: mark, clear, verify", () => {
      const sessionId = "workflow-test-1";

      // Mark as unread
      setSessionUnread(sessionId, "message", "Important Chat");
      let unread = getAllUnread();
      expect(unread).toHaveLength(1);
      expect(unread[0]!.unreadCount).toBe(1);

      // Clear
      clearSessionUnread(sessionId);
      unread = getAllUnread();
      expect(unread).toHaveLength(0);
    });

    it("comparison: incrementSessionUnread vs setSessionUnread", () => {
      const session1 = "incremented";
      const session2 = "set";

      // Create row and increment multiple times
      setSessionUnread(session1, "message");
      incrementSessionUnread(session1, "message");
      incrementSessionUnread(session1, "message");

      // Set once
      setSessionUnread(session2, "message");

      let unread = getAllUnread();
      const s1 = unread.find((u) => u.sessionId === session1);
      const s2 = unread.find((u) => u.sessionId === session2);

      expect(s1!.unreadCount).toBe(3);
      expect(s2!.unreadCount).toBe(1);
    });

    it("setSessionUnread after incrementSessionUnread resets to 1", () => {
      const sessionId = "mixed-test";

      // Create row and increment twice to get count=3
      setSessionUnread(sessionId, "message");
      incrementSessionUnread(sessionId, "message");
      incrementSessionUnread(sessionId, "message");

      let unread = getAllUnread();
      expect(unread[0]!.unreadCount).toBe(3);

      // Now set to unread (should reset to 1)
      setSessionUnread(sessionId, "notification");

      unread = getAllUnread();
      expect(unread[0]!.unreadCount).toBe(1);
      expect(unread[0]!.unreadType).toBe("notification");
    });
  });

  describe("edge cases", () => {
    it("handles empty session ID gracefully", () => {
      setSessionUnread("", "message");

      const unread = getAllUnread();
      expect(unread.some((u) => u.sessionId === "")).toBe(true);
    });

    it("handles very long session IDs", () => {
      const longId = "a".repeat(255);
      setSessionUnread(longId, "message");

      const unread = getAllUnread();
      expect(unread[0]!.sessionId).toBe(longId);
    });

    it("handles special characters in type", () => {
      const sessionId = "special-type-test";
      const type = "alert/critical#urgent";
      setSessionUnread(sessionId, type);

      const unread = getAllUnread();
      expect(unread[0]!.unreadType).toBe(type);
    });

    it("handles special characters in title", () => {
      const sessionId = "special-title-test";
      const title = "Bug: 'Error' in \"quotes\" & ampersand";
      setSessionUnread(sessionId, "message", title);

      const unread = getAllUnread();
      expect(unread[0]!.sessionTitle).toBe(title);
    });

    it("handles NULL title explicitly passed", () => {
      const sessionId = "null-title-test";
      setSessionUnread(sessionId, "message", null);

      const db = getDb();
      const row = db.query("SELECT last_known_title FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        last_known_title: string | null;
      };
      expect(row.last_known_title).toBeNull();
    });

    it("handles title updates on subsequent setSessionUnread calls", () => {
      const sessionId = "title-update-test";

      setSessionUnread(sessionId, "message", "Title 1");
      const db = getDb();
      let row = db.query("SELECT last_known_title FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        last_known_title: string | null;
      };
      expect(row.last_known_title).toBe("Title 1");

      // Update title
      setSessionUnread(sessionId, "message", "Title 2");
      row = db.query("SELECT last_known_title FROM session_metadata WHERE session_id = ?").get(sessionId) as {
        last_known_title: string | null;
      };
      expect(row.last_known_title).toBe("Title 2");
    });
  });
});
