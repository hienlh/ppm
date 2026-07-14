import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  openTestSearchIndexDb,
  setSearchIndexDb,
  closeSearchIndexDb,
} from "../../../src/services/search-index-db.service.ts";
import {
  reconcile,
  startBackfill,
  isBackfillRunning,
  getIndexStatus,
  search,
  getIndexedCount,
} from "../../../src/services/chat-search.service.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import type { ChatMessage, SessionInfo } from "../../../src/types/chat.ts";

const PROJ = "/proj/reconcile";

// --- Fake transcript store driving the stubbed chatService -----------------
interface Fake { info: SessionInfo; messages: ChatMessage[] }
let fake: Map<string, Fake>;

const origList = chatService.listSessions.bind(chatService);
const origGet = chatService.getMessages.bind(chatService);

function stub() {
  (chatService as any).listSessions = async (_p?: string, dir?: string) => {
    if (dir !== PROJ) return [];
    return [...fake.values()].map((f) => f.info);
  };
  (chatService as any).getMessages = async (_pid: string, sid: string) =>
    fake.get(sid)?.messages ?? [];
}

function seed(id: string, updatedAt: string, content: string) {
  fake.set(id, {
    info: { id, providerId: "claude", title: id, createdAt: updatedAt, updatedAt },
    messages: [{ id: `${id}-m1`, role: "user", content, timestamp: updatedAt }],
  });
}

beforeEach(() => {
  setSearchIndexDb(openTestSearchIndexDb());
  fake = new Map();
  stub();
});

afterAll(() => {
  (chatService as any).listSessions = origList;
  (chatService as any).getMessages = origGet;
  closeSearchIndexDb();
});

describe("reconcile", () => {
  test("indexes all sessions; second run is a no-op (all fresh)", async () => {
    seed("s1", "2026-07-14T00:00:00.000Z", "alpha content one");
    seed("s2", "2026-07-14T00:01:00.000Z", "beta content two");

    const first = await reconcile(PROJ);
    expect(first.total).toBe(2);
    expect(first.indexed).toBe(2);
    expect(getIndexedCount(PROJ)).toBe(2);
    expect(search(PROJ, "alpha", 10).length).toBe(1);

    const second = await reconcile(PROJ);
    expect(second.total).toBe(2);
    expect(second.indexed).toBe(0); // nothing stale
  });

  test("re-indexes only the session whose updatedAt advanced", async () => {
    seed("s1", "2026-07-14T00:00:00.000Z", "original text");
    await reconcile(PROJ);

    // Mutate content + bump updatedAt
    seed("s1", "2026-07-14T09:00:00.000Z", "updated text changed");
    const r = await reconcile(PROJ);
    expect(r.indexed).toBe(1);
    expect(search(PROJ, "original", 10).length).toBe(0);
    expect(search(PROJ, "updated", 10).length).toBe(1);
  });

  test("reports progress for each session", async () => {
    seed("s1", "2026-07-14T00:00:00.000Z", "one");
    seed("s2", "2026-07-14T00:00:01.000Z", "two");
    seed("s3", "2026-07-14T00:00:02.000Z", "three");
    const seen: Array<[number, number]> = [];
    await reconcile(PROJ, (d, t) => seen.push([d, t]));
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });
});

describe("startBackfill dedup + status", () => {
  test("concurrent starts share one run; status reflects running then idle", async () => {
    for (let i = 0; i < 5; i++) seed(`s${i}`, `2026-07-14T00:0${i}:00.000Z`, `content ${i}`);

    const a = startBackfill(PROJ);
    const b = startBackfill(PROJ);
    expect(a).toBe(b); // deduped to the same promise
    expect(isBackfillRunning(PROJ)).toBe(true);
    expect(getIndexStatus(PROJ).running).toBe(true);

    await a;
    expect(isBackfillRunning(PROJ)).toBe(false);
    const status = getIndexStatus(PROJ);
    expect(status.running).toBe(false);
    expect(status.indexed).toBe(5);
  });
});
