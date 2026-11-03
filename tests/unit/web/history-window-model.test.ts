/**
 * The history window's state: entering it from a jump, growing it page by page in both directions
 * with at most 30 turns kept, and the one check that decides when the live list has caught up.
 */
import { describe, expect, test } from "bun:test";
import {
  canMergeToLive, historyWindowReducer, LIVE_VIEW, MAX_WINDOW_TURNS, type HistoryView, type TurnWindowPage, type WindowView,
} from "../../../src/web/lib/history-window-model";
import type { ChatMessage } from "../../../src/types/chat";

const at = "2026-11-04T10:00:00.000Z";
const id = (n: number) => `T${n}`;

/** Turn n as the window route returns it: prompt, answer; turn 5 also holds a compaction marker. */
function turnMessages(n: number): ChatMessage[] {
  const out: ChatMessage[] = [
    { id: `u${n}`, role: "user", content: `ask ${n}`, timestamp: at, turnId: id(n), turnN: n },
    { id: `a${n}`, role: "assistant", content: `answer ${n}`, timestamp: at, turnId: id(n), turnN: n },
  ];
  if (n === 5) out.push({ id: "c5", role: "system", content: "(context compacted here)", timestamp: at, synthetic: true });
  return out;
}

function page(from: number, to: number, total = 100): TurnWindowPage {
  const ns = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return {
    sessionId: "s",
    turns: ns.map((n) => ({ turnId: id(n), n, status: "complete" as const })),
    messages: ns.flatMap(turnMessages),
    hasOlder: from > 1,
    hasNewer: to < total,
    latestTurnId: id(total),
  };
}

const win = (v: HistoryView): WindowView => {
  if (v.mode !== "window") throw new Error("not in window mode");
  return v;
};
const ns = (v: HistoryView) => win(v).turns.map((t) => t.n);

describe("historyWindowReducer", () => {
  test("a jump enters the window around its turn; another jump lands again", () => {
    const v = win(historyWindowReducer(LIVE_VIEW, { type: "enter", page: page(48, 53), targetTurnId: id(50) }));
    expect(ns(v)).toEqual([48, 49, 50, 51, 52, 53]);
    expect([v.hasOlder, v.hasNewer, v.targetTurnId, v.landing]).toEqual([true, true, id(50), 1]);
    const again = win(historyWindowReducer(v, { type: "enter", page: page(48, 53), targetTurnId: id(50) }));
    expect(again.landing).toBe(2);
    expect(historyWindowReducer(again, { type: "exit" })).toEqual(LIVE_VIEW);
  });

  test("an older page goes on top and a newer one at the bottom, each turn once", () => {
    let v: HistoryView = historyWindowReducer(LIVE_VIEW, { type: "enter", page: page(48, 53), targetTurnId: id(50) });
    v = historyWindowReducer(v, { type: "loading", direction: "older" });
    expect(win(v).loadingOlder).toBe(true);
    // The page overlaps by one turn: it is not drawn twice.
    v = historyWindowReducer(v, { type: "loaded", direction: "older", page: page(45, 48) });
    expect(ns(v)).toEqual([45, 46, 47, 48, 49, 50, 51, 52, 53]);
    expect(win(v).messages.map((m) => m.id).filter((m) => m === "u48")).toEqual(["u48"]);
    expect(win(v).loadingOlder).toBe(false);
    v = historyWindowReducer(v, { type: "loaded", direction: "newer", page: page(54, 56) });
    expect(ns(v).slice(-3)).toEqual([54, 55, 56]);
  });

  test("a compaction marker stays with the turn it sits in", () => {
    let v: HistoryView = historyWindowReducer(LIVE_VIEW, { type: "enter", page: page(6, 8), targetTurnId: id(7) });
    v = historyWindowReducer(v, { type: "loaded", direction: "older", page: page(4, 5) });
    expect(win(v).messages.map((m) => m.id)).toEqual(["u4", "a4", "u5", "a5", "c5", "u6", "a6", "u7", "a7", "u8", "a8"]);
  });

  test("past 30 turns the far end is dropped, and the window knows there is more that way", () => {
    let v: HistoryView = historyWindowReducer(LIVE_VIEW, { type: "enter", page: page(40, 49), targetTurnId: id(45) });
    for (let from = 50; from < 90; from += 10) v = historyWindowReducer(v, { type: "loaded", direction: "newer", page: page(from, from + 9) });
    expect(win(v).turns.length).toBe(MAX_WINDOW_TURNS);
    expect(ns(v)[0]).toBe(60);
    expect(win(v).hasOlder).toBe(true);
    expect(win(v).messages[0]!.id).toBe("u60");
    for (let to = 59; to > 30; to -= 10) v = historyWindowReducer(v, { type: "loaded", direction: "older", page: page(to - 9, to) });
    expect(win(v).turns.length).toBe(MAX_WINDOW_TURNS);
    expect(ns(v)[0]).toBe(30);
    expect(win(v).hasNewer).toBe(true);
  });

  test("a failed page is remembered until the next try, and nothing changes in live mode", () => {
    let v: HistoryView = historyWindowReducer(LIVE_VIEW, { type: "enter", page: page(1, 3), targetTurnId: id(1) });
    v = historyWindowReducer(v, { type: "loading", direction: "newer" });
    v = historyWindowReducer(v, { type: "failed", direction: "newer", error: "offline" });
    expect([win(v).loadingNewer, win(v).loadError]).toEqual([false, { direction: "newer", message: "offline" }]);
    v = historyWindowReducer(v, { type: "loading", direction: "newer" });
    expect(win(v).loadError).toBeNull();
    expect(historyWindowReducer(LIVE_VIEW, { type: "loaded", direction: "older", page: page(1, 2) })).toBe(LIVE_VIEW);
  });
});

describe("canMergeToLive", () => {
  const live = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => turnMessages(from + i)).flat();
  const reached = (from: number, to: number, total: number) => win(historyWindowReducer(LIVE_VIEW, { type: "enter", page: page(from, to, total), targetTurnId: id(from) }));

  test("only once the live list holds the window's last turn whole", () => {
    // Far back in the session: the live list has none of it.
    expect(canMergeToLive(reached(10, 15, 20), live(18, 20), false)).toBe(false);
    // Not at the end of the session, but the live list already goes past its last turn.
    expect(canMergeToLive(reached(10, 15, 20), live(15, 20), false)).toBe(true);
    // The live list's first page starts after the window's last turn.
    expect(canMergeToLive(reached(15, 20, 20), live(21, 22), false)).toBe(false);
    // A later turn follows it in the live list.
    expect(canMergeToLive(reached(15, 19, 20), live(17, 20), true)).toBe(true);
    // It is the newest turn and nothing is streaming.
    expect(canMergeToLive(reached(15, 20, 20), live(17, 20), false)).toBe(true);
  });

  test("not while the live list is streaming that turn, nor when only its tail is loaded", () => {
    expect(canMergeToLive(reached(15, 20, 20), live(17, 20), true)).toBe(false);
    const tailOnly = live(17, 20).filter((m) => m.id !== "u20");
    expect(canMergeToLive(reached(15, 20, 20), tailOnly, false)).toBe(false);
  });

  test("a prompt just sent here, not stamped yet, ends the turn before it", () => {
    const sent: ChatMessage = { id: "local", role: "user", content: "next", timestamp: at };
    expect(canMergeToLive(reached(15, 20, 20), [...live(17, 20), sent], true)).toBe(true);
  });
});
