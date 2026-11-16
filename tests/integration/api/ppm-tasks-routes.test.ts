/**
 * `/api/tasks` against the real app: CRUD and the "what to do first" list, stale writes (409 with
 * the current revision, nothing written), switched-off projects (404 `tasks_off`, settings still
 * reachable), settings all-or-nothing, undo of AI changes, Start chat on a scripted provider, a
 * decision sent by the server into the working chat with no browser socket anywhere, and "tell
 * the manager now".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../test-setup.ts";
import { app } from "../../../src/server/index.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getDb, getSessionTitle, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { projectKey as keyOf } from "../../../src/services/project-name-for-path.ts";
import { createTask, updateTask } from "../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { enableOnManagerAssigned, setTasksEnabled } from "../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { setPpmTasksDeliverEnv } from "../../../src/services/ppm-tasks/ppm-tasks-deliver.ts";
import { setStartChatProvider } from "../../../src/server/routes/ppm-tasks-actions.ts";
import type { WriteContext } from "../../../src/shared/ppm-tasks.ts";
import type {
  NotifyManagerResponse, TaskDecideResponse, TaskDetailResponse, TaskHistoryItem, TaskListResponse, TaskProjectSettings,
  TaskStartChatResponse, TaskWriteResponse,
} from "../../../src/shared/ppm-tasks-api.ts";
import { QueuedTurnsProvider, until } from "../../helpers/queued-turns-provider.ts";

const USER: WriteContext = { actor: { kind: "user", label: "You" }, via: "ppm" };
const MANAGER: WriteContext = { actor: { kind: "manager", sessionId: "mgr", label: "Manager demo" }, via: "tool" };

let root: string;
let otherRoot: string;
let key: string;
let savedProjects: unknown;
const provider = new QueuedTurnsProvider("ppm-tasks-scripted");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-tasks-routes-"));
  otherRoot = mkdtempSync(join(tmpdir(), "ppm-tasks-routes-other-"));
  savedProjects = configService.get("projects");
  providerRegistry.register(provider);
  setStartChatProvider(provider.id);
});

afterAll(async () => {
  setStartChatProvider(null);
  configService.set("projects", savedProjects as never);
  // On Windows the folder can stay locked for a moment after the last chat lets go of it.
  for (const dir of [root, otherRoot]) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 40) throw e;
        await Bun.sleep(100);
      }
    }
  }
});

beforeEach(() => {
  setDb(openTestDb());
  configService.set("projects", [{ name: "demo", path: root }, { name: "other", path: otherRoot }]);
  key = keyOf(root);
  setTasksEnabled(root, true, USER);
});

afterEach(() => setPpmTasksDeliverEnv(null));

type Envelope<T> = { ok: boolean; data?: T; error?: string; code?: string; revision?: number };

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: Envelope<T> }> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  // The collection is `/api/tasks` itself, as the web client calls it (no trailing slash).
  const url = `http://localhost/api/tasks${path.startsWith("/?") || path === "/" ? path.slice(1) : path}`;
  const res = await app.request(new Request(url, init));
  return { status: res.status, json: await res.json() as Envelope<T> };
}

/** Makes `sessionId` the project's manager chat, the way assigning one does. */
function assignManager(sessionId: string): void {
  getDb().query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, 'user', 1)")
    .run(key, root, sessionId, provider.id);
  enableOnManagerAssigned(key, root);
}

async function scriptedChat(): Promise<string> {
  return (await chatService.createSession(provider.id, { projectName: "demo", projectPath: root })).id;
}

describe("list and detail", () => {
  it("orders by effective urgency then importance, with per-project counts", async () => {
    createTask({ projectKey: key, title: "Later should", urgency: "later" }, USER);
    createTask({ projectKey: key, title: "Now nice", urgency: "now", importance: "nice" }, USER);
    createTask({ projectKey: key, title: "Now must", urgency: "now", importance: "must" }, USER);
    const { status, json } = await call<TaskListResponse>("GET", "/?project=demo");
    expect(status).toBe(200);
    expect(json.data!.tasks.map((t) => t.title)).toEqual(["Now must", "Now nice", "Later should"]);
    expect(json.data!.tasks[0]!.ref).toBe("demo/3");
    expect(json.data!.tasks[0]!.statusName).toBe("To do");
    expect(json.data!.tasks[0]!.workingSession).toEqual({ kind: "start_chat" });
    expect(json.data!.projects).toEqual([{ name: "demo", projectKey: key, enabled: true, hasManager: false, open: 3, now: 2 }]);
  });

  it("covers every switched-on registered project for all, and filters by type and text", async () => {
    setTasksEnabled(otherRoot, true, USER);
    createTask({ projectKey: key, title: "Pension rule", decision: { options: ["Monthly", "Weekly"] } }, USER);
    createTask({ projectKey: keyOf(otherRoot), title: "Other task" }, USER);
    const all = await call<TaskListResponse>("GET", "/?project=all");
    expect(all.json.data!.tasks.map((t) => t.project).sort()).toEqual(["demo", "other"]);
    expect(all.json.data!.projects.map((p) => p.name).sort()).toEqual(["demo", "other"]);
    const decisions = await call<TaskListResponse>("GET", "/?project=all&type=decision&q=pension");
    expect(decisions.json.data!.tasks.map((t) => t.title)).toEqual(["Pension rule"]);
  });

  it("returns a task with its children and link states; unknown ids are 404", async () => {
    const parent = createTask({ projectKey: key, title: "Parent", links: [{ kind: "jira", ref: "nx-1" }] }, USER);
    createTask({ projectKey: key, title: "Child", parentId: parent.id }, USER);
    const { json } = await call<TaskDetailResponse>("GET", `/${parent.id}`);
    expect(json.data!.task.links).toEqual([{ kind: "jira", ref: "NX-1", label: null }]);
    expect(json.data!.children.map((c) => c.title)).toEqual(["Child"]);
    expect(json.data!.linkStates.map((l) => [l.kind, l.ref])).toEqual([["jira", "NX-1"]]);
    const missing = await call("GET", `/${crypto.randomUUID()}`);
    expect([missing.status, missing.json.code]).toEqual([404, "not_found"]);
  });

  it("names the project's Jira site, from its Jira config, so a Jira key can open", async () => {
    const task = createTask({ projectKey: key, title: "Alpha", links: [{ kind: "jira", ref: "AL-7" }] }, USER);
    expect((await call<TaskDetailResponse>("GET", `/${task.id}`)).json.data!.jiraSite).toBeNull();
    const projectId = (getDb().query("SELECT id FROM projects WHERE path = ?").get(root) as { id: number }).id;
    getDb().query("INSERT INTO jira_config (project_id, base_url, email, api_token_encrypted) VALUES (?, ?, ?, ?)")
      .run(projectId, "https://alpha.atlassian.net/", "alpha@example.com", "not-a-real-token");
    expect((await call<TaskDetailResponse>("GET", `/${task.id}`)).json.data!.jiraSite).toBe("https://alpha.atlassian.net");
  });

  it("names an unknown project and a switched-off one", async () => {
    expect((await call("GET", "/?project=nope")).json.code).toBe("project_not_found");
    const off = await call("GET", "/?project=other");
    expect([off.status, off.json.code]).toEqual([404, "tasks_off"]);
  });
});

describe("writes", () => {
  it("creates, patches, and refuses a stale revision without writing anything", async () => {
    const created = await call<TaskWriteResponse>("POST", "/", { project: "demo", title: "Fix login", urgency: "today", tags: ["web"], projectKey: "ignored" });
    expect(created.status).toBe(200);
    const task = created.json.data!.task;
    expect([task.title, task.urgency, task.tags, task.projectKey]).toEqual(["Fix login", "today", ["web"], key]);
    expect(created.json.data!.managerPrompt).toBe(false);

    const patched = await call<TaskWriteResponse>("PATCH", `/${task.id}`, { revision: task.revision, title: "Fix the login", result: { text: "Merged" } });
    expect(patched.json.data!.task.title).toBe("Fix the login");
    expect(patched.json.data!.task.result).toMatchObject({ text: "Merged", by: "You" });

    const stale = await call("PATCH", `/${task.id}`, { revision: task.revision, title: "Lost" });
    expect([stale.status, stale.json.code, stale.json.revision]).toEqual([409, "stale", patched.json.data!.task.revision]);
    expect((await call<TaskDetailResponse>("GET", `/${task.id}`)).json.data!.task.title).toBe("Fix the login");

    // A refused decision in the same PATCH undoes the field change before it.
    const half = await call("PATCH", `/${task.id}`, { revision: patched.json.data!.task.revision, title: "Half", decision: { options: ["Only one"] } });
    expect(half.json.code).toBe("invalid");
    const kept = (await call<TaskDetailResponse>("GET", `/${task.id}`)).json.data!.task;
    expect([kept.title, kept.revision]).toEqual(["Fix the login", patched.json.data!.task.revision]);

    expect((await call("PATCH", `/${task.id}`, { title: "No revision" })).status).toBe(400);
    expect((await call("PATCH", `/${task.id}`, { revision: patched.json.data!.task.revision, urgency: "soon" })).json.code).toBe("invalid");
  });

  it("closes as dropped, reopens, and reorders inside a cell", async () => {
    const a = createTask({ projectKey: key, title: "A" }, USER);
    const b = createTask({ projectKey: key, title: "B" }, USER);
    const closed = await call<TaskWriteResponse>("POST", `/${a.id}/close`, { revision: a.revision, closedAs: "dropped" });
    expect([closed.json.data!.task.baseGroup, closed.json.data!.task.closedAs]).toEqual(["closed", "dropped"]);
    expect((await call<TaskListResponse>("GET", "/?project=demo")).json.data!.tasks.map((t) => t.title)).toEqual(["B"]);
    expect((await call<TaskListResponse>("GET", "/?project=demo&closed=1")).json.data!.tasks.map((t) => t.title).sort()).toEqual(["A", "B"]);
    const reopened = await call<TaskWriteResponse>("POST", `/${a.id}/reopen`, { revision: closed.json.data!.task.revision });
    expect(reopened.json.data!.task.baseGroup).toBe("not_started");
    await call("POST", `/${b.id}/reorder`, { revision: b.revision, beforeId: a.id });
    expect((await call<TaskListResponse>("GET", "/?project=demo")).json.data!.tasks.map((t) => t.title)).toEqual(["B", "A"]);
  });

  it("adds and removes links", async () => {
    const t = createTask({ projectKey: key, title: "Linked" }, USER);
    const added = await call<TaskWriteResponse>("POST", `/${t.id}/links`, { revision: t.revision, kind: "pr", ref: "https://github.com/acme/web/pull/412" });
    expect(added.json.data!.task.links).toEqual([{ kind: "pr", ref: "acme/web#412", label: null }]);
    const linkId = encodeURIComponent("pr:acme/web#412");
    const removed = await call<TaskWriteResponse>("DELETE", `/${t.id}/links/${linkId}?revision=${added.json.data!.task.revision}`);
    expect(removed.json.data!.task.links).toEqual([]);
    expect((await call("DELETE", `/${t.id}/links/${linkId}?revision=${removed.json.data!.task.revision}`)).status).toBe(404);
  });

  it("asks to tell the manager only when the project has one", async () => {
    assignManager(await scriptedChat());
    const created = await call<TaskWriteResponse>("POST", "/", { project: "demo", title: "With a manager" });
    expect(created.json.data!.managerPrompt).toBe(true);
    expect(created.json.data!.task.workingSession.kind).toBe("manager");
  });

  it("refuses writes in a switched-off project", async () => {
    const t = createTask({ projectKey: key, title: "Hidden" }, USER);
    setTasksEnabled(root, false, USER);
    expect((await call("POST", "/", { project: "demo", title: "x" })).json.code).toBe("tasks_off");
    expect((await call("POST", "/", { project: "other", title: "never on" })).json.code).toBe("tasks_off");
    expect((await call("PATCH", `/${t.id}`, { revision: t.revision, title: "y" })).json.code).toBe("tasks_off");
    expect((await call("GET", `/${t.id}`)).json.code).toBe("tasks_off");
  });
});

describe("history and undo", () => {
  it("lists history with what can be undone, undoes an AI change, refuses a user one", async () => {
    const t = createTask({ projectKey: key, title: "Undo me" }, USER);
    const changed = updateTask(t.id, { urgency: "now" }, t.revision, MANAGER);
    const history = await call<TaskHistoryItem[]>("GET", `/${t.id}/history`);
    const ai = history.json.data!.find((h) => h.actor.kind === "manager")!;
    const created = history.json.data!.find((h) => h.kind === "created")!;
    expect([ai.undoable, created.undoable]).toEqual([true, false]);
    expect((await call<TaskHistoryItem[]>("GET", `/${t.id}/history?filter=ai`)).json.data!.map((h) => h.id)).toEqual([ai.id]);

    const undone = await call<TaskWriteResponse>("POST", `/history/${ai.id}/undo`);
    expect(undone.json.data!.task.urgency).toBe(t.urgency);
    expect(undone.json.data!.task.revision).toBe(changed.revision + 1);
    const refused = await call("POST", `/history/${created.id}/undo`);
    expect([refused.status, refused.json.code]).toEqual([403, "forbidden"]);
  });
});

describe("settings", () => {
  it("reads and writes settings all or nothing, and is reachable while switched off", async () => {
    const before = await call<TaskProjectSettings>("GET", "/projects/demo/settings");
    expect(before.json.data!.statuses.map((s) => s.name)).toEqual(["To do", "In progress", "Waiting", "Done", "Dropped"]);
    expect(before.json.data!.project.checkIntervalMin).toBe(30);

    const saved = await call<TaskProjectSettings>("PUT", "/projects/demo/settings", {
      checkIntervalMin: 45,
      statuses: { add: [{ name: "Review", baseGroup: "waiting" }] },
      members: { add: [{ name: "Linh Tran", githubLogin: "linh" }] },
      fields: { upsert: [{ key: "sprint", label: "Sprint", type: "number" }] },
    });
    expect(saved.json.data!.project.checkIntervalMin).toBe(45);
    expect(saved.json.data!.statuses.map((s) => s.name)).toContain("Review");
    expect(saved.json.data!.members.map((m) => m.name)).toEqual(["Linh Tran"]);
    expect(saved.json.data!.fieldDefs.map((f) => f.key)).toEqual(["sprint"]);

    // A bad part is refused, and the status added before it in the same write is not kept.
    const refused = await call("PUT", "/projects/demo/settings", {
      statuses: { add: [{ name: "Blocked", baseGroup: "waiting" }] },
      fields: { upsert: [{ key: "bad key!", label: "Bad", type: "text" }] },
    });
    expect(refused.json.code).toBe("invalid");
    expect((await call("PUT", "/projects/demo/settings", { checkIntervalMin: 2 })).json.code).toBe("invalid");
    expect((await call<TaskProjectSettings>("GET", "/projects/demo/settings")).json.data!.statuses.map((s) => s.name)).not.toContain("Blocked");

    // Another project's status is not this project's to delete.
    const foreign = saved.json.data!.statuses[0]!.id;
    setTasksEnabled(otherRoot, true, USER);
    expect((await call("PUT", "/projects/other/settings", { statuses: { delete: [{ id: foreign }] } })).status).toBe(404);

    expect((await call<TaskProjectSettings>("PUT", "/projects/demo/settings", { enabled: false })).json.data!.project.enabled).toBe(false);
    expect((await call("PUT", "/projects/demo/settings", { checkIntervalMin: 60 })).json.code).toBe("tasks_off");
    expect((await call<TaskProjectSettings>("PUT", "/projects/demo/settings", { enabled: true })).json.data!.project.enabled).toBe(true);
  });

  it("lists every registered project with its switch", async () => {
    const { json } = await call<Array<{ name: string; enabled: boolean }>>("GET", "/projects");
    expect(json.data!.map((p) => [p.name, p.enabled])).toEqual([["demo", true], ["other", false]]);
  });
});

describe("decide, start chat, notify manager", () => {
  it("sends the choice from the server into the working chat, no browser open", async () => {
    const child = await scriptedChat();
    const t = createTask({ projectKey: key, title: "Pension", decision: { options: ["Monthly", "Weekly"] } }, USER);
    const handed = updateTask(t.id, { workingSessionId: child }, t.revision, USER);
    const { json } = await call<TaskDecideResponse>("POST", `/${t.id}/decide`, { revision: handed.revision, optionId: "b" });
    expect([json.data!.delivered, json.data!.sessionId]).toEqual(["started", child]);
    expect(json.data!.task.decision!.chosen).toMatchObject({ optionId: "b", by: "You" });
    await until(() => provider.queries.some((q) => q.sessionId === child), "the decision turn");
    expect(provider.queries.find((q) => q.sessionId === child)!.message).toContain('Decision on demo/1 "Pension": B — Weekly');
    provider.abortQuery(child);
  });

  it("refuses a decision with no chat to send it to, recording nothing", async () => {
    const t = createTask({ projectKey: key, title: "Nobody", decision: { options: ["Yes", "No"] } }, USER);
    const { status, json } = await call("POST", `/${t.id}/decide`, { revision: t.revision, optionId: "a" });
    expect([status, json.code]).toEqual([409, "no_session"]);
    expect((await call<TaskDetailResponse>("GET", `/${t.id}`)).json.data!.task.decision!.chosen).toBeNull();

    // A manager chat PPM no longer knows is no chat either.
    assignManager("deleted-manager-chat");
    const gone = await call("POST", `/${t.id}/decide`, { revision: t.revision, optionId: "a" });
    expect([gone.status, gone.json.code]).toEqual([409, "no_session"]);
    expect((await call<TaskDetailResponse>("GET", `/${t.id}`)).json.data!.task.decision!.chosen).toBeNull();
  });

  it("starts a chat titled after the task and makes it the working session", async () => {
    const t = createTask({ projectKey: key, title: "Write the release notes" }, USER);
    const { json } = await call<TaskStartChatResponse>("POST", `/${t.id}/start-chat`, { revision: t.revision });
    const sessionId = json.data!.sessionId;
    expect(provider.sessions.get(sessionId)?.title).toBe("Write the release notes");
    expect(json.data!.task.workingSessionId).toBe(sessionId);
    expect(json.data!.task.workingSession).toMatchObject({ kind: "session", session: { sessionId } });
    // PPM's own record, which the working-session chip reads, carries the task's title at once.
    expect(getSessionTitle(sessionId)).toBe("Write the release notes");
    const stale = await call("POST", `/${t.id}/start-chat`, { revision: t.revision });
    expect(stale.json.code).toBe("stale");
    expect(provider.sessions.size).toBeGreaterThan(0);
  });

  it("tells the manager now, or says why not", async () => {
    expect((await call<NotifyManagerResponse>("POST", "/notify-manager", { project: "demo" })).json.data).toEqual({ sent: false, reason: "no_manager" });
    const manager = await scriptedChat();
    assignManager(manager);
    expect((await call<NotifyManagerResponse>("POST", "/notify-manager", { project: "demo" })).json.data).toEqual({ sent: false, reason: "nothing_pending" });

    createTask({ projectKey: key, title: "News for the manager" }, USER);
    setPpmTasksDeliverEnv({ reserveWake: () => ({ ok: false, message: "limit reached" }) });
    expect((await call<NotifyManagerResponse>("POST", "/notify-manager", { project: "demo" })).json.data).toEqual({ sent: false, reason: "budget", error: "limit reached" });
    setPpmTasksDeliverEnv(null);

    const sent = await call<NotifyManagerResponse>("POST", "/notify-manager", { project: "demo" });
    expect(sent.json.data).toEqual({ sent: true, sessionId: manager });
    await until(() => provider.queries.some((q) => q.sessionId === manager), "the wake turn");
    expect(provider.queries.find((q) => q.sessionId === manager)!.message).toContain("News for the manager");
    provider.abortQuery(manager);
  });
});
