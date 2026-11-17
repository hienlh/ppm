/**
 * What the chat doing a task may do with the `ppm_task_*` tools, against what the manager chat
 * and the Assistant may: the working chat records its result, next step, notes and links, names
 * whom it waits on and moves the status between In progress and Waiting — nothing that would
 * switch off the manager's checks. It cannot close the task; it proposes closing, which the manager
 * hears as PPM Tasks news. A chat that does not work on the task gets the same ceiling, so there is
 * no side door. Every change is signed and undoable as before.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import type { ChatControl, SendUserMessageOpts } from "../../../../src/services/chat-control/chat-control.ts";
import type { CollabCaller } from "../../../../src/services/session-collab/collab-context.ts";
import { createTask, getTask } from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { taskHistory, undoRefusal } from "../../../../src/services/ppm-tasks/ppm-tasks-history.ts";
import { addMember } from "../../../../src/services/ppm-tasks/ppm-tasks-project-config.ts";
import { enableOnManagerAssigned, getTaskProject } from "../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { setPpmTasksDeliverEnv, wakeManager } from "../../../../src/services/ppm-tasks/ppm-tasks-deliver.ts";
import { ppmTaskNewsEntry } from "../../../../src/services/ppm-tasks/ppm-task-manager-news.ts";
import { callPpmTaskTool, createTaskWriteLimiter, type PpmTaskToolsEnv } from "../../../../src/services/ppm-tasks/tools/ppm-task-tools.ts";
import { noteUnattendedChange } from "../../../../src/services/ppm-tasks/ppm-task-unattended-card.ts";
import { chatOf, freshProject, MANAGER, PROJECT_PATH, USER, type Fixture } from "./ppm-tasks-fixture.ts";

const PROJECTS = [{ name: "demo", path: PROJECT_PATH }];

let f: Fixture;
let env: PpmTaskToolsEnv;
let managers: Set<string>;
let sent: Array<{ sessionId: string; text: string; opts: SendUserMessageOpts }>;

const caller = (id: string, kind: CollabCaller["kind"] = "session"): CollabCaller => ({
  sessionId: id, providerId: "claude", projectName: kind === "assistant" ? "__assistant__" : "demo", projectPath: kind === "assistant" ? "" : PROJECT_PATH,
  title: `Title of ${id}`, kind, unattended: false,
});
const CHILD = caller("child-1");
const UNRELATED = caller("other-1");
const MANAGER_CHAT = caller("mgr-1");
const ASSISTANT_CHAT = caller("asst-1", "assistant");

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = async (who: CollabCaller, name: string, args: Record<string, unknown> = {}) => await callPpmTaskTool(env, who, name, args) as Result;
const text = (r: Result) => r.content[0]!.text;

const fakeChat = (): ChatControl => ({
  sendUserMessage: async (sessionId, t, opts) => { sent.push({ sessionId, text: t, opts }); return { ok: true, sessionId, delivered: "started" }; },
  answerApproval: () => "stale",
  cancelTurn: () => false,
  liveState: () => null,
  listLive: () => [],
});

function addManager(): void {
  getDb().query(
    "INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, ?, 'mgr-1', 'claude', 'user', 1)",
  ).run(f.projectKey, PROJECT_PATH);
  enableOnManagerAssigned(f.projectKey, PROJECT_PATH);
  managers.add("mgr-1");
}

/** A task the manager handed to `child-1`, In progress, due in a week, with an assignee. */
function handedTask(title = "Fix login") {
  addMember(f.projectKey, { name: "Alice" }, USER);
  const alice = (getDb().query("SELECT id FROM task_members WHERE name = 'Alice'").get() as { id: string }).id;
  const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  return createTask({
    projectKey: f.projectKey, title, statusId: f.status("In progress").id, urgency: "week", importance: "should",
    dueDate: due, assigneeMemberId: alice, workingSessionId: chatOf("child-1"),
  }, MANAGER);
}

const rev = (id: string) => getTask(id)!.revision;

beforeEach(() => {
  f = freshProject();
  chatOf("other-1");
  chatOf("child-1");
  managers = new Set();
  sent = [];
  setPpmTasksDeliverEnv({ chat: fakeChat, reserveWake: () => ({ ok: true, release: () => {} }) });
  env = {
    now: () => Date.now(),
    limiter: createTaskWriteLimiter(),
    projects: () => PROJECTS,
    isManagerChat: (id) => managers.has(id),
    turnChannel: async () => null,
    wakeManager: (key, actor) => wakeManager(key, actor),
    tellManagerOfProposal: (key, actor) => wakeManager(key, actor, [], { unattended: true }),
    noteUnattended: noteUnattendedChange,
  };
});
afterEach(() => setPpmTasksDeliverEnv(null));

describe("the chat doing the task", () => {
  it("records result, next step, notes and links, names whom it waits on, and moves between In progress and Waiting", async () => {
    addManager();
    const t = handedTask();
    const r = await call(CHILD, "ppm_task_update", {
      task: "#1", revision: rev(t.id), reason: "PR open", result: "Fixed in PR 7", next_step: "Wait for review", notes: "Root cause: cookie path",
      add_links: [{ kind: "pr", ref: "https://github.com/acme/app/pull/7" }, { kind: "jira", ref: "NX-12" }],
      status: "Waiting", waiting_on: "Alice",
    });
    expect(r.isError).toBeFalsy();
    const now = getTask(t.id)!;
    expect(now.baseGroup).toBe("waiting");
    expect(now.result?.text).toBe("Fixed in PR 7");
    expect(now.links.map((l) => l.ref)).toEqual(["acme/app#7", "NX-12"]);
    const back = await call(CHILD, "ppm_task_update", { task: "#1", revision: now.revision, reason: "review in", status: "In progress", waiting_on: null, remove_links: ["NX-12"] });
    expect(back.isError).toBeFalsy();
    expect(getTask(t.id)!.baseGroup).toBe("active");
    // Signed with the chat's title, and the manager can still undo it.
    const [last] = taskHistory(t.id);
    expect(last!.actor).toMatchObject({ kind: "chat", sessionId: "child-1", label: "Title of child-1" });
    expect(undoRefusal(last!, Date.now())).toBeNull();
    expect((await call(MANAGER_CHAT, "ppm_task_undo", { history_id: last!.id, reason: "not yet" })).isError).toBeFalsy();
  });

  it("is refused closing, with the manager and propose_close named, and the task stays as it was", async () => {
    addManager();
    const t = handedTask();
    const closed = await call(CHILD, "ppm_task_close", { task: "#1", revision: rev(t.id), reason: "done", as: "done" });
    expect(closed.isError).toBe(true);
    expect(text(closed)).toContain("cannot close demo/1");
    expect(text(closed)).toContain("propose_close");
    expect(text(closed)).toContain("manager chat");
    const viaStatus = await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "done", status: "Done" });
    expect(viaStatus.isError).toBe(true);
    expect(text(viaStatus)).toContain("to a closed status");
    expect(text(viaStatus)).toContain("propose_close");
    expect(getTask(t.id)!.baseGroup).toBe("active");
    expect(getTask(t.id)!.revision).toBe(t.revision);
  });

  it("may not change urgency, importance, due date, assignee, snooze or working chat; the refusal names them and the manager", async () => {
    addManager();
    const t = handedTask();
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ urgency: "later" }, "urgency"], [{ importance: "nice" }, "importance"], [{ due_date: null }, "due_date"],
      [{ assignee: null }, "assignee"], [{ working_session: "other-1" }, "working_session"], [{ working_session: null }, "working_session"],
      [{ snoozed_until: day }, "snoozed_until"], [{ title: "Renamed" }, "title"],
    ];
    for (const [fields, name] of cases) {
      const r = await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "try", ...fields });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`may not change ${name}`);
      expect(text(r)).toContain("Ask the project's manager chat");
    }
    // Sending a field back as it already is changes nothing and is not refused.
    const same = await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "note", urgency: "week", notes: "still on it" });
    expect(same.isError).toBeFalsy();
    const after = getTask(t.id)!;
    expect([after.urgency, after.importance, after.workingSessionId, after.snoozedUntil]).toEqual(["week", "should", "child-1", null]);
  });

  it("starts its task (To do to In progress) but moves it nowhere else from To do", async () => {
    addManager();
    const todo = createTask({ projectKey: f.projectKey, title: "Later", workingSessionId: chatOf("child-1") }, MANAGER);
    const toWaiting = await call(CHILD, "ppm_task_update", { task: "#1", revision: todo.revision, reason: "blocked", status: "Waiting" });
    expect(text(toWaiting)).toContain("from the Not started group to the Waiting group");
    expect(text(await call(CHILD, "ppm_task_update", { task: "#1", revision: todo.revision, reason: "done", status: "Done" }))).toContain("to a closed status");
    const start = await call(CHILD, "ppm_task_update", { task: "#1", revision: todo.revision, reason: "starting now", status: "In progress" });
    expect(start.isError).toBeFalsy();
    expect(getTask(todo.id)!.baseGroup).toBe("active");
    expect(taskHistory(todo.id)[0]).toMatchObject({ kind: "status", actor: { kind: "chat", sessionId: "child-1" }, reason: "starting now" });
    // Started, it cannot go back to To do.
    expect(text(await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(todo.id), reason: "later", status: "To do" }))).toContain("from the In progress group to the Not started group");
  });

  it("may not reorder, change the project's set-up or undo the manager's change", async () => {
    addManager();
    const t = handedTask();
    const todo = createTask({ projectKey: f.projectKey, title: "Later", workingSessionId: "child-1" }, MANAGER);
    expect(text(await call(CHILD, "ppm_task_reorder", { task: "#2", revision: todo.revision, reason: "first", before: "#1" }))).toContain("may not reorder");
    const interval = await call(CHILD, "ppm_task_project_update", { check_interval_min: 240, reason: "fewer checks" });
    expect(interval.isError).toBe(true);
    expect(text(interval)).toContain("how often handed-off work is checked");
    expect(getTaskProject(f.projectKey)!.checkIntervalMin).toBe(30);
    const managerRow = taskHistory(t.id)[0]!;
    expect(text(await call(CHILD, "ppm_task_undo", { history_id: managerRow.id }))).toContain("only its own changes");
    // Its own change it may undo.
    await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "note", notes: "x" });
    const own = taskHistory(t.id)[0]!;
    expect((await call(CHILD, "ppm_task_undo", { history_id: own.id, reason: "wrong task" })).isError).toBeFalsy();
    expect(getTask(t.id)!.notes).toBeNull();
  });

  it("may create a task for itself, but not hand one to another chat", async () => {
    addManager();
    expect((await call(CHILD, "ppm_task_create", { title: "Follow-up", working_session: "self" })).isError).toBeFalsy();
    const handed = await call(CHILD, "ppm_task_create", { title: "For you", working_session: "other-1" });
    expect(handed.isError).toBe(true);
    expect(text(handed)).toContain("may not hand a task to another chat");
  });
});

describe("proposing to close", () => {
  it("records the proposal without closing, tells the manager at once, and the manager closes it", async () => {
    addManager();
    const t = handedTask();
    const r = await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "tests pass, PR merged", result: "Merged in PR 7", propose_close: "done" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Proposed closing demo/1 "Fix login" as done');
    expect(text(r)).toContain("manager chat was told now");
    const now = getTask(t.id)!;
    expect(now.baseGroup).toBe("active");
    expect(now.result?.text).toBe("Merged in PR 7");
    const [proposal, result] = taskHistory(t.id);
    expect(proposal).toMatchObject({ kind: "close_proposed", reason: "tests pass, PR merged", actor: { kind: "chat", sessionId: "child-1" } });
    expect(proposal!.changes).toEqual([{ field: "closeProposal", before: null, after: "done" }]);
    expect(result!.kind).toBe("result");
    expect(undoRefusal(proposal!, Date.now())).toContain("nothing to undo");
    // One quiet wake of the manager carrying the news.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).toBe("mgr-1");
    expect(sent[0]!.opts.origin).toBe("watch");
    expect(sent[0]!.text).toContain('demo/1 "Fix login": closing it as done proposed (not closed: you decide) by Title of child-1 — tests pass, PR merged');
    // The manager closes it.
    expect((await call(MANAGER_CHAT, "ppm_task_close", { task: "#1", revision: now.revision, reason: "checked", as: "done" })).isError).toBeFalsy();
    expect(getTask(t.id)!.baseGroup).toBe("closed");
  });

  it("reaches a manager that was not woken through its next turn's news", async () => {
    addManager();
    const t = handedTask();
    setPpmTasksDeliverEnv({ chat: fakeChat, reserveWake: () => ({ ok: false, message: "the manager send budget is spent" }) });
    const r = await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "obsolete", propose_close: "dropped" });
    expect(text(r)).toContain("reads it at its next turn");
    expect(sent).toHaveLength(0);
    const news = ppmTaskNewsEntry("mgr-1", true)!;
    expect(news.text).toContain("closing it as dropped proposed");
  });

  it("is refused to the manager and the Assistant, who close it themselves, and on a closed task", async () => {
    addManager();
    const t = handedTask();
    const own = await call(MANAGER_CHAT, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "x", propose_close: "done" });
    expect(text(own)).toContain("you close it yourself with ppm_task_close");
    const asst = await call(ASSISTANT_CHAT, "ppm_task_update", { project: "demo", task: "#1", revision: rev(t.id), reason: "x", propose_close: "done" });
    expect(asst.isError).toBe(true);
    await call(MANAGER_CHAT, "ppm_task_close", { task: "#1", revision: rev(t.id), reason: "done" });
    const late = await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "done", propose_close: "done" });
    expect(late.isError).toBe(true);
  });

  it("in a project with no manager chat it is recorded and the chat is told to ask the user", async () => {
    const t = handedTask();
    const r = await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "done", propose_close: "done" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("no manager chat: tell the user");
    expect(taskHistory(t.id)[0]!.kind).toBe("close_proposed");
    const closed = await call(CHILD, "ppm_task_close", { task: "#1", revision: rev(t.id), reason: "done" });
    expect(text(closed)).toContain("tell the user, who closes it in PPM");
  });
});

describe("other callers", () => {
  it("a chat that does not work on the task may only read it, and may still create tasks", async () => {
    addManager();
    const t = handedTask();
    const managers = createTask({ projectKey: f.projectKey, title: "The manager's own" }, MANAGER);
    for (const [name, args] of [
      ["ppm_task_update", { task: "#1", revision: rev(t.id), reason: "seen in logs", notes: "Also on staging" }],
      ["ppm_task_update", { task: "#1", revision: rev(t.id), reason: "done", propose_close: "done" }],
      ["ppm_task_update", { task: "#2", revision: managers.revision, reason: "note", notes: "x" }],
      ["ppm_task_close", { task: "#1", revision: rev(t.id), reason: "done" }],
    ] as const) {
      const r = await call(UNRELATED, name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("This chat may only read demo/");
      expect(text(r)).toContain("Ask the project's manager chat");
    }
    expect(text(await call(UNRELATED, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "x", notes: "y" }))).toContain("another chat works on it");
    expect(text(await call(UNRELATED, "ppm_task_update", { task: "#2", revision: managers.revision, reason: "x", notes: "y" }))).toContain("the manager chat does it");
    // The child's own change is not the other chat's to undo either.
    await call(CHILD, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "note", notes: "child note" });
    const childRow = taskHistory(t.id)[0]!;
    expect(text(await call(UNRELATED, "ppm_task_undo", { history_id: childRow.id }))).toContain("may only read");
    expect(getTask(t.id)!.notes).toBe("child note");
    expect(taskHistory(t.id).filter((h) => h.actor.sessionId === "other-1")).toHaveLength(0);
    // Reading and creating still work.
    expect((await call(UNRELATED, "ppm_task_get", { task: "#1" })).isError).toBeFalsy();
    expect((await call(UNRELATED, "ppm_task_list")).isError).toBeFalsy();
    expect((await call(UNRELATED, "ppm_task_create", { title: "Found while reading logs" })).isError).toBeFalsy();
  });

  it("the manager chat and the Assistant are not limited", async () => {
    addManager();
    const t = handedTask();
    const m = await call(MANAGER_CHAT, "ppm_task_update", { task: "#1", revision: rev(t.id), reason: "slip", urgency: "now", due_date: null, working_session: "other-1", status: "To do" });
    expect(m.isError).toBeFalsy();
    const a = await call(ASSISTANT_CHAT, "ppm_task_update", { project: "demo", task: "#1", revision: rev(t.id), reason: "user asked", importance: "must", snoozed_until: null });
    expect(a.isError).toBeFalsy();
    expect((await call(ASSISTANT_CHAT, "ppm_task_close", { project: "demo", task: "#1", revision: rev(t.id), reason: "user asked" })).isError).toBeFalsy();
    expect(getTask(t.id)!.baseGroup).toBe("closed");
  });
});
