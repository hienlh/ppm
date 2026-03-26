import { describe, test, expect } from "bun:test";
import type { ChatEvent } from "../../src/types/chat.ts";
import { CliProvider } from "../../src/providers/cli-provider-base.ts";

/**
 * Concrete test subclass of CliProvider — avoids spawning real processes.
 * Exercises session management, abort, cleanup, and arg building.
 */
class TestCliProvider extends CliProvider {
  readonly id = "test-cli";
  readonly name = "Test CLI";
  readonly cliCommand = "echo";

  buildArgs(params: {
    sessionId?: string;
    message: string;
    model?: string;
    permissionMode?: string;
    isResume: boolean;
  }): string[] {
    const args: string[] = [];
    if (params.sessionId && params.isResume) args.push(`--resume=${params.sessionId}`);
    args.push("-p", params.message);
    if (params.model) args.push("--model", params.model);
    return args;
  }

  mapEvent(raw: unknown, _sessionId: string): ChatEvent[] {
    const obj = raw as Record<string, unknown>;
    if (obj?.type === "text") return [{ type: "text", content: String(obj.content ?? "") }];
    if (obj?.type === "system") return [{ type: "system", subtype: String(obj.subtype ?? "") }];
    return [];
  }

  extractSessionId(raw: unknown): string | null {
    const obj = raw as Record<string, unknown>;
    if (obj?.type === "system" && obj?.subtype === "init") {
      return (obj.session_id as string) || null;
    }
    return null;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  // Expose internals for testing
  get _sessions() { return this.sessions; }
  get _activeProcesses() { return this.activeProcesses; }
}

describe("CliProvider base class", () => {
  describe("session lifecycle", () => {
    test("createSession generates unique IDs", async () => {
      const provider = new TestCliProvider();
      const s1 = await provider.createSession({ title: "A" });
      const s2 = await provider.createSession({ title: "B" });
      expect(s1.id).not.toBe(s2.id);
      expect(s1.providerId).toBe("test-cli");
      expect(s2.providerId).toBe("test-cli");
    });

    test("createSession uses default title when not provided", async () => {
      const provider = new TestCliProvider();
      const session = await provider.createSession({});
      expect(session.title).toBe("New Chat");
    });

    test("createSession preserves projectPath and projectName", async () => {
      const provider = new TestCliProvider();
      const session = await provider.createSession({
        title: "Project Session",
        projectPath: "/my/project",
        projectName: "test-proj",
      });
      expect(session.projectPath).toBe("/my/project");
      expect(session.projectName).toBe("test-proj");
    });

    test("createSession sets valid ISO createdAt", async () => {
      const provider = new TestCliProvider();
      const session = await provider.createSession({});
      const date = new Date(session.createdAt);
      expect(date.getTime()).not.toBeNaN();
    });

    test("resumeSession returns existing session", async () => {
      const provider = new TestCliProvider();
      const created = await provider.createSession({ title: "Original" });
      const resumed = await provider.resumeSession(created.id);
      expect(resumed.id).toBe(created.id);
      expect(resumed.title).toBe("Original");
    });

    test("resumeSession creates placeholder for unknown ID", async () => {
      const provider = new TestCliProvider();
      const resumed = await provider.resumeSession("unknown-123");
      expect(resumed.id).toBe("unknown-123");
      expect(resumed.title).toBe("Resumed Chat");
      expect(resumed.providerId).toBe("test-cli");
    });

    test("listSessions returns all created sessions", async () => {
      const provider = new TestCliProvider();
      await provider.createSession({ title: "A" });
      await provider.createSession({ title: "B" });
      await provider.createSession({ title: "C" });

      const sessions = await provider.listSessions();
      expect(sessions.length).toBe(3);
      const titles = sessions.map((s) => s.title);
      expect(titles).toContain("A");
      expect(titles).toContain("B");
      expect(titles).toContain("C");
    });

    test("deleteSession removes session from listing", async () => {
      const provider = new TestCliProvider();
      const session = await provider.createSession({ title: "Delete me" });
      await provider.deleteSession(session.id);

      const sessions = await provider.listSessions();
      expect(sessions.find((s) => s.id === session.id)).toBeUndefined();
    });

    test("deleteSession is idempotent for non-existent IDs", async () => {
      const provider = new TestCliProvider();
      // Should not throw
      await provider.deleteSession("nonexistent");
    });
  });

  describe("abort", () => {
    test("abortQuery does not throw for non-existent session", () => {
      const provider = new TestCliProvider();
      expect(() => provider.abortQuery("nonexistent")).not.toThrow();
    });

    test("abortQuery removes session from active processes", async () => {
      const provider = new TestCliProvider();
      // Manually inject a fake process
      const fakeProc = {
        kill: () => {},
        on: () => fakeProc,
      } as any;
      provider._activeProcesses.set("test-session", fakeProc);

      provider.abortQuery("test-session");
      expect(provider._activeProcesses.has("test-session")).toBe(false);
    });
  });

  describe("cleanupAll", () => {
    test("clears all active processes", () => {
      const provider = new TestCliProvider();
      const fakeProc = { kill: () => {}, on: () => fakeProc } as any;
      provider._activeProcesses.set("s1", fakeProc);
      provider._activeProcesses.set("s2", fakeProc);

      provider.cleanupAll();
      expect(provider._activeProcesses.size).toBe(0);
    });
  });

  describe("buildArgs delegation", () => {
    test("subclass buildArgs is called correctly", () => {
      const provider = new TestCliProvider();
      const args = provider.buildArgs({
        message: "hello",
        isResume: false,
        model: "test-model",
      });
      expect(args).toContain("-p");
      expect(args).toContain("hello");
      expect(args).toContain("--model");
      expect(args).toContain("test-model");
    });

    test("resume includes session ID", () => {
      const provider = new TestCliProvider();
      const args = provider.buildArgs({
        sessionId: "session-abc",
        message: "continue",
        isResume: true,
      });
      expect(args).toContain("--resume=session-abc");
    });

    test("non-resume omits session ID", () => {
      const provider = new TestCliProvider();
      const args = provider.buildArgs({
        message: "new message",
        isResume: false,
      });
      expect(args.some((a) => a.includes("--resume"))).toBe(false);
    });
  });

  describe("mapEvent delegation", () => {
    test("maps text events via subclass", () => {
      const provider = new TestCliProvider();
      const events = provider.mapEvent({ type: "text", content: "hello" }, "s1");
      expect(events).toEqual([{ type: "text", content: "hello" }]);
    });

    test("maps system events via subclass", () => {
      const provider = new TestCliProvider();
      const events = provider.mapEvent({ type: "system", subtype: "init" }, "s1");
      expect(events).toEqual([{ type: "system", subtype: "init" }]);
    });

    test("returns empty for unknown events", () => {
      const provider = new TestCliProvider();
      const events = provider.mapEvent({ type: "unknown" }, "s1");
      expect(events).toEqual([]);
    });
  });

  describe("extractSessionId delegation", () => {
    test("extracts session_id from init event", () => {
      const provider = new TestCliProvider();
      const id = provider.extractSessionId({
        type: "system",
        subtype: "init",
        session_id: "real-id-123",
      });
      expect(id).toBe("real-id-123");
    });

    test("returns null for non-init events", () => {
      const provider = new TestCliProvider();
      expect(provider.extractSessionId({ type: "assistant" })).toBeNull();
    });

    test("returns null for missing session_id", () => {
      const provider = new TestCliProvider();
      expect(provider.extractSessionId({ type: "system", subtype: "init" })).toBeNull();
    });
  });

  describe("isAvailable", () => {
    test("returns boolean from subclass", async () => {
      const provider = new TestCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(true);
    });
  });
});
