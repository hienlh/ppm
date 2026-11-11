/**
 * The one door for turns PPM starts in an Assistant session: the hourly cap shared by every kind of
 * news, batching, waiting for a busy session, quiet hours with an urgent exception, and how each
 * source hears whether its news was told.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { createChatLifecycle } from "../../../src/services/chat-control/chat-lifecycle.ts";
import type { ChatControl, LiveChatState, SendUserMessageOpts } from "../../../src/services/chat-control/chat-control.ts";
import { AssistantWakeQueue, type WakeItem, type WakeSource } from "../../../src/services/assistant-wake/assistant-wake-queue.ts";
import { NEWS_OPENER } from "../../../src/services/assistant-wake/wake-news-text.ts";
import { WAKE_TURNS_PER_HOUR } from "../../../src/shared/assistant-limits.ts";

const MAIN = "asst-main";

function fakeSource(name: string) {
  const items: WakeItem[] = [];
  const log: string[] = [];
  const source: WakeSource = {
    name,
    sessions: () => (items.length ? [MAIN] : []),
    pending: (id) => (id === MAIN ? [...items] : []),
    delivered: (_id, done) => { log.push(`delivered:${done.map((i) => i.key).join(",")}`); remove(done); },
    ended: (_id, done) => { log.push("ended"); remove(done); },
    failed: (_id, done) => { log.push(`failed:${done.length}`); return true; },
  };
  const remove = (done: WakeItem[]) => {
    for (const d of done) items.splice(items.findIndex((i) => i.key === d.key), 1);
  };
  let n = 0;
  const add = (urgent = false) => {
    const key = `${name}-${++n}`;
    items.push({ key, at: n, urgent, news: { kind: "report", key, project: "api", sessionId: "mgr", at: n, reportKind: urgent ? "urgent" : "done", title: key } });
  };
  return { source, items, log, add };
}

function harness(quiet = false) {
  let clock = Date.UTC(2026, 10, 10, 9, 0, 0);
  const lifecycle = createChatLifecycle();
  const sent: Array<{ text: string; opts: SendUserMessageOpts }> = [];
  const live = new Map<string, Partial<LiveChatState>>();
  const control: ChatControl = {
    async sendUserMessage(sessionId, text, opts) { sent.push({ text, opts }); return { ok: true, sessionId }; },
    answerApproval: () => "stale",
    cancelTurn: () => false,
    liveState: (id) => (live.has(id) ? { phase: "idle", running: false, projectName: "", providerId: "claude", queuedCards: 0, ...live.get(id) } as LiveChatState : null),
    listLive: () => [],
  };
  let isQuiet = quiet;
  const queue = new AssistantWakeQueue({ control: () => control, lifecycle, now: () => clock, provider: () => "claude", quiet: () => isQuiet, tickMs: 3_600_000, retryDelayMs: 0 });
  queue.start();
  queues.push(queue);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const endTurn = (finalText = "Noted.", cancelledBy?: "ws") => lifecycle.emit("turn_ended", {
    sessionId: MAIN, outcome: cancelledBy ? "stopped" : "done", finalText, projectName: "", providerId: "claude", ...(cancelledBy ? { cancelledBy } : {}),
  });
  return { queue, sent, live, settle, endTurn, advance: (ms: number) => { clock += ms; }, setQuiet: (q: boolean) => { isQuiet = q; } };
}

let queues: AssistantWakeQueue[] = [];
afterEach(() => { for (const q of queues) q.stop(); queues = []; });

describe("the wake queue", () => {
  it("batches news from every source into one turn, and tells each source it was delivered", async () => {
    const h = harness();
    const cards = fakeSource("cards");
    const replies = fakeSource("late-replies");
    h.queue.addSource(cards.source);
    h.queue.addSource(replies.source);
    cards.add();
    replies.add();
    h.queue.schedule(MAIN);
    await h.settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe(NEWS_OPENER);
    expect(h.sent[0]!.opts.origin).toBe("watch");
    expect(h.sent[0]!.opts.wakeNews?.map((n) => n.key)).toEqual(["cards-1", "late-replies-1"]);
    expect(h.queue.carrying(MAIN).sort()).toEqual(["cards", "late-replies"]);
    h.endTurn();
    await h.settle();
    expect(cards.log).toEqual(["delivered:cards-1"]);
    expect(replies.log).toEqual(["delivered:late-replies-1"]);
  });

  it("starts at most the hourly cap of turns, and the next one once the hour has passed", async () => {
    const h = harness();
    const cards = fakeSource("cards");
    h.queue.addSource(cards.source);
    for (let i = 0; i < WAKE_TURNS_PER_HOUR + 1; i++) {
      cards.add();
      h.queue.schedule(MAIN);
      await h.settle();
      if (h.sent.length > i) { h.endTurn(); await h.settle(); }
    }
    expect(h.sent).toHaveLength(WAKE_TURNS_PER_HOUR);
    expect(cards.items).toHaveLength(1);
    h.advance(60 * 60_000 + 1);
    h.queue.tick();
    await h.settle();
    expect(h.sent).toHaveLength(WAKE_TURNS_PER_HOUR + 1);
  });

  it("waits while the session runs a turn or shows a card", async () => {
    const h = harness();
    const cards = fakeSource("cards");
    h.queue.addSource(cards.source);
    h.live.set(MAIN, { running: true, phase: "streaming" });
    cards.add();
    h.queue.schedule(MAIN);
    await h.settle();
    expect(h.sent).toHaveLength(0);
    h.live.set(MAIN, { running: false });
    h.queue.tick();
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it("starts nothing during quiet hours unless something urgent waits", async () => {
    const h = harness(true);
    const cards = fakeSource("cards");
    h.queue.addSource(cards.source);
    cards.add();
    h.queue.schedule(MAIN);
    await h.settle();
    expect(h.sent).toHaveLength(0);
    cards.add(true);
    h.queue.schedule(MAIN);
    await h.settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.opts.wakeNews).toHaveLength(2);
  });

  it("keeps the hourly cap across a restart: a new queue reads the turns the last one started", async () => {
    let stored: string | null = null;
    const turnLog = { load: () => stored, save: (json: string) => { stored = json; } };
    const clock = Date.UTC(2026, 10, 10, 9, 0, 0);
    const lifecycle = createChatLifecycle();
    const sent: string[] = [];
    const control = {
      async sendUserMessage(sessionId: string, text: string) { sent.push(text); return { ok: true, sessionId }; },
      answerApproval: () => "stale", cancelTurn: () => false, liveState: () => null, listLive: () => [],
    } as unknown as ChatControl;
    const make = () => {
      const q = new AssistantWakeQueue({ control: () => control, lifecycle, now: () => clock, provider: () => "claude", quiet: () => false, tickMs: 3_600_000, retryDelayMs: 0, turnLog });
      q.start();
      queues.push(q);
      return q;
    };
    const cards = fakeSource("cards");
    for (let i = 0; i < WAKE_TURNS_PER_HOUR; i++) {
      const q = make(); // every turn in a new process, as in a restart loop
      q.addSource(cards.source);
      cards.add(true);
      q.schedule(MAIN);
      await new Promise((r) => setTimeout(r, 5));
      q.stop();
    }
    expect(sent).toHaveLength(WAKE_TURNS_PER_HOUR);
    const last = make();
    last.addSource(cards.source);
    cards.add(true);
    last.schedule(MAIN);
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toHaveLength(WAKE_TURNS_PER_HOUR);
  });

  it("holds non-urgent news when quiet hours cannot be read, and still sends urgent news", async () => {
    const h = harness();
    const cards = fakeSource("cards");
    const broken = new AssistantWakeQueue({
      control: () => ({ ...({} as ChatControl), sendUserMessage: async (sessionId: string, text: string, opts: SendUserMessageOpts) => { h.sent.push({ text, opts }); return { ok: true, sessionId }; }, liveState: () => null } as ChatControl),
      lifecycle: createChatLifecycle(), now: () => Date.now(), provider: () => "claude", tickMs: 3_600_000,
      quiet: () => { throw new Error("settings unreadable"); },
    });
    broken.start();
    queues.push(broken);
    broken.addSource(cards.source);
    cards.add();
    broken.schedule(MAIN);
    await h.settle();
    expect(h.sent).toHaveLength(0);
    cards.add(true);
    broken.schedule(MAIN);
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it("reports a turn without an answer as failed, and one the user stopped as ended", async () => {
    const h = harness();
    const cards = fakeSource("cards");
    h.queue.addSource(cards.source);
    cards.add();
    h.queue.schedule(MAIN);
    await h.settle();
    h.endTurn("");
    await h.settle();
    expect(cards.log[0]).toBe("failed:1");
    // retried at once (no delay in this harness)
    expect(h.sent).toHaveLength(2);
    h.endTurn("", "ws");
    await h.settle();
    expect(cards.log).toContain("ended");
  });
});
