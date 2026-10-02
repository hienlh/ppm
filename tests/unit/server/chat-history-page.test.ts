import { describe, expect, test } from "bun:test";
import { pageHistory, parseHistoryPageQuery } from "../../../src/server/routes/chat-history-page.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";

/** `turns` turns of one user message followed by `perTurn` assistant messages. */
function transcript(turns: number, perTurn = 1): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    out.push({ id: `u${t}`, role: "user", content: `q${t}`, timestamp: "" } as ChatMessage);
    for (let a = 0; a < perTurn; a++) {
      out.push({ id: `a${t}-${a}`, role: "assistant", content: `r${t}`, timestamp: "" } as ChatMessage);
    }
  }
  return out;
}

describe("pageHistory", () => {
  test("no paging query returns the whole list, as older clients expect", () => {
    const all = transcript(30);
    const page = pageHistory(all, {});
    expect(page.messages).toHaveLength(60);
    expect(page.start).toBe(0);
    expect(page.userOrdinalOffset).toBe(0);
  });

  test("limit returns the newest page, starting on a user message", () => {
    const all = transcript(100); // 200 messages
    const page = pageHistory(all, { limit: 51 });
    expect(page.total).toBe(200);
    // 200 - 51 = 149 is an assistant message; the page moves back to its turn's user.
    expect(page.start).toBe(148);
    expect(page.messages[0]!.role).toBe("user");
    expect(page.messages.at(-1)!.id).toBe("a99-0");
  });

  test("before pages backwards without overlap or gap", () => {
    const all = transcript(100);
    const newest = pageHistory(all, { limit: 50 });
    const older = pageHistory(all, { limit: 50, before: newest.start });
    expect(older.messages.at(-1)!.id).toBe(all[newest.start - 1]!.id);
    const joined = [...older.messages, ...newest.messages].map((m) => m.id);
    expect(joined).toEqual(all.slice(older.start).map((m) => m.id));
  });

  test("the ordinal offset makes a window number user messages like the full list", () => {
    const all = transcript(100);
    const page = pageHistory(all, { limit: 50 });
    // Each turn has one user message, so the offset is the number of turns before the window.
    expect(page.userOrdinalOffset).toBe(page.start / 2);
  });

  test("user messages with no text do not count toward the offset", () => {
    const all = transcript(10);
    all[2] = { ...all[2]!, content: "   " };
    const page = pageHistory(all, { limit: 4 });
    expect(page.start).toBe(16);
    expect(page.userOrdinalOffset).toBe(7);
  });

  test("a huge turn is not pulled whole into one page", () => {
    const all = transcript(2, 300); // 602 messages, two turns
    const page = pageHistory(all, { limit: 50 });
    expect(page.messages.length).toBe(50);
  });

  test("from keeps everything already loaded; past the end it falls back to the newest page", () => {
    const all = transcript(100);
    expect(pageHistory(all, { from: 20, limit: 50 }).messages).toHaveLength(180);
    const shrunk = pageHistory(transcript(10), { from: 150, limit: 6 });
    expect(shrunk.start).toBe(14);
    expect(shrunk.messages).toHaveLength(6);
  });
});

describe("parseHistoryPageQuery", () => {
  test("ignores malformed numbers", () => {
    const q: Record<string, string> = { limit: "50", before: "abc", from: "" };
    expect(parseHistoryPageQuery((n) => q[n])).toEqual({ limit: 50, before: undefined, from: undefined });
  });
});
