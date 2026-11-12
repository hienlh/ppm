/**
 * `DELETE /chat/sessions/:id`: a chat recorded under another project is not found, the stored
 * provider is used when none is named, and `?stopRunning=1` stops a running turn before deleting
 * — or deletes nothing when the turn does not stop. Run against the real chat routes, with a fake
 * chat control standing in for the chat socket layer.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { openTestDb, setDb, setSessionMetadata, setSessionProvider, setSessionTitle, getSessionTitle, pinSession, getPinnedSessionIds } from "../../../src/services/db.service.ts";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { CHAT_DELETE_WAIT_ENV_KEY } from "../../../src/server/routes/chat-session-delete.ts";
import { ANNOUNCE_CHAT_LIST_ENV_KEY } from "../../../src/server/routes/chat-list-broadcast.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { managerChats } from "../../../src/services/assistant-managers/manager-chats.service.ts";
import { chatControl, setChatControl, type ChatControl, type LiveChatState, type ServerOrigin } from "../../../src/services/chat-control/chat-control.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

const PROJ = "/proj/alpha";
const previousControl = chatControl();
const origDelete = chatService.deleteSession.bind(chatService);
const origIsManager = managerChats.isManagerChat;

let deleted: Array<{ providerId: string; id: string }> = [];
let cancels: Array<{ id: string; origin: ServerOrigin }> = [];
let announced: string[] = [];
let running = new Set<string>();
/** Sessions whose turn ignores a stop. */
let stuck = new Set<string>();
let managers = new Set<string>();

const live = (id: string): LiveChatState | null => (running.has(id)
  ? { phase: "streaming", running: true, projectName: "alpha", providerId: "claude", queuedCards: 0 }
  : null);

const fakeControl: ChatControl = {
  sendUserMessage: async () => ({ ok: false, error: "not in this test" }),
  answerApproval: () => "stale",
  cancelTurn(id, origin) {
    cancels.push({ id, origin });
    if (!stuck.has(id)) running.delete(id);
    return true;
  },
  liveState: live,
  listLive: () => [...running].map((sessionId) => ({ sessionId, ...live(sessionId)! })),
};

function app() {
  const hono = new Hono<Env>();
  hono.use("/*", async (c, next) => {
    c.set("projectPath", PROJ);
    c.set("projectName", "alpha");
    await next();
  });
  hono.route("/chat", chatRoutes);
  return hono;
}

const env = {
  [ANNOUNCE_CHAT_LIST_ENV_KEY]: (name: string) => { announced.push(name); },
  [CHAT_DELETE_WAIT_ENV_KEY]: { intervalMs: 5, timeoutMs: 100 },
};
const del = (path: string) => app().request(`/chat/sessions/${path}`, { method: "DELETE" }, env);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeEach(() => {
  setDb(openTestDb());
  deleted = []; cancels = []; announced = [];
  running = new Set(); stuck = new Set(); managers = new Set();
  setChatControl(fakeControl);
  (chatService as unknown as { deleteSession: unknown }).deleteSession = async (providerId: string, id: string) => {
    deleted.push({ providerId, id });
  };
  managerChats.isManagerChat = (id: string) => managers.has(id);
});

afterAll(() => {
  setChatControl(previousControl);
  (chatService as unknown as { deleteSession: unknown }).deleteSession = origDelete;
  managerChats.isManagerChat = origIsManager;
});

describe("DELETE /chat/sessions/:id", () => {
  it("answers 404 for a chat recorded under another project, and changes nothing", async () => {
    setSessionMetadata("s-other", "beta", "/proj/beta");
    setSessionTitle("s-other", "Theirs");
    const res = await del("s-other");
    expect(res.status).toBe(404);
    expect(deleted).toEqual([]);
    expect(getSessionTitle("s-other")).toBe("Theirs");
    expect(announced).toEqual([]);
  });

  it("uses the chat's stored provider when none is named, and drops PPM's rows", async () => {
    setSessionMetadata("s-codex", "alpha", PROJ);
    setSessionProvider("s-codex", "codex");
    setSessionTitle("s-codex", "Mine");
    pinSession("s-codex");
    const res = await del("s-codex");
    expect(res.status).toBe(200);
    expect(deleted).toEqual([{ providerId: "codex", id: "s-codex" }]);
    expect(getSessionTitle("s-codex")).toBeNull();
    expect(getPinnedSessionIds().has("s-codex")).toBe(false);
    expect(announced).toEqual(["alpha"]);
  });

  it("a named provider still wins, and a chat with no record is deleted as before", async () => {
    expect((await del("s-norecord?providerId=claude")).status).toBe(200);
    expect(deleted).toEqual([{ providerId: "claude", id: "s-norecord" }]);
  });

  it("with stopRunning, stops the running turn first, then deletes", async () => {
    setSessionMetadata("s-run", "alpha", PROJ);
    running.add("s-run");
    const res = await del("s-run?stopRunning=1");
    expect(res.status).toBe(200);
    expect(cancels).toEqual([{ id: "s-run", origin: "delete" }]);
    expect(deleted).toEqual([{ providerId: "claude", id: "s-run" }]);
    expect(announced).toEqual(["alpha"]);
  });

  it("with stopRunning, a turn that does not stop is a 409 and nothing is deleted", async () => {
    setSessionMetadata("s-stuck", "alpha", PROJ);
    setSessionTitle("s-stuck", "Busy");
    running.add("s-stuck");
    stuck.add("s-stuck");
    const res = await del("s-stuck?stopRunning=1");
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain("did not stop");
    expect(cancels.length).toBe(1);
    expect(deleted).toEqual([]);
    expect(getSessionTitle("s-stuck")).toBe("Busy");
    expect(announced).toEqual([]);
  });

  it("with stopRunning, an idle chat is deleted without a stop", async () => {
    setSessionMetadata("s-idle", "alpha", PROJ);
    expect((await del("s-idle?stopRunning=1")).status).toBe(200);
    expect(cancels).toEqual([]);
    expect(deleted.length).toBe(1);
  });

  it("with stopRunning, a project's manager chat is refused", async () => {
    setSessionMetadata("s-mgr", "alpha", PROJ);
    managers.add("s-mgr");
    running.add("s-mgr");
    const res = await del("s-mgr?stopRunning=1");
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain("manager chat");
    expect(cancels).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("without the flag, a running chat is deleted as before, with no stop of its own", async () => {
    setSessionMetadata("s-plain", "alpha", PROJ);
    running.add("s-plain");
    expect((await del("s-plain")).status).toBe(200);
    expect(cancels).toEqual([]);
    expect(deleted.length).toBe(1);
  });
});

describe("DELETE /chat/sessions (clean-up)", () => {
  it("keeps a chat whose turn is running, however old it is", async () => {
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    const origList = chatService.listSessions.bind(chatService);
    (chatService as unknown as { listSessions: unknown }).listSessions = async () => [
      { id: "old-idle", providerId: "claude", createdAt: old },
      { id: "old-running", providerId: "claude", createdAt: old },
    ];
    try {
      running.add("old-running");
      const res = await app().request("/chat/sessions?olderThanDays=7", { method: "DELETE" }, env);
      expect(res.status).toBe(200);
      expect(deleted.map((d) => d.id)).toEqual(["old-idle"]);
      expect(announced).toEqual(["alpha"]);
    } finally {
      (chatService as unknown as { listSessions: unknown }).listSessions = origList;
    }
  });
});
