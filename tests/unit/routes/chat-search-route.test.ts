/**
 * `GET /chat/search` with an empty query.
 *
 * The answer to an empty query is two numbers for the indexing chip and an
 * empty result list — but the route reached them by enumerating every session
 * in the project first, and a dir-scoped `listSessions` pages the provider SDK
 * until it is exhausted. The index already knows how many sessions it has a row
 * for, so the empty case is answered from SQL and the walk is what a real query
 * pays for.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import {
  openTestSearchIndexDb,
  setSearchIndexDb,
  closeSearchIndexDb,
} from "../../../src/services/search-index-db.service.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

const PROJ = "/proj/search-route";

let listCalls = 0;
const origList = chatService.listSessions.bind(chatService);

function app() {
  const hono = new Hono<Env>();
  hono.use("/*", async (c, next) => {
    c.set("projectPath", PROJ);
    c.set("projectName", "search-route");
    await next();
  });
  hono.route("/chat", chatRoutes);
  return hono;
}

beforeEach(() => {
  setSearchIndexDb(openTestSearchIndexDb());
  listCalls = 0;
  (chatService as unknown as { listSessions: unknown }).listSessions = async () => {
    listCalls++;
    return [];
  };
});

afterAll(() => {
  (chatService as unknown as { listSessions: unknown }).listSessions = origList;
  closeSearchIndexDb();
});

describe("GET /chat/search", () => {
  it("answers an empty query without enumerating the project's sessions", async () => {
    const res = await app().request("/chat/search?q=");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.results).toEqual([]);
    expect(body.data.indexing).toEqual({ total: 0, indexed: 0, running: false });
    expect(listCalls).toBe(0);
  });

  it("answers a missing query parameter the same way", async () => {
    const res = await app().request("/chat/search");
    expect(res.status).toBe(200);
    expect(listCalls).toBe(0);
  });

  it("still enumerates for a real query, since titles are matched against it", async () => {
    const res = await app().request("/chat/search?q=alpha");
    expect(res.status).toBe(200);
    expect(listCalls).toBe(1);
  });
});
