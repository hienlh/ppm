/**
 * Every chat-list route that writes tells open PPMs that project's list changed, once, and only
 * when it answered 2xx; a read or a refused write says nothing. Run against the real chat and tag
 * routes, with the announcement handed in the way the CLI hands in its own.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { openTestDb, setDb, setSessionMetadata, setSessionProvider } from "../../../src/services/db.service.ts";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { tagRoutes } from "../../../src/server/routes/tag-routes.ts";
import { ANNOUNCE_CHAT_LIST_ENV_KEY } from "../../../src/server/routes/chat-list-broadcast.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { createTag } from "../../../src/services/tag.service.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

const PROJ = "/proj/alpha";
const origCreate = chatService.createSession.bind(chatService);
let announced: string[] = [];

function app() {
  const hono = new Hono<Env>();
  hono.use("/*", async (c, next) => {
    c.set("projectPath", PROJ);
    c.set("projectName", "alpha");
    await next();
  });
  hono.route("/chat", chatRoutes);
  hono.route("/tags", tagRoutes);
  return hono;
}

let renames: unknown[] = [];
const env = {
  [ANNOUNCE_CHAT_LIST_ENV_KEY]: (name: string, renamed?: unknown) => { announced.push(name); renames.push(renamed); },
};
const call = (path: string, method = "GET", body?: unknown) => app().request(path, {
  method,
  ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
}, env);

beforeEach(() => {
  setDb(openTestDb());
  announced = [];
  renames = [];
  // A Codex chat: renaming it touches PPM's title table only, never Claude's SDK.
  setSessionMetadata("s1", "alpha", PROJ);
  setSessionProvider("s1", "codex");
  (chatService as unknown as { createSession: unknown }).createSession = async (providerId: string, cfg: { title?: string }) => ({
    id: "s-fork", providerId, title: cfg.title ?? "", createdAt: new Date().toISOString(),
  });
});

afterAll(() => {
  (chatService as unknown as { createSession: unknown }).createSession = origCreate;
});

describe("sessions:list_changed from the chat routes", () => {
  it("rename, pin, unpin, tag, untag, bulk tag and fork each announce once", async () => {
    const tag = createTag(PROJ, "Work", "#112233");
    expect((await call("/chat/sessions/s1", "PATCH", { title: "Renamed" })).status).toBe(200);
    expect((await call("/chat/sessions/s1/pin", "PUT")).status).toBe(200);
    expect((await call("/chat/sessions/s1/pin", "DELETE")).status).toBe(200);
    expect((await call("/chat/sessions/s1/tag", "PATCH", { tagId: tag.id })).status).toBe(200);
    expect((await call("/chat/sessions/s1/tag", "DELETE")).status).toBe(200);
    expect((await call("/chat/sessions/bulk-tag", "PATCH", { sessionIds: ["s1"], tagId: tag.id })).status).toBe(200);
    expect((await call("/chat/sessions/s1/fork?providerId=claude", "POST")).status).toBe(201);
    expect(announced).toEqual(Array(7).fill("alpha"));
    // Only the rename names the chat and its new title, which open tabs of it take at once.
    expect(renames).toEqual([{ sessionId: "s1", title: "Renamed" }, ...Array(6).fill(undefined)]);
  });

  it("a rename's announcement carries the trimmed title the chat now has", async () => {
    expect((await call("/chat/sessions/s1", "PATCH", { title: "  Spaced  " })).status).toBe(200);
    expect(renames).toEqual([{ sessionId: "s1", title: "Spaced" }]);
  });

  it("a read announces nothing", async () => {
    expect((await call("/chat/sessions/unread")).status).toBe(200);
    expect((await call("/tags")).status).toBe(200);
    expect(announced).toEqual([]);
  });

  it("a refused write announces nothing", async () => {
    expect((await call("/chat/sessions/s1", "PATCH", {})).status).toBe(400);
    expect((await call("/chat/sessions/s1/tag", "PATCH", { tagId: 9999 })).status).toBe(404);
    expect((await call("/chat/sessions/s1/account", "PUT", {})).status).toBe(400);
    expect((await call("/tags", "POST", { name: "" })).status).toBe(400);
    expect(announced).toEqual([]);
  });
});

describe("sessions:list_changed from the tag routes", () => {
  it("create, rename, default, reset and delete each announce once", async () => {
    const created = await call("/tags", "POST", { name: "Later", color: "#445566" });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: number } }).data.id;
    expect((await call(`/tags/${id}`, "PATCH", { name: "Soon" })).status).toBe(200);
    expect((await call("/tags/default-tag", "PATCH", { tagId: id })).status).toBe(200);
    expect((await call("/tags/reset", "POST")).status).toBe(200);
    expect((await call(`/tags/${id}`, "DELETE")).status).toBe(200);
    expect(announced).toEqual(Array(5).fill("alpha"));
  });
});
