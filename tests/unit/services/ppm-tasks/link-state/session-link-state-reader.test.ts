import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../../../test-setup.ts";
import { getDb, setSessionMigratedTo } from "../../../../../src/services/db.service.ts";
import type { ChatControl, LiveChatState } from "../../../../../src/services/chat-control/chat-control.ts";
import { createTask, updateTask } from "../../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { readSessionState, setSessionReaderEnv, workingSessionFor } from "../../../../../src/services/ppm-tasks/link-state/session-link-state-reader.ts";
import { chatOf, freshProject, PROJECT_PATH, USER, type Fixture } from "../ppm-tasks-fixture.ts";

let f: Fixture;
let states: Record<string, LiveChatState | null>;
let sent = 0;

const chat = (): ChatControl => ({
  sendUserMessage: async () => { sent++; return { ok: false, error: "no" }; },
  answerApproval: () => "stale",
  cancelTurn: () => false,
  liveState: (id) => states[id] ?? null,
  listLive: () => [],
});
const live = (o: Partial<LiveChatState>): LiveChatState => ({ phase: "streaming", running: true, projectName: "demo", providerId: "claude", queuedCards: 0, ...o });

beforeEach(() => {
  f = freshProject();
  states = {};
  sent = 0;
  setSessionReaderEnv({ chat });
});
afterEach(() => setSessionReaderEnv(null));

describe("readSessionState", () => {
  it("reads running, waiting on a card, idle and gone, and sends nothing", () => {
    chatOf("run-1");
    chatOf("card-1");
    chatOf("idle-1");
    states["run-1"] = live({ runningSince: 123 });
    states["card-1"] = live({ card: { requestId: "r", tool: "Bash", input: {}, isQuestion: false } });
    expect(readSessionState("run-1")).toMatchObject({ sessionId: "run-1", state: "running", runningSince: 123, check: null });
    expect(readSessionState("card-1").state).toBe("waiting_card");
    expect(readSessionState("idle-1").state).toBe("idle");
    expect(readSessionState("deleted-1").state).toBe("gone");
    expect(sent).toBe(0);
  });

  it("follows a migrated id", () => {
    chatOf("new-id");
    setSessionMigratedTo("old-id", "new-id");
    states["new-id"] = live({});
    expect(readSessionState("old-id")).toMatchObject({ sessionId: "new-id", state: "running" });
  });

  it("carries the last check of the task's handed-off chat", () => {
    const t = createTask({ projectKey: f.projectKey, title: "x" }, USER);
    const u = updateTask(t.id, { workingSessionId: chatOf("child-1") }, t.revision, USER);
    getDb().query(
      "INSERT INTO task_child_checks (task_id, session_id, state, checked_at, last_progress_at, alerts) VALUES (?, 'child-1', 'stalled', 500, 100, 1)",
    ).run(t.id);
    expect(readSessionState("child-1", u).check).toEqual({ state: "stalled", since: 100, lastProgressAt: 100 });
  });
});

describe("workingSessionFor", () => {
  it("is the working chat, else the manager labelled Manager, else start a chat", () => {
    const t = createTask({ projectKey: f.projectKey, title: "x" }, USER);
    expect(workingSessionFor(t)).toEqual({ kind: "start_chat" });
    getDb().query(
      "INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, ?, 'mgr-1', 'claude', 'user', 1)",
    ).run(f.projectKey, PROJECT_PATH);
    chatOf("mgr-1");
    expect(workingSessionFor(t)).toMatchObject({ kind: "manager", label: "Manager", session: { sessionId: "mgr-1", state: "idle" } });
    const u = updateTask(t.id, { workingSessionId: chatOf("child-1") }, t.revision, USER);
    expect(workingSessionFor(u)).toMatchObject({ kind: "session", session: { sessionId: "child-1" } });
  });
});
