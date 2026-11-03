import { describe, expect, test } from "bun:test";
import { sessionTurns, turnLabel, turnsByCall, turnsOf, turnTime } from "../../../src/web/lib/session-turns.ts";
import type { ChatEvent, ChatMessage } from "../../../src/types/chat.ts";

const at = (minute: number) => `2026-10-03T14:${String(minute).padStart(2, "0")}:00.000Z`;

function user(id: string, content: string, minute = 0, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "user", content, timestamp: at(minute), ...extra };
}

function assistant(id: string, events: ChatEvent[], minute = 0): ChatMessage {
  return { id, role: "assistant", content: "", events, timestamp: at(minute) };
}

const call = (toolUseId: string, extra: Partial<Extract<ChatEvent, { type: "tool_use" }>> = {}): ChatEvent => ({
  type: "tool_use",
  tool: "Edit",
  input: {},
  toolUseId,
  ...extra,
});

describe("sessionTurns", () => {
  test("a turn is a prompt and every call the answers to it made", () => {
    const turns = sessionTurns([
      user("u1", "add a flag", 1),
      assistant("a1", [call("toolu_1"), { type: "text", content: "done" }, call("toolu_2")], 2),
      assistant("a2", [call("toolu_3")], 3),
      user("u2", "now test it", 4),
      assistant("a3", [call("toolu_4")], 5),
    ]);
    expect(turns.map((t) => [t.n, t.messageId, t.at, t.prompt, t.calls])).toEqual([
      [1, "u1", at(1), "add a flag", ["toolu_1", "toolu_2", "toolu_3"]],
      [2, "u2", at(4), "now test it", ["toolu_4"]],
    ]);
  });

  test("a sub-agent's calls belong to the turn that started it, the ones slimmed away included", () => {
    const agent = call("toolu_agent", {
      tool: "Agent",
      children: [call("toolu_kept", { tool: "Agent", stepIds: ["toolu_deep", "idx:3"] })],
      stepIds: ["toolu_dropped", "toolu_kept", "idx:2"],
    });
    const [turn] = sessionTurns([user("u1", "review it"), assistant("a1", [agent])]);
    expect(turn!.calls).toEqual(["toolu_agent", "toolu_dropped", "toolu_kept", "toolu_deep"]);
  });

  test("injected context and tool results are not turns", () => {
    const turns = sessionTurns([
      user("u1", "first"),
      assistant("a1", [call("toolu_1")]),
      user("u2", "<task-notification>agent finished</task-notification>"),
      assistant("a2", [call("toolu_2")]),
      user("u3", "   "),
      { id: "s1", role: "system", content: "Session resumed", timestamp: at(0) },
    ]);
    expect(turns.map((t) => [t.n, t.calls])).toEqual([[1, ["toolu_1", "toolu_2"]]]);
  });

  test("the prompt is what the user typed: a command as typed, attachments when that is all", () => {
    const turns = sessionTurns([
      user("u1", "<command-name>/review</command-name><command-args>src/a.ts</command-args>"),
      user("u2", "[Attached file: /p/shot.png]\n\nwhat is wrong here"),
      user("u3", "[Attached files:\n/p/a.png\n/p/b.png\n]"),
      user("u4", "```bash\nbun test\n```"),
      user("u5", "Use the planner agent to plan the release"),
    ]);
    expect(turns.map((t) => t.prompt)).toEqual([
      "/review src/a.ts",
      "what is wrong here",
      "2 attached files",
      "bun test",
      "plan the release",
    ]);
  });

  test("turns take the server's number, counted from the session start across compactions", () => {
    const compaction = { trigger: "auto" as const, preTokens: 100, postTokens: 10, savedTokens: 90 };
    const stamp = (n: number) => ({ turnId: `t${n}`, turnN: n });
    // What a chat holds after a compaction: the summary, then the turns after it, numbered on from
    // the turns before it that are not loaded.
    const loaded = [
      user("c2", "a later summary", 0, { compaction }),
      user("u41", "forty-one", 0, stamp(41)),
      assistant("a41", [call("toolu_41")]),
      user("u42", "forty-two", 0, stamp(42)),
    ];
    expect(sessionTurns(loaded).map((t) => [t.messageId, t.n, t.turnId])).toEqual([["u41", 41, "t41"], ["u42", 42, "t42"]]);

    // Expanding the compaction brings older turns in above; no number already shown moves.
    const expanded = [
      user("pc-u39", "thirty-nine", 0, stamp(39)),
      assistant("pc-a39", [call("toolu_39")]),
      user("pc-u40", "forty", 0, stamp(40)),
      ...loaded,
    ];
    expect(sessionTurns(expanded).map((t) => [t.messageId, t.n])).toEqual([["pc-u39", 39], ["pc-u40", 40], ["u41", 41], ["u42", 42]]);
  });

  test("a prompt not numbered yet takes the number after the turn before it", () => {
    const turns = sessionTurns([
      user("u7", "seven", 0, { turnId: "t7", turnN: 7 }),
      assistant("a7", [call("toolu_7")]),
      user("live", "just sent"),
      assistant("streaming-1", [call("toolu_8")]),
    ]);
    expect(turns.map((t) => [t.messageId, t.n, t.calls])).toEqual([["u7", 7, ["toolu_7"]], ["live", 8, ["toolu_8"]]]);
    // With nothing numbered at all, counting starts at 1.
    expect(sessionTurns([user("a", "one"), user("b", "two")]).map((t) => t.n)).toEqual([1, 2]);
  });

  test("a message steered into a running turn stays in that turn", () => {
    const turns = sessionTurns([
      user("u2", "two", 0, { turnId: "T2", turnN: 2 }),
      assistant("a2", [call("toolu_a")]),
      user("steer", "also do this", 0, { turnId: "T2", turnN: 2 }),
      assistant("a2b", [call("toolu_b")]),
    ]);
    expect(turns.map((t) => [t.messageId, t.n, t.calls])).toEqual([["u2", 2, ["toolu_a", "toolu_b"]]]);
  });

  test("a message that did not change is not walked again", () => {
    const a1 = assistant("a1", [call("toolu_1")]);
    const first = sessionTurns([user("u1", "one"), a1]);
    (a1.events as ChatEvent[]).push(call("toolu_late"));
    const second = sessionTurns([user("u1", "one"), a1]);
    expect(first[0]!.calls).toEqual(["toolu_1"]);
    expect(second[0]!.calls).toEqual(["toolu_1"]);
    const replaced = sessionTurns([user("u1", "one"), { ...a1, events: [...a1.events!] }]);
    expect(replaced[0]!.calls).toEqual(["toolu_1", "toolu_late"]);
  });
});

describe("turnsOf", () => {
  const turns = sessionTurns([
    user("u1", "one", 1),
    assistant("a1", [call("toolu_1"), call("toolu_2")]),
    user("u2", "two", 5),
    assistant("a2", [call("toolu_3")]),
  ]);
  const byCall = turnsByCall(turns);

  test("names each turn once, oldest first, and leaves calls of no known turn out", () => {
    expect(turnsOf(["toolu_3", "toolu_2", "toolu_1", "item_9"], byCall).map((t) => t.n)).toEqual([1, 2]);
    expect(turnsOf(["item_9"], byCall)).toEqual([]);
    expect(turnsOf(undefined, byCall)).toEqual([]);
  });

  test("labels a turn by its number", () => {
    expect(turnLabel({ n: 3 })).toBe("Turn 3");
    expect(turnLabel({ n: 312 })).toBe("Turn 312");
  });
});

describe("turnTime", () => {
  test("shows the time alone for today and the date before it", () => {
    const now = new Date(2026, 9, 3, 18, 0);
    const today = new Date(2026, 9, 3, 14, 2).toISOString();
    const before = new Date(2026, 9, 1, 9, 30).toISOString();
    expect(turnTime(today, now)).toMatch(/^\d{1,2}:02( [AP]M)?$/);
    expect(turnTime(before, now)).toMatch(/^Oct 1, \d{1,2}:30( [AP]M)?$/);
    expect(turnTime("not a date", now)).toBe("");
  });
});
