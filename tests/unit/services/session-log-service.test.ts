import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  openTestDb,
  setDb,
  closeDb,
  getSessionLogs,
} from "../../../src/services/db.service.ts";
import { logSessionEvent, getSessionLog } from "../../../src/services/session-log.service.ts";

describe("session-log.service (SQLite-backed)", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  afterEach(() => {
    setDb(openTestDb()); // keep db as in-memory, never null (closeDb → null → getDb opens prod DB)
  });

  describe("logSessionEvent()", () => {
    it("writes a log entry to SQLite", () => {
      logSessionEvent("sess-1", "INFO", "Chat started");
      const rows = getSessionLogs("sess-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.level).toBe("INFO");
      expect(rows[0]!.message).toBe("Chat started");
    });

    it("writes multiple entries for the same session", () => {
      logSessionEvent("sess-1", "INFO", "Started");
      logSessionEvent("sess-1", "WARN", "Slow response");
      logSessionEvent("sess-1", "ERROR", "Connection lost");
      expect(getSessionLogs("sess-1")).toHaveLength(3);
    });

    it("isolates logs across sessions", () => {
      logSessionEvent("sess-a", "INFO", "msg-a");
      logSessionEvent("sess-b", "INFO", "msg-b");
      expect(getSessionLogs("sess-a")).toHaveLength(1);
      expect(getSessionLogs("sess-b")).toHaveLength(1);
    });
  });

  describe("redaction", () => {
    it("redacts Bearer tokens", () => {
      logSessionEvent("s1", "INFO", "Authorization: Bearer sk-abc123xyz");
      const rows = getSessionLogs("s1");
      expect(rows[0]!.message).toContain("[REDACTED]");
      expect(rows[0]!.message).not.toContain("sk-abc123xyz");
    });

    it("redacts Token: values", () => {
      logSessionEvent("s1", "INFO", "Token: secret-token-value");
      const rows = getSessionLogs("s1");
      expect(rows[0]!.message).toContain("[REDACTED]");
      expect(rows[0]!.message).not.toContain("secret-token-value");
    });

    it("redacts ANTHROPIC_API_KEY env var", () => {
      logSessionEvent("s1", "INFO", "ANTHROPIC_API_KEY=sk-ant-xxxx");
      const rows = getSessionLogs("s1");
      expect(rows[0]!.message).toContain("[REDACTED]");
      expect(rows[0]!.message).not.toContain("sk-ant-xxxx");
    });

    it("redacts api_key values", () => {
      logSessionEvent("s1", "INFO", 'api_key: "my-secret-key"');
      const rows = getSessionLogs("s1");
      expect(rows[0]!.message).toContain("[REDACTED]");
      expect(rows[0]!.message).not.toContain("my-secret-key");
    });

    it("redacts password values", () => {
      logSessionEvent("s1", "INFO", "password: hunter2");
      const rows = getSessionLogs("s1");
      expect(rows[0]!.message).toContain("[REDACTED]");
      expect(rows[0]!.message).not.toContain("hunter2");
    });

    it("redacts secret values", () => {
      logSessionEvent("s1", "INFO", "secret: my-s3cret");
      const rows = getSessionLogs("s1");
      expect(rows[0]!.message).toContain("[REDACTED]");
      expect(rows[0]!.message).not.toContain("my-s3cret");
    });

    it("preserves non-sensitive content", () => {
      logSessionEvent("s1", "INFO", "Chat session started for project foo");
      const rows = getSessionLogs("s1");
      expect(rows[0]!.message).toBe("Chat session started for project foo");
    });
  });

  describe("getSessionLog()", () => {
    it("returns formatted log string in chronological order", () => {
      logSessionEvent("s1", "INFO", "first");
      logSessionEvent("s1", "WARN", "second");
      const log = getSessionLog("s1");
      const lines = log.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("[INFO] first");
      expect(lines[1]).toContain("[WARN] second");
    });

    it("returns empty string for unknown session", () => {
      expect(getSessionLog("nonexistent")).toBe("");
    });

    it("respects tailLines parameter", () => {
      for (let i = 0; i < 10; i++) {
        logSessionEvent("s1", "INFO", `line-${i}`);
      }
      const log = getSessionLog("s1", 3);
      const lines = log.split("\n");
      expect(lines).toHaveLength(3);
    });

    it("includes timestamp in each line", () => {
      logSessionEvent("s1", "INFO", "timestamped");
      const log = getSessionLog("s1");
      // Format: [YYYY-MM-DD HH:MM:SS] [LEVEL] message
      expect(log).toMatch(/\[\d{4}-\d{2}-\d{2}/);
    });
  });
});
