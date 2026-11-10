/**
 * A watched chat's approval card in quiet hours: held, sent when they end if the chat still waits
 * on it, skipped if it was answered meanwhile; outside quiet hours it goes at once.
 */
import { describe, expect, it } from "bun:test";
import { connectChat, disconnectChat, freshChat } from "./bridge-test-kit.ts";
import { AssistantTelegramRelay } from "../../../../src/services/assistant-telegram/assistant-telegram-relay.ts";
import { createQuietHold } from "../../../../src/services/assistant-telegram/assistant-telegram-quiet-hold.ts";
import type { WatchEvents } from "../../../../src/services/assistant-watch/watch-events.ts";
import type { RelayedCard } from "../../../../src/services/assistant-telegram/assistant-telegram-cards.ts";

type Decision = WatchEvents["watch_decision"];

function fakeQuiet(quietUntil: number | null) {
  let now = 0;
  let until = quietUntil;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const waiting = new Set<string>();
  return {
    waiting,
    deps: {
      clock: { now: () => now, setTimer: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } },
      quietEnd: () => (until !== null && now < until ? until : null),
      stillWaiting: (_s: string, requestId: string) => waiting.has(requestId),
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
    },
    endQuietAt(at: number | null) { until = at; },
  };
}

const decision = (requestId: string): Decision => ({
  watchId: "w", assistantSessionId: "a", targetSessionId: "chat-1", targetProject: "api", targetProvider: "claude", targetTitle: "Deploy",
  card: { requestId, tool: "Bash", input: { command: "ls" }, isQuestion: false },
});

describe("the quiet hold", () => {
  it("sends at once outside quiet hours", () => {
    const q = fakeQuiet(null);
    const sent: string[] = [];
    const hold = createQuietHold<Decision>(q.deps, (d) => sent.push(d.card.requestId));
    expect(hold.offer(decision("r1"))).toBe(false);
    expect(sent).toEqual([]);
  });

  it("holds in quiet hours and sends at their end only what still waits", () => {
    const q = fakeQuiet(60 * 60_000);
    const sent: string[] = [];
    const hold = createQuietHold<Decision>(q.deps, (d) => sent.push(d.card.requestId));
    expect(hold.offer(decision("r1"))).toBe(true);
    expect(hold.offer(decision("r2"))).toBe(true);
    expect(hold.offer(decision("r1"))).toBe(true);
    q.waiting.add("r2");
    q.advance(30 * 60_000);
    expect(sent).toEqual([]);
    q.advance(30 * 60_000);
    expect(sent).toEqual(["r2"]);
    expect(hold.size()).toBe(0);
  });

  it("waits again when quiet hours were extended meanwhile, and drops everything on clear", () => {
    const q = fakeQuiet(60 * 60_000);
    const sent: string[] = [];
    const hold = createQuietHold<Decision>(q.deps, (d) => sent.push(d.card.requestId));
    hold.offer(decision("r1"));
    q.waiting.add("r1");
    q.endQuietAt(2 * 60 * 60_000);
    q.advance(60 * 60_000);
    expect(sent).toEqual([]);
    hold.clear();
    q.advance(60 * 60_000);
    expect(sent).toEqual([]);
  });
});

describe("the relay in quiet hours", () => {
  it("holds a watched chat's card and relays it at the end, to the chats bound then", () => {
    const q = fakeQuiet(60 * 60_000);
    const relayed: Array<{ chatId: string; card: RelayedCard }> = [];
    let listener: ((p: Decision) => void) | null = null;
    const chat = connectChat(freshChat());
    const relay = new AssistantTelegramRelay({
      queue: {} as never,
      relayCard: (chatId, card) => relayed.push({ chatId, card }),
      chatLink: async () => "",
      boundChats: () => [chat],
      connectedChats: () => [chat],
      events: { on: ((name: string, fn: (p: Decision) => void) => { if (name === "watch_decision") listener = fn; return () => {}; }) as never },
      quiet: q.deps,
    });
    relay.attach();
    try {
      listener!(decision("r1"));
      expect(relayed).toEqual([]);
      q.waiting.add("r1");
      q.advance(60 * 60_000);
      expect(relayed.map((r) => [r.chatId, r.card.card.requestId])).toEqual([[chat, "r1"]]);
    } finally {
      relay.detach();
      disconnectChat(chat);
    }
  });
});
