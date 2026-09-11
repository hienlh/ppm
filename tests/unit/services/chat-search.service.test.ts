import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  openTestSearchIndexDb,
  setSearchIndexDb,
  closeSearchIndexDb,
  getSearchIndexDb,
} from "../../../src/services/search-index-db.service.ts";
import {
  indexMessages,
  isStale,
  deleteSession,
  search,
  toFtsQuery,
  getIndexedCount,
  messageSearchText,
  INDEXER_VERSION,
} from "../../../src/services/chat-search.service.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";

function msg(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content, timestamp: "2026-07-14T00:00:00.000Z" };
}

const PROJ_A = "/proj/a";
const PROJ_B = "/proj/b";

beforeEach(() => {
  setSearchIndexDb(openTestSearchIndexDb());
});

afterAll(() => {
  closeSearchIndexDb();
});

describe("toFtsQuery", () => {
  test("plain words become ANDed quoted-prefix terms", () => {
    expect(toFtsQuery("auth token")).toBe('"auth"* "token"*');
  });

  test("punctuation-heavy input does not throw and is quoted safely", () => {
    const q = toFtsQuery('foo AND "bar" -baz (x)');
    // Must be usable in a MATCH without a syntax error.
    setSearchIndexDb(openTestSearchIndexDb());
    indexMessages("s1", PROJ_A, [msg("m1", "user", "foo bar baz x")], 1);
    expect(() => search(PROJ_A, 'foo AND "bar" -baz (x)', 10)).not.toThrow();
    expect(q.length).toBeGreaterThan(0);
  });

  test("empty / whitespace input yields empty query", () => {
    expect(toFtsQuery("   ")).toBe("");
    expect(toFtsQuery("")).toBe("");
  });
});

describe("indexMessages + search", () => {
  test("indexes messages and returns a highlighted snippet with correct ids", () => {
    indexMessages("sess-1", PROJ_A, [
      msg("m1", "user", "how do I configure the authentication middleware"),
      msg("m2", "assistant", "use the better-auth provider for authentication"),
    ], 100);

    const hits = search(PROJ_A, "authentication", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.snippet.includes("<mark>"))).toBe(true);
    const first = hits[0]!;
    expect(first.sessionId).toBe("sess-1");
    expect(["m1", "m2"]).toContain(first.messageId);
    expect(first.role.length).toBeGreaterThan(0);
  });

  test("skips empty-content messages", () => {
    indexMessages("sess-empty", PROJ_A, [
      msg("m1", "user", "   "),
      msg("m2", "assistant", "real content here"),
    ], 1);
    const rows = getSearchIndexDb()
      .query("SELECT COUNT(*) AS n FROM messages_fts WHERE session_id = ?")
      .get("sess-empty") as { n: number };
    expect(rows.n).toBe(1);
  });

  test("re-indexing a session replaces rows (idempotent, no dupes)", () => {
    indexMessages("sess-2", PROJ_A, [msg("m1", "user", "first version alpha")], 1);
    indexMessages("sess-2", PROJ_A, [msg("m1", "user", "second version beta")], 2);

    expect(search(PROJ_A, "alpha", 10).length).toBe(0);
    expect(search(PROJ_A, "beta", 10).length).toBe(1);
    const rows = getSearchIndexDb()
      .query("SELECT COUNT(*) AS n FROM messages_fts WHERE session_id = ?")
      .get("sess-2") as { n: number };
    expect(rows.n).toBe(1);
  });

  test("search is scoped by project_path", () => {
    indexMessages("a1", PROJ_A, [msg("m1", "user", "shared keyword apple")], 1);
    indexMessages("b1", PROJ_B, [msg("m1", "user", "shared keyword apple")], 1);

    const aHits = search(PROJ_A, "apple", 10);
    expect(aHits.every((h) => h.sessionId === "a1")).toBe(true);
    const bHits = search(PROJ_B, "apple", 10);
    expect(bHits.every((h) => h.sessionId === "b1")).toBe(true);
  });

  test("matches Vietnamese content with and without diacritics", () => {
    indexMessages("vn-1", PROJ_A, [
      msg("m1", "user", "thêm một tab để hiện lịch sử trò chuyện"),
    ], 1);
    // With diacritics
    expect(search(PROJ_A, "lịch sử", 10).length).toBeGreaterThan(0);
    // remove_diacritics folding — toneless query still matches
    expect(search(PROJ_A, "lich su", 10).length).toBeGreaterThan(0);
  });
});

describe("isStale", () => {
  test("stale when unindexed; fresh when mtime matches; stale when mtime differs", () => {
    expect(isStale("unknown", 5)).toBe(true);
    indexMessages("sess-3", PROJ_A, [msg("m1", "user", "hello")], 42);
    expect(isStale("sess-3", 42)).toBe(false);
    expect(isStale("sess-3", 43)).toBe(true);
  });
});

describe("deleteSession + getIndexedCount", () => {
  test("removes rows and meta", () => {
    indexMessages("sess-4", PROJ_A, [msg("m1", "user", "deletable content")], 1);
    expect(getIndexedCount(PROJ_A)).toBe(1);
    deleteSession("sess-4");
    expect(getIndexedCount(PROJ_A)).toBe(0);
    expect(search(PROJ_A, "deletable", 10).length).toBe(0);
    expect(isStale("sess-4", 1)).toBe(true);
  });
});

describe("messageSearchText — tool-only turns", () => {
  function toolMsg(id: string, events: ChatMessage["events"]): ChatMessage {
    return { id, role: "assistant", content: "", events, timestamp: "2026-07-14T00:00:00.000Z" };
  }

  test("a turn with no prose but a tool call is still indexable", () => {
    const m = toolMsg("m1", [
      { type: "tool_use", tool: "Bash", input: { command: "gh pr create --title manual-action" } },
      { type: "tool_result", output: "https://github.com/acme/api/pull/10232" },
    ]);
    // The old indexer read `content` only, so this whole turn was dropped.
    expect((m.content ?? "").trim()).toBe("");
    const text = messageSearchText(m);
    expect(text).toContain("Bash");
    expect(text).toContain("manual-action");
    expect(text).toContain("10232");
  });

  test("nested child events of an Agent card are included", () => {
    const text = messageSearchText(toolMsg("m2", [
      {
        type: "tool_use", tool: "Agent", input: {},
        children: [{ type: "tool_result", output: "deep-needle" }],
      },
    ]));
    expect(text).toContain("deep-needle");
  });

  test("thinking is not indexed", () => {
    const text = messageSearchText(toolMsg("m3", [
      { type: "thinking", content: "scratch-reasoning" },
      { type: "text", content: "the answer" },
    ]));
    expect(text).not.toContain("scratch-reasoning");
    expect(text).toContain("the answer");
  });

  test("a turn with neither content nor usable events stays unindexed", () => {
    expect(messageSearchText(toolMsg("m4", [{ type: "done", sessionId: "s" }]))).toBe("");
  });

  test("search matches text that exists only inside a tool result", () => {
    indexMessages("s-tool", PROJ_A, [toolMsg("m1", [
      { type: "tool_result", output: "opened pull request 10232" },
    ])], 1);
    const hits = search(PROJ_A, "10232", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.messageId).toBe("m1");
  });
});

describe("isStale — indexer version", () => {
  test("a row written by an older indexer is stale even at the same mtime", () => {
    indexMessages("s1", PROJ_A, [msg("m1", "user", "hello")], 4242);
    expect(isStale("s1", 4242)).toBe(false);

    getSearchIndexDb()
      .query("UPDATE session_meta SET indexer_version = ? WHERE session_id = ?")
      .run(INDEXER_VERSION - 1, "s1");
    expect(isStale("s1", 4242)).toBe(true);
  });

  test("re-indexing clears the staleness", () => {
    indexMessages("s2", PROJ_A, [msg("m1", "user", "hello")], 7);
    getSearchIndexDb()
      .query("UPDATE session_meta SET indexer_version = 0 WHERE session_id = ?")
      .run("s2");
    expect(isStale("s2", 7)).toBe(true);
    indexMessages("s2", PROJ_A, [msg("m1", "user", "hello")], 7);
    expect(isStale("s2", 7)).toBe(false);
  });
});
