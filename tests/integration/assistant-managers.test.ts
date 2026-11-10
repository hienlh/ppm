/**
 * Manager chats and the main session through the real routes, in one process with PPM's database,
 * a scratch project and a scripted Claude: assigning puts the chat first on page 1 of the session
 * list with `manager: true` even when its activity would put it on a later page; the managers
 * list names it; deleting the chat removes the row; a manager assigned under an id that a
 * provider later replaced is found under the new one as soon as the chat lifecycle says it moved;
 * changing the main session moves the Telegram
 * chat that followed the old one and leaves a chat on a one-off session alone.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { chatRoutes } from "../../src/server/routes/chat.ts";
import { assistantSettingsRoutes } from "../../src/server/routes/assistant-settings.ts";
import { configService } from "../../src/services/config.service.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import {
  setSessionAssistant, setSessionMetadata, setSessionMigratedTo, setSessionProvider, upsertApprovedPairing,
} from "../../src/services/db.service.ts";
import { getTelegramBinding, setTelegramBinding } from "../../src/services/assistant-hub/assistant-hub-db.ts";
import { chatLifecycle } from "../../src/services/chat-control/chat-lifecycle.ts";
import type { AIProvider } from "../../src/providers/provider.interface.ts";
import type { SessionInfo } from "../../src/types/chat.ts";
import type { PpmConfig } from "../../src/types/config.ts";

const home = process.env.PPM_HOME!;
const project = { name: "mgr-int", path: join(home, "mgr-int") };
const listed: SessionInfo[] = [];

const claude = {
  id: "claude", name: "Scripted Claude", supportsAssistantSessions: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: "claude", title: "", createdAt: new Date().toISOString() }; },
  async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return listed; },
  async listSessionsByDir(_dir: string, opts?: { limit?: number; offset?: number }) {
    const from = opts?.offset ?? 0;
    return listed.slice(from, from + (opts?.limit ?? listed.length));
  },
  async getSessionInfoById(id: string) { return listed.find((s) => s.id === id) ?? null; },
  async deleteSession(id: string) {
    const at = listed.findIndex((s) => s.id === id);
    if (at >= 0) listed.splice(at, 1);
  },
  async *sendMessage() {},
};

const app = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
app.use("/api/project/:p/*", async (c, next) => {
  c.set("projectPath", project.path);
  c.set("projectName", project.name);
  await next();
});
app.route("/api/project/:p/chat", chatRoutes);
app.route("/api/assistant", assistantSettingsRoutes);

let original: AIProvider | undefined;
let projectsBefore: PpmConfig["projects"] = [];
const assistantBefore = configService.get("assistant");

function chat(minutesAgo: number): string {
  const id = crypto.randomUUID();
  setSessionMetadata(id, project.name, project.path);
  setSessionProvider(id, "claude");
  const at = new Date(Date.UTC(2026, 10, 10, 12, 0) - minutesAgo * 60_000).toISOString();
  listed.push({ id, providerId: "claude", title: `chat ${minutesAgo}`, createdAt: at, updatedAt: at });
  listed.sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!));
  return id;
}

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() as { ok: boolean; data?: any; error?: string } };
};

beforeAll(() => {
  mkdirSync(project.path, { recursive: true });
  original = providerRegistry.get("claude");
  providerRegistry.register(claude as never);
  projectsBefore = configService.get("projects");
  (configService as any).config.projects = [...projectsBefore, project];
});
afterAll(() => {
  managerChats.unassign(project.name);
  (configService as any).config.projects = projectsBefore;
  configService.set("assistant", assistantBefore);
  if (original) providerRegistry.register(original);
});

describe("a manager chat in the session list", () => {
  it("is first on page 1 with the flag, and listed by the managers route", async () => {
    const old = chat(600);
    for (let i = 0; i < 4; i++) chat(i);
    const assigned = await call("PUT", `/api/assistant/managers/${project.name}`, { sessionId: old });
    expect(assigned).toMatchObject({ status: 200, json: { ok: true, data: { sessionId: old, replaced: null } } });

    const page = await call("GET", `/api/project/x/chat/sessions?limit=2`);
    expect(page.json.data.sessions[0]).toMatchObject({ id: old, manager: true });
    expect(page.json.data.sessions.filter((s: SessionInfo) => s.manager)).toHaveLength(1);
    // Only page 1 carries it out of place.
    const laterPage = await call("GET", `/api/project/x/chat/sessions?limit=2&offset=2`);
    expect(laterPage.json.data.sessions.some((s: SessionInfo) => s.id === old)).toBe(false);

    const managers = await call("GET", "/api/assistant/managers");
    expect(managers.json.data.managers).toEqual([expect.objectContaining({
      projectName: project.name, sessionId: old, providerId: "claude", phase: "idle", digest: true, telegramDetail: "full",
    })]);
  });

  it("refuses a Codex chat with the reason, and a missing project with 404", async () => {
    const codex = crypto.randomUUID();
    setSessionMetadata(codex, project.name, project.path);
    setSessionProvider(codex, "codex");
    const refused = await call("PUT", `/api/assistant/managers/${project.name}`, { sessionId: codex });
    expect(refused).toMatchObject({ status: 400, json: { error: "Manager chats run on Claude for now" } });
    expect((await call("PUT", "/api/assistant/managers/no-such", { sessionId: codex })).status).toBe(404);
  });

  it("loses its row when the chat is deleted", async () => {
    const id = chat(5);
    await call("PUT", `/api/assistant/managers/${project.name}`, { sessionId: id });
    expect((await call("DELETE", `/api/project/x/chat/sessions/${id}?providerId=claude`)).status).toBe(200);
    expect(managerChats.managerFor(project.path)).toBeNull();
    expect((await call("GET", "/api/assistant/managers")).json.data.managers).toEqual([]);
  });

  it("is found under the id a provider moved it to", async () => {
    const draft = chat(7);
    await call("PUT", `/api/assistant/managers/${project.name}`, { sessionId: draft });
    const renamed = crypto.randomUUID();
    setSessionMigratedTo(draft, renamed);
    chatLifecycle.emit("migrated", { oldSessionId: draft, newSessionId: renamed });
    expect(managerChats.managerFor(project.path)?.sessionId).toBe(renamed);
    expect(managerChats.isManagerChat(renamed)).toBe(true);
    expect(managerChats.isManagerChat(draft)).toBe(true);
  });
});

describe("the main session and Telegram", () => {
  it("moves the chat that followed the old main and leaves a one-off chat alone", async () => {
    const assistant = () => {
      const id = crypto.randomUUID();
      setSessionAssistant(id);
      setSessionProvider(id, "claude");
      return id;
    };
    const first = assistant();
    const oneOff = assistant();
    const second = assistant();
    expect((await call("PUT", "/api/assistant/main-session", { sessionId: first })).json.data.main).toEqual({ providerId: "claude", sessionId: first });
    upsertApprovedPairing("880001", "880001", "Follower");
    upsertApprovedPairing("880002", "880002", "Elsewhere");
    setTelegramBinding("880001", first, "claude");
    setTelegramBinding("880002", oneOff, "claude");
    await call("PUT", "/api/assistant/main-session", { sessionId: second });
    expect(getTelegramBinding("880001")?.sessionId).toBe(second);
    expect(getTelegramBinding("880002")?.sessionId).toBe(oneOff);
    const codex = crypto.randomUUID();
    setSessionAssistant(codex);
    setSessionProvider(codex, "codex");
    expect((await call("PUT", "/api/assistant/main-session", { sessionId: codex })).status).toBe(400);
    expect((await call("GET", "/api/assistant/main-session")).json.data.main.sessionId).toBe(second);
  });
});
