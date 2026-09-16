import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test-setup.ts"; // isolated DB + disabled auth
import { configService } from "../../src/services/config.service.ts";
import { app } from "../../src/server/index.ts";
import { chatService } from "../../src/services/chat.service.ts";
import {
  openTestSearchIndexDb,
  setSearchIndexDb,
  closeSearchIndexDb,
} from "../../src/services/search-index-db.service.ts";
import { indexMessages } from "../../src/services/chat-search.service.ts";
import type { ChatMessage, ChatSearchResponse, SessionInfo } from "../../src/types/chat.ts";

const PROJECT = "search-test";
const PROJECT_PATH = process.cwd();
const UPDATED = "2026-07-14T00:00:00.000Z";
const MTIME = Date.parse(UPDATED); // matches staleKey(updatedAt) → reconcile treats as fresh

const origList = chatService.listSessions.bind(chatService);
let listCalls = 0;
const origGet = chatService.getMessages.bind(chatService);

function session(id: string, title: string): SessionInfo {
  return { id, providerId: "claude", title, createdAt: UPDATED, updatedAt: UPDATED };
}

const FIXTURES: SessionInfo[] = [
  session("s-content", "Untitled chat"),
  session("s-title", "Deploy pipeline notes"),
  session("s-both", "authentication design"),
];

// Content per session — used to seed the index AND back the getMessages stub so
// the lazy backfill (reconcile) re-indexes identically instead of wiping rows.
const CONTENT: Record<string, ChatMessage[]> = {
  "s-content": [{ id: "s-content-m2", role: "assistant", content: "configure the webhook endpoint carefully", timestamp: UPDATED }],
  "s-both": [{ id: "s-both-m1", role: "user", content: "how does authentication middleware work", timestamp: UPDATED }],
};

async function search(q: string, limit?: number): Promise<ChatSearchResponse> {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (limit) qs.set("limit", String(limit));
  const url = `http://localhost/api/project/${PROJECT}/chat/search?${qs}`;
  const res = await app.request(new Request(url));
  const json = await res.json() as { ok: boolean; data: ChatSearchResponse };
  expect(json.ok).toBe(true);
  return json.data;
}

// This suite registers its project under its own name but on the SAME path as the
// shared "test" fixture other suites use, and projects.path is UNIQUE — so the
// entry must not outlive this file or the next registration hits the constraint.
let registeredProject = false;

beforeAll(() => {
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === PROJECT)) {
    projects.push({ name: PROJECT, path: PROJECT_PATH });
    configService.set("projects", projects);
    registeredProject = true;
  }
  setSearchIndexDb(openTestSearchIndexDb());
  (chatService as any).listSessions = async (_p?: string, dir?: string) => {
    listCalls++;
    return dir === PROJECT_PATH ? FIXTURES : [];
  };
  (chatService as any).getMessages = async (_pid: string, sid: string) => CONTENT[sid] ?? [];

  for (const [sid, msgs] of Object.entries(CONTENT)) {
    indexMessages(sid, PROJECT_PATH, msgs, MTIME);
  }
});

afterAll(() => {
  (chatService as any).listSessions = origList;
  (chatService as any).getMessages = origGet;
  closeSearchIndexDb();
  if (registeredProject) {
    configService.set("projects", configService.get("projects").filter((p) => p.name !== PROJECT));
  }
});

describe("GET /chat/search", () => {
  /**
   * An empty query renders the indexing chip and nothing else, so it must not
   * enumerate: a dir-scoped list pages the SDK until it is exhausted. The price is
   * that its total is only what this process has *seen* — and the two tests below
   * pin both halves of that, in the order a user produces them.
   *
   * This one used to assert the enumerated total for a query that no longer
   * enumerates. Two of the three fixtures have index rows (`s-title` has no
   * content, so nothing seeded one), and the rows are all an empty query has
   * before anything has listed the sessions.
   */
  it("empty query returns no results and answers from the index, without enumerating", async () => {
    const before = listCalls;
    const data = await search("");
    expect(data.results).toEqual([]);
    expect(listCalls).toBe(before);
    expect(data.indexing.total).toBe(Object.keys(CONTENT).length);
  });

  it("an empty query after a real one reports what that query enumerated", async () => {
    // The case that matters. Rows alone fall short of the session count whenever a
    // session has not been read yet — here `s-title`, and on a fresh index every
    // session a budgeted pass has not reached — and a denominator that low lets the
    // chip read "finished" with work outstanding. Clearing the search box after
    // typing is exactly when a user looks at it.
    await search("webhook");
    const data = await search("");
    expect(data.indexing.total).toBe(FIXTURES.length);
  });

  it("content match returns snippet + messageId, matchedIn=content", async () => {
    const data = await search("webhook");
    const hit = data.results.find((r) => r.sessionId === "s-content");
    expect(hit).toBeDefined();
    expect(hit!.matchedIn).toBe("content");
    expect(hit!.messageId).toBe("s-content-m2");
    expect(hit!.snippet).toContain("<mark>");
  });

  it("title-only match returns matchedIn=title with empty messageId", async () => {
    const data = await search("pipeline");
    const hit = data.results.find((r) => r.sessionId === "s-title");
    expect(hit).toBeDefined();
    expect(hit!.matchedIn).toBe("title");
    expect(hit!.messageId).toBe("");
  });

  it("session matching both title and content is deduped, title wins", async () => {
    const data = await search("authentication");
    const rows = data.results.filter((r) => r.sessionId === "s-both");
    expect(rows.length).toBe(1);
    expect(rows[0]!.matchedIn).toBe("title");
  });
});
