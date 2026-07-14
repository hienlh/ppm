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

beforeAll(() => {
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === PROJECT)) {
    projects.push({ name: PROJECT, path: PROJECT_PATH });
    configService.set("projects", projects);
  }
  setSearchIndexDb(openTestSearchIndexDb());
  (chatService as any).listSessions = async (_p?: string, dir?: string) =>
    dir === PROJECT_PATH ? FIXTURES : [];
  (chatService as any).getMessages = async (_pid: string, sid: string) => CONTENT[sid] ?? [];

  for (const [sid, msgs] of Object.entries(CONTENT)) {
    indexMessages(sid, PROJECT_PATH, msgs, MTIME);
  }
});

afterAll(() => {
  (chatService as any).listSessions = origList;
  (chatService as any).getMessages = origGet;
  closeSearchIndexDb();
});

describe("GET /chat/search", () => {
  it("empty query returns no results but reports indexing total", async () => {
    const data = await search("");
    expect(data.results).toEqual([]);
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

  it("session matching both title and content is deduped, content wins", async () => {
    const data = await search("authentication");
    const rows = data.results.filter((r) => r.sessionId === "s-both");
    expect(rows.length).toBe(1);
    expect(rows[0]!.matchedIn).toBe("content");
  });
});
