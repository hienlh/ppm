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
const origGetFull = chatService.getFullMessages.bind(chatService);

function stub() {
  (chatService as any).listSessions = async (_p?: string, dir?: string) => {
    if (dir !== PROJ) return [];
    return [...fake.values()].map((f) => f.info);
  };
  (chatService as any).getMessages = async (_pid: string, sid: string) =>
    fake.get(sid)?.messages ?? [];
  // `indexSession` reads the *whole* transcript, not the resumable conversation,
  // so this is the seam it actually goes through.
  (chatService as any).getFullMessages = async (_pid: string, sid: string) =>
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
  (chatService as any).getFullMessages = origGetFull;
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

describe("what one pass is allowed to cost", () => {
  test("stops after the budget and says how many are left", async () => {
    // The case this exists for is an INDEXER_VERSION bump, which makes every
    // session stale at once. Unbounded, the first search after an upgrade
    // re-reads and re-parses the whole corpus before the indexing indicator can
    // finish; here that would be 250 transcripts inside one request.
    for (let i = 0; i < 250; i++) {
      seed(`s${i}`, `2026-07-14T00:00:${String(i % 60).padStart(2, "0")}.000Z`, `content ${i}`);
    }

    const first = await reconcile(PROJ);
    expect(first.total).toBe(250);
    expect(first.indexed).toBe(200);
    expect(first.remaining).toBe(50);

    // The ones left stale are still stale, so the next pass picks them up.
    const second = await reconcile(PROJ);
    expect(second.indexed).toBe(50);
    expect(second.remaining).toBe(0);
    expect(getIndexedCount(PROJ)).toBe(250);

    const third = await reconcile(PROJ);
    expect(third.indexed).toBe(0);
  });

  test("uses a session list it is handed instead of enumerating again", async () => {
    seed("s1", "2026-07-14T00:00:00.000Z", "handed over");
    let listCalls = 0;
    const inner = (chatService as any).listSessions;
    (chatService as any).listSessions = async (...args: unknown[]) => {
      listCalls++;
      return inner(...args);
    };
    try {
      const sessions = await chatService.listSessions(undefined, PROJ);
      listCalls = 0;

      // `GET /chat/search` enumerates for title matching and then handed the
      // same list to the backfill; a dir-scoped list with no limit pages the
      // SDK until exhausted, so doing it twice per keystroke is the cost.
      const r = await reconcile(PROJ, undefined, sessions);

      expect(listCalls).toBe(0);
      expect(r.indexed).toBe(1);
      expect(search(PROJ, "handed", 10).length).toBe(1);
    } finally {
      (chatService as any).listSessions = inner;
    }
  });

  test("startBackfill passes the list through", async () => {
    seed("s1", "2026-07-14T00:00:00.000Z", "through backfill");
    const sessions = await chatService.listSessions(undefined, PROJ);
    let listCalls = 0;
    const inner = (chatService as any).listSessions;
    (chatService as any).listSessions = async (...args: unknown[]) => {
      listCalls++;
      return inner(...args);
    };
    try {
      await startBackfill(PROJ, sessions);
      expect(listCalls).toBe(0);
      expect(getIndexedCount(PROJ)).toBe(1);
    } finally {
      (chatService as any).listSessions = inner;
    }
  });
});

describe("indexSession reads the whole transcript", () => {
  test("indexes the pre-compaction history, not just the resumable conversation", async () => {
    // `getMessages` answers with the segment after the last `compact_boundary`
    // — right for the chat view, which offers "Load previous conversation"
    // beside the summary. The index has no such affordance, so asking the same
    // question leaves everything before the compaction unfindable by any query.
    const updatedAt = "2026-07-14T09:00:00.000Z";
    fake.set("s-compact", {
      info: { id: "s-compact", providerId: "claude", title: "s-compact", createdAt: updatedAt, updatedAt },
      messages: [{ id: "m-new", role: "user", content: "after the compaction", timestamp: updatedAt }],
    });
    // The whole transcript carries both segments.
    (chatService as any).getFullMessages = async () => [
      { id: "m-old", role: "user", content: "before the compaction", timestamp: updatedAt },
      { id: "m-new", role: "user", content: "after the compaction", timestamp: updatedAt },
    ];

    await reconcile(PROJ);

    expect(search(PROJ, "before the compaction", 10).length).toBe(1);
    expect(search(PROJ, "after the compaction", 10).length).toBe(1);
  });
});
