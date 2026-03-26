import { describe, test, expect } from "bun:test";
import { CursorCliProvider } from "../../src/providers/cursor-cli/cursor-provider.ts";

describe("CursorCliProvider", () => {
  test("has correct id and name", () => {
    const provider = new CursorCliProvider();
    expect(provider.id).toBe("cursor");
    expect(provider.name).toBe("Cursor");
  });

  test("isAvailable returns boolean", async () => {
    const provider = new CursorCliProvider();
    const result = await provider.isAvailable();
    expect(typeof result).toBe("boolean");
  });

  describe("buildArgs", () => {
    const provider = new CursorCliProvider();

    test("builds args for new session", () => {
      const args = provider.buildArgs({
        message: "hello world",
        model: "gpt-4",
        permissionMode: "default",
        isResume: false,
      });
      expect(args).toContain("-p");
      expect(args).toContain("hello world");
      expect(args).toContain("--model");
      expect(args).toContain("gpt-4");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).not.toContain("--resume=");
      expect(args).not.toContain("-f");
    });

    test("builds args for resume session", () => {
      const args = provider.buildArgs({
        sessionId: "abc-123",
        message: "continue",
        isResume: true,
      });
      expect(args).toContain("--resume=abc-123");
      expect(args).toContain("-p");
      expect(args).toContain("continue");
      // No --model on resume
      expect(args).not.toContain("--model");
    });

    test("adds -f for bypassPermissions mode", () => {
      const args = provider.buildArgs({
        message: "fix bug",
        permissionMode: "bypassPermissions",
        isResume: false,
      });
      expect(args).toContain("-f");
    });

    test("does not add -f for default mode", () => {
      const args = provider.buildArgs({
        message: "fix bug",
        permissionMode: "default",
        isResume: false,
      });
      expect(args).not.toContain("-f");
    });
  });

  describe("extractSessionId", () => {
    const provider = new CursorCliProvider();

    test("extracts session_id from system.init event", () => {
      const result = provider.extractSessionId({
        type: "system",
        subtype: "init",
        session_id: "cursor-session-xyz",
      });
      expect(result).toBe("cursor-session-xyz");
    });

    test("returns null for non-init events", () => {
      expect(provider.extractSessionId({ type: "assistant" })).toBeNull();
      expect(provider.extractSessionId({ type: "system", subtype: "done" })).toBeNull();
    });

    test("returns null for missing session_id", () => {
      const result = provider.extractSessionId({
        type: "system",
        subtype: "init",
      });
      expect(result).toBeNull();
    });
  });

  describe("session lifecycle", () => {
    test("creates and lists sessions", async () => {
      const provider = new CursorCliProvider();
      const session = await provider.createSession({ title: "Test" });
      expect(session.id).toBeTruthy();
      expect(session.providerId).toBe("cursor");
      expect(session.title).toBe("Test");

      const sessions = await provider.listSessions();
      expect(sessions.some((s) => s.id === session.id)).toBe(true);
    });

    test("resumes session", async () => {
      const provider = new CursorCliProvider();
      const session = await provider.createSession({ title: "Original" });
      const resumed = await provider.resumeSession(session.id);
      expect(resumed.id).toBe(session.id);
    });

    test("resumes non-existent session creates placeholder", async () => {
      const provider = new CursorCliProvider();
      const resumed = await provider.resumeSession("unknown-id");
      expect(resumed.id).toBe("unknown-id");
      expect(resumed.title).toBe("Resumed Chat");
    });

    test("deletes session", async () => {
      const provider = new CursorCliProvider();
      const session = await provider.createSession({ title: "Delete me" });
      await provider.deleteSession(session.id);
      const sessions = await provider.listSessions();
      expect(sessions.find((s) => s.id === session.id)).toBeUndefined();
    });
  });

  describe("abortQuery", () => {
    test("does not throw for non-existent session", () => {
      const provider = new CursorCliProvider();
      expect(() => provider.abortQuery("non-existent")).not.toThrow();
    });
  });
});
