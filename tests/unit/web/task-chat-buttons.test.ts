/**
 * Which chat buttons a task view shows: Open chat for a chat the task was handed to, Ask manager
 * whenever the project has a manager chat, and never both when they would open the same chat.
 */
import { describe, expect, it } from "bun:test";
import { taskChatButtons, taskManagerChat } from "../../../src/web/lib/ppm-tasks/task-chat-buttons";
import type { TaskWorkingSession } from "../../../src/shared/ppm-tasks-api";

const session = (sessionId: string, providerId: string | null = "claude") => ({ sessionId, state: "idle" as const, title: null, providerId });
const managers = [
  { projectName: "ppm", sessionId: "mgr-ppm", providerId: "claude" },
  { projectName: "pex", sessionId: "mgr-pex", providerId: "codex" },
];
const task = (project: string, workingSession: TaskWorkingSession) => ({ project, workingSession });

describe("taskChatButtons", () => {
  it("a task handed to a child chat shows both: Open chat for the child, Ask manager for the manager", () => {
    expect(taskChatButtons(task("ppm", { kind: "session", session: session("child-1") }), managers)).toEqual({
      openChat: { sessionId: "child-1", providerId: "claude" },
      askManager: { sessionId: "mgr-ppm", providerId: "claude" },
    });
  });

  it("a task the manager works on (not handed off) shows Ask manager alone", () => {
    const b = taskChatButtons(task("ppm", { kind: "manager", label: "Manager", session: session("mgr-ppm") }), managers);
    expect(b.openChat).toBeNull();
    expect(b.askManager).toEqual({ sessionId: "mgr-ppm", providerId: "claude" });
  });

  it("a task handed to the manager chat by id is not handed off either: no Open chat beside Ask manager", () => {
    const b = taskChatButtons(task("ppm", { kind: "session", session: session("mgr-ppm") }), managers);
    expect(b.openChat).toBeNull();
    expect(b.askManager?.sessionId).toBe("mgr-ppm");
  });

  it("a project with no manager chat shows no Ask manager: Open chat when handed off, nothing otherwise", () => {
    expect(taskChatButtons(task("gamma", { kind: "session", session: session("child-9") }), managers)).toEqual({
      openChat: { sessionId: "child-9", providerId: "claude" }, askManager: null,
    });
    expect(taskChatButtons(task("gamma", { kind: "start_chat" }), managers)).toEqual({ openChat: null, askManager: null });
  });

  it("takes the manager's provider from the manager list", () => {
    expect(taskChatButtons(task("pex", { kind: "session", session: session("child-2") }), managers).askManager)
      .toEqual({ sessionId: "mgr-pex", providerId: "codex" });
  });
});

describe("taskManagerChat", () => {
  it("falls back to the task's own working session while the manager list has not loaded", () => {
    const t = task("ppm", { kind: "manager", label: "Manager", session: session("mgr-ppm", null) });
    expect(taskManagerChat(t, null)).toEqual({ sessionId: "mgr-ppm", providerId: null });
    expect(taskChatButtons(t, null)).toEqual({ openChat: null, askManager: { sessionId: "mgr-ppm", providerId: null } });
  });

  it("is null without a listed manager and with a child or no chat working on the task", () => {
    expect(taskManagerChat(task("ppm", { kind: "session", session: session("child-1") }), null)).toBeNull();
    expect(taskManagerChat(task("ppm", { kind: "start_chat" }), [])).toBeNull();
  });
});
