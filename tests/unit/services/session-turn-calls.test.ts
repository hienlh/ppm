/**
 * A session's turns as the review tools and `ppm chat revert-turn` name them: the browser's own
 * grouping (shared), the newest turns only, and a clear reason when a turn cannot be named.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TURN_LIMIT, MAX_TURN_LIMIT, findTurn, summarizeTurns, turnLimitOf,
} from "../../../src/services/session-file-baselines/session-turn-calls.ts";
import { sessionTurns as webSessionTurns } from "../../../src/web/lib/session-turns.ts";
import { sessionTurns as sharedSessionTurns } from "../../../src/shared/session-turns.ts";
import type { ChatEvent, ChatMessage } from "../../../src/types/chat.ts";

const at = (minute: number) => `2026-11-13T05:${String(minute).padStart(2, "0")}:00.000Z`;
const user = (id: string, content: string, minute: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: "user", content, timestamp: at(minute), ...extra });
const assistant = (id: string, events: ChatEvent[], minute: number): ChatMessage =>
  ({ id, role: "assistant", content: "", events, timestamp: at(minute) });
const edit = (toolUseId: string, filePath: string): ChatEvent =>
  ({ type: "tool_use", tool: "Edit", input: { file_path: filePath, old_string: "a", new_string: "b" }, toolUseId });

/** `count` turns, turn i (1-based) making one Edit call `toolu_<i>` on `/w/f<i>.ts`. */
function history(count: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(user(`u${i}`, `prompt ${i}`, i, { turnN: i }), assistant(`a${i}`, [edit(`toolu_${i}`, `/w/f${i}.ts`)], i));
  }
  return out;
}

describe("summarizeTurns", () => {
  test("the browser's grouping, re-exported where the browser imports it", () => {
    expect(webSessionTurns).toBe(sharedSessionTurns);
  });

  test("answers the newest turns, oldest first, with their calls, the total and the files the calls name", () => {
    const r = summarizeTurns(history(25), DEFAULT_TURN_LIMIT);
    expect(r.total).toBe(25);
    expect(r.turns.map((t) => t.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
    expect(r.turns[0]).toEqual({ n: 6, at: at(6), prompt: "prompt 6", calls: ["toolu_6"] });
    expect(r.paths).toHaveLength(25);
    expect(r.paths).toContain("/w/f1.ts");
  });

  test("cuts a long prompt at 200 characters", () => {
    const r = summarizeTurns([user("u1", "x".repeat(500), 1, { turnN: 1 })], 5);
    expect(r.turns[0]!.prompt).toBe(`${"x".repeat(200)}…`);
  });
});

describe("findTurn", () => {
  const result = summarizeTurns(history(25), DEFAULT_TURN_LIMIT);

  test("finds a turn in reach", () => {
    expect(findTurn(result, 12)).toMatchObject({ n: 12, calls: ["toolu_12"] });
  });

  test("says when a turn is older than the turns it can reach", () => {
    expect(findTurn(result, 3)).toContain("older than the newest 20 turns");
  });

  test("says when the session has no such turn", () => {
    expect(findTurn(result, 40)).toContain("no turn 40");
    expect(findTurn(summarizeTurns([], 20), 1)).toContain("none yet");
  });

  test("refuses to name a turn the server could not number", () => {
    const loose = summarizeTurns([user("u1", "a", 1), assistant("a1", [edit("t1", "/w/a")], 1)], 20, false);
    expect(loose.turns[0]!.unnumbered).toBe(true);
    expect(findTurn(loose, 1)).toContain("could not number");
  });
});

test("turnLimitOf keeps a limit within bounds", () => {
  expect(turnLimitOf(undefined)).toBe(DEFAULT_TURN_LIMIT);
  expect(turnLimitOf("abc")).toBe(DEFAULT_TURN_LIMIT);
  expect(turnLimitOf("0")).toBe(DEFAULT_TURN_LIMIT);
  expect(turnLimitOf("5")).toBe(5);
  expect(turnLimitOf("500")).toBe(MAX_TURN_LIMIT);
});
