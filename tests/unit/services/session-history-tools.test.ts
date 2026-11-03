import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { closeSearchIndexDb, openTestSearchIndexDb, setSearchIndexDb } from "../../../src/services/search-index-db.service.ts";
import { indexMessages } from "../../../src/services/chat-search.service.ts";
import { createSessionHistoryTools } from "../../../src/services/tab-tools-mcp/session-history-tools.ts";
import { createCallLimiter } from "../../../src/services/tab-tools-mcp/session-history-rate-limit.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";

const PROJ = "/proj/history-tools";
const binding = { sessionId: "caller-session-1", projectPath: PROJ, projectName: "history-tools" };
const at = "2026-11-01T10:00:00.000Z";
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

beforeEach(() => setSearchIndexDb(openTestSearchIndexDb()));
afterAll(() => closeSearchIndexDb());

function seed(): void {
  const messages: ChatMessage[] = [
    { id: "m1", role: "user", content: "how do we rotate the deploy keys", timestamp: at, turnId: "aaaaaaaa-0000-4000-8000-000000000001", turnN: 1 },
    { id: "m2", role: "assistant", content: "", timestamp: at, turnId: "aaaaaaaa-0000-4000-8000-000000000001", turnN: 1, events: [
      { type: "tool_use", tool: "Bash", input: { command: "cat ~/.secrets" } },
      { type: "tool_result", output: "API_TOKEN=sk-live-zebra" },
      { type: "text", content: "Rotate them with the keys script." },
    ] },
  ];
  indexMessages("11111111-2222-4333-8444-555555555555", PROJ, messages, 1, { providerId: "claude", title: "Deploy keys rotation" });
}

describe("session history tools", () => {
  it("search matches prompts, answers and titles, never what a tool printed, and quotes no <mark>", async () => {
    seed();
    const tools = createSessionHistoryTools({ canonical: (id) => id });
    const hit = text(await tools.call(binding, "search_sessions", { query: "rotate" }) as never);
    expect(hit).toContain("Deploy keys rotation · Turn 1 · aaaaaaaa-0000-4000-8000-000000000001");
    expect(text(await tools.call(binding, "search_sessions", { query: "deploy keys" }) as never)).toContain("Title matches (session · provider · title):\n- 11111111-2222-4333-8444-555555555555 · claude · Deploy keys rotation");
    expect(hit).not.toContain("<mark>");
    for (const q of ["zebra", "sk-live", "secrets"]) {
      const miss = text(await tools.call(binding, "search_sessions", { query: q }) as never);
      expect(miss).toContain("No session matches");
      expect(miss).not.toContain("API_TOKEN");
    }
    const answer = text(await tools.call(binding, "search_sessions", { query: "keys" }) as never);
    expect(answer).not.toContain("API_TOKEN");
    expect(answer).not.toContain("Index incomplete");
  });

  it("validates arguments before reading anything", async () => {
    const tools = createSessionHistoryTools({ canonical: (id) => id });
    const err = async (name: string, args: Record<string, unknown>) => (await tools.call(binding, name, args)) as { isError?: boolean; content: Array<{ text: string }> };
    expect((await err("search_sessions", { query: "" })).isError).toBe(true);
    expect((await err("search_sessions", { query: "x", limit: 99 })).isError).toBe(true);
    expect((await err("read_session_turns", { session_id: "11111111-2222-4333-8444-555555555555" })).isError).toBe(true);
    expect((await err("read_session_turns", { session_id: "11111111-2222-4333-8444-555555555555", turn_ids: ["a"], from_turn: 1, to_turn: 2 })).isError).toBe(true);
    expect(text(await err("read_session_turns", { session_id: "11111111-2222-4333-8444-555555555555", from_turn: 1, to_turn: 11 }))).toContain("at most 10");
    expect(text(await err("read_session_turns", { session_id: "11111111-2222-4333-8444-555555555555", turn_ids: Array(11).fill("x") }))).toContain("1 to 10");
    expect((await err("list_session_turns", { session_id: "x", limit: 0 })).isError).toBe(true);
    const noProject = await tools.call({ ...binding, projectPath: null }, "search_sessions", { query: "x" }) as { isError?: boolean };
    expect(noProject.isError).toBe(true);
  });

  it("rate limits per canonical caller: 20 a minute and 2 in flight, across the three tools", async () => {
    let now = 0;
    const limiter = createCallLimiter({ now: () => now });
    const tools = createSessionHistoryTools({ canonical: (id) => (id === "old-draft-id" ? "caller-session-1" : id), limiter });
    for (let i = 0; i < 20; i++) {
      const r = await tools.call(i % 2 ? binding : { ...binding, sessionId: "old-draft-id" }, "search_sessions", { query: "anything" }) as { content: Array<{ text: string }> };
      expect(text(r)).not.toContain("a minute");
    }
    const refused = await tools.call(binding, "list_session_turns", { session_id: "x" }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("20 session-history calls a minute");
    expect(text(await tools.call({ ...binding, sessionId: "another-chat" }, "search_sessions", { query: "a" }) as never)).not.toContain("a minute");
    now = 61_000;
    expect(text(await tools.call(binding, "search_sessions", { query: "a" }) as never)).not.toContain("a minute");

    const inFlight = createCallLimiter({ now: () => 0 });
    const a = inFlight.acquire("k");
    const b = inFlight.acquire("k");
    const c = inFlight.acquire("k");
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
    if (a.ok) a.release();
    expect(inFlight.acquire("k").ok).toBe(true);
  });
});
