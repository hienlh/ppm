/**
 * Manager chats: one per project and one project per chat, only a Claude chat of that same project
 * that is neither a design nor an Assistant session; replacing names the old chat; deleting a chat
 * unassigns it; the per-turn answer is cached and dropped on every change. Also the table itself:
 * created by migration 64, harmless to run twice.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import { basename, join } from "node:path";
import {
  applyDbPragmas, getDb, runMigrations, setSessionAssistant, setSessionDesignSlug, setSessionMetadata,
  setSessionMigratedTo, setSessionProvider, getSessionProjectPath, getSessionProvider,
} from "../../../src/services/db.service.ts";
import { createManagerChats, ManagerChatError } from "../../../src/services/assistant-managers/manager-chats.service.ts";
import { getManagerChatRow } from "../../../src/services/assistant-managers/manager-chats-db.ts";
import { projectKey } from "../../../src/services/project-name-for-path.ts";
import { MANAGER_CLAUDE_ONLY } from "../../../src/shared/assistant-managers.ts";

const home = process.env.PPM_HOME!;
const A = { name: "alpha", path: join(home, "mgr-alpha") };
const B = { name: "beta", path: join(home, "mgr-beta") };

let changes: string[][] = [];
let cliSessions = new Set<string>();
let projects = [A, B];
const managers = () => createManagerChats({
  projects: () => projects,
  findClaudeSession: async (id, path) => cliSessions.has(`${path}|${id}`),
  changed: (names) => changes.push(names),
  now: () => 1_000,
});

function chat(project: { name: string; path: string }, provider = "claude"): string {
  const id = `chat-${crypto.randomUUID()}`;
  setSessionMetadata(id, project.name, project.path);
  setSessionProvider(id, provider);
  return id;
}

beforeEach(() => {
  getDb().run("DELETE FROM manager_chats");
  changes = [];
  cliSessions = new Set();
  projects = [A, B];
});
afterEach(() => getDb().run("DELETE FROM manager_chats"));

describe("who may be a manager", () => {
  it("refuses Codex, a design chat, an Assistant session and another project's chat", async () => {
    const m = managers();
    await expect(m.assign(A.name, chat(A, "codex"))).rejects.toThrow(MANAGER_CLAUDE_ONLY);
    const design = chat(A);
    setSessionDesignSlug(design, "landing");
    await expect(m.assign(A.name, design)).rejects.toThrow("design chat");
    const assistant = chat(A);
    setSessionAssistant(assistant);
    await expect(m.assign(A.name, assistant)).rejects.toThrow("PPM Assistant session");
    await expect(m.assign(A.name, chat(B))).rejects.toThrow("another project");
    await expect(m.assign("nope", chat(A))).rejects.toBeInstanceOf(ManagerChatError);
    expect(m.list()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("accepts a CLI-started Claude chat found in the project's folder, and records it", async () => {
    const m = managers();
    const id = `cli-${crypto.randomUUID()}`;
    await expect(m.assign(A.name, id)).rejects.toThrow("No Claude chat");
    cliSessions.add(`${A.path}|${id}`);
    await m.assign(A.name, id);
    expect(getSessionProjectPath(id)).toBe(A.path);
    expect(getSessionProvider(id)).toBe("claude");
  });
});

describe("assigning", () => {
  it("keeps one per project, replaces and names the old chat, and announces the project", async () => {
    const m = managers();
    const first = chat(A);
    expect((await m.assign(A.name, first)).replaced).toBeNull();
    const second = chat(A);
    const { replaced, row } = await m.assign(A.name, second);
    expect(replaced).toBe(first);
    expect(row).toMatchObject({ sessionId: second, projectKey: projectKey(A.path), assignedBy: "user", assignedAt: 1_000 });
    expect(m.isManagerChat(first)).toBe(false);
    expect(m.isManagerChat(second)).toBe(true);
    expect(m.managerFor(A.path)?.sessionId).toBe(second);
    expect(changes).toEqual([[A.name], [A.name]]);
  });

  it("tells the assign dialog which chat it replaces, and writes nothing", async () => {
    const m = managers();
    const first = chat(A);
    await m.assign(A.name, first);
    const check = await m.checkAssign(A.name, chat(A));
    expect(check.replaces?.sessionId).toBe(first);
    expect((await m.checkAssign(A.name, first)).replaces).toBeNull();
    expect(m.managerFor(A.path)?.sessionId).toBe(first);
  });

  it("follows a session's later id", async () => {
    const m = managers();
    const draft = chat(A);
    await m.assign(A.name, draft);
    const renamed = `chat-${crypto.randomUUID()}`;
    setSessionMigratedTo(draft, renamed);
    const fresh = managers();
    expect(fresh.managerFor(A.path)?.sessionId).toBe(renamed);
    expect(fresh.isManagerChat(draft)).toBe(true);
  });
});

describe("removing", () => {
  it("unassigns without touching anything else, and a deleted chat stops being a manager", async () => {
    const m = managers();
    const id = chat(A);
    await m.assign(A.name, id);
    expect(m.unassign(A.name)).toBe(true);
    expect(m.unassign(A.name)).toBe(false);
    expect(getSessionProvider(id)).toBe("claude");
    await m.assign(A.name, id);
    changes = [];
    m.forgetSession(id);
    expect(m.isManagerChat(id)).toBe(false);
    expect(changes).toEqual([[A.name]]);
    m.forgetSession(id);
    expect(changes).toHaveLength(1);
  });

  it("patches the project's digest and Telegram detail, and an empty patch announces nothing", async () => {
    const m = managers();
    expect(m.patch(A.name, { digest: false })).toBe(false);
    await m.assign(A.name, chat(A));
    expect(m.patch(A.name, { digest: false, telegramDetail: "title" })).toBe(true);
    expect(getManagerChatRow(projectKey(A.path))).toMatchObject({ digest: false, telegramDetail: "title" });
    changes = [];
    expect(m.patch(A.name, {})).toBe(true);
    expect(changes).toEqual([]);
  });

  it("keeps the row of a project removed from PPM, listed by its folder, until it is unassigned", async () => {
    const m = managers();
    await m.assign(A.name, chat(A));
    projects = [B];
    const gone = basename(A.path);
    expect(m.list().map((r) => r.projectName)).toEqual([gone]);
    await expect(m.assign(gone, chat(A))).rejects.toThrow("No project");
    expect(m.patch(gone, { digest: false })).toBe(true);
    expect(m.unassign(gone)).toBe(true);
    expect(m.list()).toEqual([]);
  });
});

describe("the manager_chats table", () => {
  it("is created by the migrations, and running them again changes nothing", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    db.query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES ('k', 'p', 's', 'claude', 'user', 1)").run();
    db.exec("PRAGMA user_version = 63");
    runMigrations(db);
    expect(db.query("SELECT session_id, digest, telegram_detail FROM manager_chats").all())
      .toEqual([{ session_id: "s", digest: 1, telegram_detail: "full" }]);
    expect(() => db.query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES ('k2', 'p', 's', 'claude', 'user', 1)").run()).toThrow();
    db.close();
  });
});
