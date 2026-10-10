/**
 * The watch service against a stand-in chat layer: what wakes the Assistant, how often, when a
 * report counts as delivered, what a restart leaves behind, and what goes to a push instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { getAssistantWatch, insertAssistantWatch, listAssistantWatches, updateAssistantWatch } from "../../../src/services/assistant-hub/assistant-hub-db.ts";
import { createChatLifecycle, type ChatLifecycleEvents } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { CHAT_BUSY, type ChatControl, type LiveChatState, type SendUserMessageOpts } from "../../../src/services/chat-control/chat-control.ts";
import {
  AssistantWatchService, MAX_REPORT_ATTEMPTS, MAX_WATCH_TURNS_PER_HOUR, WATCH_TTL_MS,
} from "../../../src/services/assistant-watch/assistant-watch.service.ts";
import { WATCH_OPENER } from "../../../src/services/assistant-watch/watch-event-text.ts";
import { watchEvents, type WatchEvents } from "../../../src/services/assistant-watch/watch-events.ts";
import { NOTIFY_KINDS, writeWatchState } from "../../../src/services/assistant-watch/watch-state.ts";
import type { NotificationPayload } from "../../../src/services/notification.service.ts";
import type { NotificationSuppressor } from "../../../src/services/chat-control/notification-suppressor.ts";
import type { TraceTurnEnd } from "../../../src/services/assistant-watch/watch-turn-end-reader.ts";

const ASSISTANT = "asst-1";
const HOUR = 60 * 60_000;

/** A chat layer that records what it is sent and answers from a table of live states. */
function fakeControl() {
  const sent: Array<{ sessionId: string; text: string; opts: SendUserMessageOpts }> = [];
  const live = new Map<string, Partial<LiveChatState>>();
  let reply: (sessionId: string) => { ok: true; sessionId: string } | { ok: false; error: string } = (sessionId) => ({ ok: true, sessionId });
  const control: ChatControl = {
    async sendUserMessage(sessionId, text, opts) { sent.push({ sessionId, text, opts }); return reply(sessionId); },
    answerApproval: () => "stale",
    cancelTurn: () => false,
    liveState: (sessionId) => {
      const s = live.get(sessionId);
      return s ? { phase: "idle", running: false, projectName: "", providerId: "claude", queuedCards: 0, ...s } as LiveChatState : null;
    },
    listLive: () => [],
  };
  return { control, sent, live, setReply: (fn: typeof reply) => { reply = fn; } };
}

function harness(opts: { bound?: string[]; turnEnd?: (id: string, since: number) => TraceTurnEnd | null } = {}) {
  let clock = Date.UTC(2026, 9, 11, 1, 0, 0);
  const lifecycle = createChatLifecycle();
  const chat = fakeControl();
  const pushes: NotificationPayload[] = [];
  const suppressors: NotificationSuppressor[] = [];
  const service = new AssistantWatchService({
    control: () => chat.control,
    lifecycle,
    now: () => clock,
    title: (id) => `Title of ${id}`,
    provider: () => "claude",
    boundChats: () => opts.bound ?? [],
    notify: (p) => pushes.push(p),
    turnEndSince: opts.turnEnd ?? (() => null),
    addSuppressor: (fn) => { suppressors.push(fn); return () => {}; },
    tickMs: 3_600_000,
    retryDelayMs: 0,
  });
  const emit = <K extends keyof ChatLifecycleEvents>(name: K, payload: ChatLifecycleEvents[K]) => lifecycle.emit(name, payload);
  const ended = (sessionId: string, outcome: "done" | "stopped" | "failed" = "done", finalText?: string) =>
    emit("turn_ended", { sessionId, outcome, ...(finalText ? { finalText } : {}), projectName: "p", providerId: "claude" });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const watch = (target: string, notifyOn = [...NOTIFY_KINDS]) => service.watch({
    assistantSessionId: ASSISTANT, targetSessionId: target, targetProject: "api", targetProvider: "claude", notifyOn,
  });
  return {
    service, chat, pushes, suppressors, emit, ended, settle, watch,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
  };
}

function heard<K extends keyof WatchEvents>(name: K): { list: Array<WatchEvents[K]>; stop: () => void } {
  const list: Array<WatchEvents[K]> = [];
  return { list, stop: watchEvents.on(name, (p) => list.push(p)) };
}

let services: AssistantWatchService[] = [];
const started = (h: ReturnType<typeof harness>) => { h.service.start(); services.push(h.service); return h; };

beforeEach(() => { getDb().run("DELETE FROM assistant_watches"); });
afterEach(() => { for (const s of services) s.stop(); services = []; });

describe("a watched chat ending", () => {
  it("wakes the Assistant once with the fixed opener, and counts it delivered only when the turn answers", async () => {
    const h = started(harness());
    const reported = heard("watch_reported");
    try {
      const w = h.watch("target-a");
      expect(w.ok && "watch" in w && w.watch.status).toBe("active");
      h.ended("target-a", "done", "Refactor finished; 12 files changed.");
      await h.settle();
      expect(h.chat.sent).toHaveLength(1);
      const [send] = h.chat.sent;
      expect(send!.sessionId).toBe(ASSISTANT);
      expect(send!.text).toBe(WATCH_OPENER);
      expect(send!.opts.origin).toBe("watch");
      expect(send!.opts.watchEvents).toEqual([expect.objectContaining({ kind: "done", sessionId: "target-a", finalText: "Refactor finished; 12 files changed." })]);
      const id = listAssistantWatches()[0]!.id;
      expect(getAssistantWatch(id)!.deliveredAt).toBeNull();
      // While the watch turn runs, the Assistant's own "Chat completed" is held back for our push.
      expect(h.suppressors.some((fn) => fn(ASSISTANT, "done"))).toBe(true);
      expect(h.suppressors.some((fn) => fn(ASSISTANT, "approval"))).toBe(false);

      h.ended(ASSISTANT, "done", "Chat “Title of target-a” in api finished: 12 files changed.");
      await h.settle();
      expect(getAssistantWatch(id)!.deliveredAt).not.toBeNull();
      expect(reported.list).toEqual([expect.objectContaining({ watchId: id, targetSessionId: "target-a", kind: "done" })]);
      expect(h.pushes).toHaveLength(1);
      expect(h.pushes[0]!.title).toBe("Chat finished: Title of target-a");
      expect(h.pushes[0]!.sessionId).toBe(ASSISTANT);
      expect(h.suppressors.some((fn) => fn(ASSISTANT, "done"))).toBe(false);
      // A second end of the same chat is not news: the watch is over.
      h.ended("target-a", "done", "again");
      await h.settle();
      expect(h.chat.sent).toHaveLength(1);
    } finally {
      reported.stop();
    }
  });

  it("sends no push of its own when a Telegram chat talks to the Assistant session", async () => {
    const h = started(harness({ bound: ["777"] }));
    h.watch("target-b");
    h.ended("target-b", "stopped");
    await h.settle();
    expect(h.chat.sent[0]!.opts.watchEvents![0]!.kind).toBe("stopped");
    expect(h.suppressors.some((fn) => fn(ASSISTANT, "done"))).toBe(false);
    h.ended(ASSISTANT, "done", "It stopped.");
    await h.settle();
    expect(h.pushes).toHaveLength(0);
    expect(listAssistantWatches()[0]!.deliveredAt).not.toBeNull();
  });

  it("relays every card of a watched chat without waking the model", async () => {
    const h = started(harness());
    const decisions = heard("watch_decision");
    try {
      h.watch("target-c");
      for (let i = 0; i < 10; i++) {
        h.emit("approval_shown", {
          sessionId: "target-c", projectName: "api", providerId: "claude",
          card: { requestId: `r${i}`, tool: "Bash", input: { command: `echo ${i}` }, isQuestion: false },
        });
      }
      await h.settle();
      expect(h.chat.sent).toHaveLength(0);
      expect(decisions.list.map((d) => d.card.requestId)).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`));
      expect(decisions.list[0]).toEqual(expect.objectContaining({ assistantSessionId: ASSISTANT, targetSessionId: "target-c", targetTitle: "Title of target-c" }));
    } finally {
      decisions.stop();
    }
  });

  it("ends quietly on news nobody asked for", async () => {
    const h = started(harness());
    h.watch("target-d", ["decision"]);
    h.ended("target-d", "done", "ok");
    await h.settle();
    expect(h.chat.sent).toHaveLength(0);
    const [w] = listAssistantWatches();
    expect(w!.status).toBe("fired");
    expect(w!.deliveredAt).not.toBeNull();
  });
});

describe("how often the Assistant is woken", () => {
  it("starts at most six watch turns an hour and merges the rest into the next one", async () => {
    const h = started(harness());
    for (let i = 0; i < 8; i++) h.watch(`target-${i}`);
    for (let i = 0; i < 8; i++) {
      h.ended(`target-${i}`, "done", `answer ${i}`);
      await h.settle();
      // The watch turn answers before the next chat ends.
      if (h.chat.sent.length === i + 1) {
        h.ended(ASSISTANT, "done", `report ${i}`);
        await h.settle();
      }
      h.advance(60_000);
    }
    expect(h.chat.sent).toHaveLength(MAX_WATCH_TURNS_PER_HOUR);
    expect(listAssistantWatches().filter((w) => w.deliveredAt === null)).toHaveLength(2);

    h.advance(HOUR);
    h.service.tick();
    await h.settle();
    expect(h.chat.sent).toHaveLength(MAX_WATCH_TURNS_PER_HOUR + 1);
    expect(h.chat.sent.at(-1)!.opts.watchEvents!.map((e) => e.sessionId)).toEqual(["target-6", "target-7"]);
  });

  it("waits while the Assistant session is busy, then reports once it is idle", async () => {
    const h = started(harness());
    h.chat.live.set(ASSISTANT, { phase: "streaming", running: true });
    h.watch("target-e");
    h.ended("target-e", "done", "done");
    await h.settle();
    expect(h.chat.sent).toHaveLength(0);
    h.chat.live.set(ASSISTANT, { phase: "idle", running: false });
    h.ended(ASSISTANT, "done", "the user's own answer");
    await h.settle();
    expect(h.chat.sent).toHaveLength(1);
  });

  it("treats a busy refusal as waiting, not as a failure", async () => {
    const h = started(harness());
    h.chat.setReply(() => ({ ok: false, error: CHAT_BUSY }));
    h.watch("target-f");
    h.ended("target-f", "done", "done");
    await h.settle();
    expect(h.chat.sent).toHaveLength(1);
    expect(listAssistantWatches()[0]!.eventJson).not.toContain('"attempts"');
  });
});

describe("a report that does not get written", () => {
  it("tries three times, then pushes a notification naming the chat", async () => {
    const h = started(harness({ bound: ["999"] }));
    h.watch("target-g");
    h.ended("target-g", "done", "Migration applied.");
    await h.settle();
    for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt++) {
      expect(h.chat.sent).toHaveLength(attempt);
      h.ended(ASSISTANT, attempt === 2 ? "done" : "failed"); // a "done" with no text is no report either
      await h.settle();
      h.service.tick();
      await h.settle();
    }
    expect(h.chat.sent).toHaveLength(MAX_REPORT_ATTEMPTS);
    const [w] = listAssistantWatches();
    expect(w!.deliveredAt).not.toBeNull();
    // Bound or not: nothing else will ever tell the user.
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toEqual(expect.objectContaining({
      title: "Chat finished: Title of target-g", sessionId: "target-g", project: "api", detail: "Migration applied.",
    }));
  });

  it("closes the news without a retry or a push when the user stops the watch turn", async () => {
    const h = started(harness());
    const reported = heard("watch_reported");
    try {
      h.watch("target-stop");
      h.ended("target-stop", "done", "All green.");
      await h.settle();
      expect(h.chat.sent).toHaveLength(1);
      h.emit("turn_ended", { sessionId: ASSISTANT, outcome: "stopped", cancelledBy: "ws", projectName: "", providerId: "claude" });
      await h.settle();
      h.service.tick();
      await h.settle();
      expect(h.chat.sent).toHaveLength(1);
      const [w] = listAssistantWatches();
      expect(w!.deliveredAt).not.toBeNull();
      expect(w!.eventJson).not.toContain('"attempts"');
      expect(h.pushes).toHaveLength(0);
      expect(reported.list).toHaveLength(0);
    } finally {
      reported.stop();
    }
  });

  it("still retries a watch turn that failed on its own", async () => {
    const h = started(harness());
    h.watch("target-crash");
    h.ended("target-crash", "done", "x");
    await h.settle();
    h.emit("turn_ended", { sessionId: ASSISTANT, outcome: "failed", error: "provider crashed", projectName: "", providerId: "claude" });
    await h.settle();
    expect(listAssistantWatches()[0]!.eventJson).toContain('"attempts":1');
    expect(listAssistantWatches()[0]!.deliveredAt).toBeNull();
  });

  it("counts a watch turn that could not start as a failed attempt", async () => {
    const h = started(harness());
    h.chat.setReply(() => ({ ok: false, error: "The chat could not be resumed" }));
    h.watch("target-h");
    h.ended("target-h", "done", "x");
    await h.settle();
    expect(listAssistantWatches()[0]!.eventJson).toContain('"attempts":1');
  });
});

describe("watches across a restart and over time", () => {
  function storedWatch(target: string, armedRunning: boolean, createdAt: number) {
    const w = insertAssistantWatch({
      id: crypto.randomUUID(), assistantSessionId: ASSISTANT, targetSessionId: target, targetProject: "api",
      targetProvider: "claude", createdAt, expiresAt: createdAt + WATCH_TTL_MS, armedRunning,
    });
    updateAssistantWatch(w.id, { eventJson: writeWatchState({ notifyOn: [...NOTIFY_KINDS] }) });
    return w.id;
  }

  it("fires a watch whose chat was running from the trace: finished, or interrupted", async () => {
    const created = Date.UTC(2026, 9, 11, 0, 30, 0);
    const finished = storedWatch("ran-to-end", true, created);
    const cut = storedWatch("cut-off", true, created);
    const idle = storedWatch("idle", false, created);
    const h = started(harness({
      turnEnd: (id, since) => (id === "ran-to-end" && since === created ? { kind: "done", at: created + 1000 } : null),
    }));
    await h.settle();
    expect(getAssistantWatch(finished)!.lastEvent).toBe("done");
    expect(getAssistantWatch(cut)!.lastEvent).toBe("interrupted");
    expect(getAssistantWatch(idle)!.status).toBe("active");
    // Both reported in one turn.
    expect(h.chat.sent).toHaveLength(1);
    expect(h.chat.sent[0]!.opts.watchEvents!.map((e) => e.kind).sort()).toEqual(["done", "interrupted"]);
  });

  it("delivers news recorded before a restart that was never reported", async () => {
    const id = storedWatch("old", false, Date.UTC(2026, 9, 11, 0, 0, 0));
    updateAssistantWatch(id, {
      status: "fired", lastEvent: "done", firedAt: 1,
      eventJson: writeWatchState({ notifyOn: [...NOTIFY_KINDS], event: { watchId: id, kind: "done", project: "api", sessionId: "old", providerId: "claude", title: "Old", at: 1 } }),
    });
    const h = started(harness());
    await h.settle();
    expect(h.chat.sent).toHaveLength(1);
  });

  it("expires after 24 hours and wakes the Assistant once to say so", async () => {
    const h = started(harness());
    h.watch("slow");
    h.advance(WATCH_TTL_MS + 1);
    h.service.tick();
    await h.settle();
    const [w] = listAssistantWatches();
    expect(w!.status).toBe("expired");
    expect(h.chat.sent).toHaveLength(1);
    expect(h.chat.sent[0]!.opts.watchEvents![0]!.kind).toBe("expired");
    h.service.tick();
    await h.settle();
    expect(h.chat.sent).toHaveLength(1);
  });

  it("marks an idle chat's watch as armed once its next run starts", () => {
    const h = started(harness());
    h.watch("idle-then-busy");
    expect(listAssistantWatches()[0]!.armedRunning).toBe(false);
    h.emit("user_message", { sessionId: "idle-then-busy", text: "go", origin: "ws", imageCount: 0, projectName: "api", providerId: "claude" });
    expect(listAssistantWatches()[0]!.armedRunning).toBe(true);
  });
});

describe("setting a watch", () => {
  it("answers at once for a chat that already finished after the user asked", () => {
    const h = started(harness({ turnEnd: (_id, since) => ({ kind: "done", at: since + 5 }) }));
    h.emit("user_message", { sessionId: ASSISTANT, text: "tell me when it is done", origin: "telegram", imageCount: 0, projectName: "", providerId: "claude" });
    const result = h.watch("finished-already");
    expect(result).toEqual({ ok: true, alreadyEnded: expect.objectContaining({ kind: "done" }) });
    expect(listAssistantWatches()).toHaveLength(0);
  });

  it("watches a running chat as armed and an idle one until its next run", () => {
    const h = started(harness());
    h.chat.live.set("running", { phase: "streaming", running: true });
    h.watch("running");
    h.watch("idle");
    const byTarget = Object.fromEntries(listAssistantWatches().map((w) => [w.targetSessionId, w.armedRunning]));
    expect(byTarget).toEqual({ running: true, idle: false });
  });

  it("returns the existing watch for the same chat, and refuses a 21st", () => {
    const h = started(harness());
    for (let i = 0; i < 20; i++) expect(h.watch(`t${i}`).ok).toBe(true);
    const again = h.watch("t0");
    expect(again.ok && "created" in again && again.created).toBe(false);
    const over = h.watch("t20");
    expect(over.ok).toBe(false);
  });

  it("is refused while the service is not running", () => {
    const h = harness();
    expect(h.watch("x")).toEqual({ ok: false, error: expect.stringContaining("not available") });
  });

  it("stops a watch and its unreported news", async () => {
    const h = started(harness());
    h.chat.live.set(ASSISTANT, { phase: "streaming", running: true });
    const w = h.watch("to-stop");
    const watchId = w.ok && "watch" in w ? w.watch.watchId : "";
    h.ended("to-stop", "done", "x");
    await h.settle();
    expect(h.service.unwatch(ASSISTANT, watchId)).toEqual({ ok: true, watch: expect.objectContaining({ status: "cancelled" }) });
    expect(h.service.unwatch("someone-else", watchId).ok).toBe(false);
    h.chat.live.set(ASSISTANT, { phase: "idle", running: false });
    h.service.tick();
    await h.settle();
    expect(h.chat.sent).toHaveLength(0);
  });
});
