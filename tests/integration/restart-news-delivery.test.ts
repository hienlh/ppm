/**
 * Restart news from the session trace to the Assistant and on to a manager chat, in one process:
 * the real trace database (scratch `PPM_HOME`), both scans, the stored news merged across two
 * restarts, the real restart source and wake queue with the hourly cap already spent, and the
 * secret check a message from that wake turn goes through. Only the chat control is a stand-in.
 *
 * The timeline is made up, shaped like 16/11/2026: an upgrade at 16:22 left nobody told, then the
 * machine rebooted at 18:19 while two chats carried on by themselves after their shells were killed.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { closeTraceDb, getTraceDb } from "../../src/services/session-trace/session-trace-db.ts";
import { appendBatch } from "../../src/services/session-trace/session-trace-store.ts";
import { createChatLifecycle } from "../../src/services/chat-control/chat-lifecycle.ts";
import type { ChatControl, SendUserMessageOpts } from "../../src/services/chat-control/chat-control.ts";
import { AssistantWakeQueue, type WakeItem, type WakeSource } from "../../src/services/assistant-wake/assistant-wake-queue.ts";
import { findInterruptedChats } from "../../src/services/restart-news/interrupted-chats.ts";
import { findBackgroundWorkChats, withKilledTasks, type BackgroundWorkDeps } from "../../src/services/restart-news/background-work-chats.ts";
import {
  addRestartNews, createRestartNewsSource, pendingRestartNews, restartTextCarried, type RestartNewsStore,
} from "../../src/services/restart-news/restart-news-source.ts";
import { restartNewsEntry } from "../../src/services/restart-news/restart-news-text.ts";
import { looksLikeSecret } from "../../src/services/session-collab/assistant-send-guards.ts";
import { WAKE_TURNS_PER_HOUR } from "../../src/shared/assistant-limits.ts";

const MAIN = "asst-main";
// Recent, so the 24-hour expiry keeps it whenever the suite runs.
const DAY = new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 10);
const at = (hms: string) => Date.parse(`${DAY}T${hms}Z`);
const queues: AssistantWakeQueue[] = [];

afterEach(() => { for (const q of queues.splice(0)) q.stop(); });
afterAll(() => closeTraceDb());

type Event = { type: string; [k: string]: unknown };
function trace(traceId: string, rows: Array<[string, Event]>): void {
  // As the recorder writes them: a turn's rows carry its id, rows after a turn's end that no message opened carry none.
  const lastEnd = rows.findLastIndex(([, e]) => e.type === "done");
  appendBatch(rows.map(([hms, event], i) => ({
    traceId, turnId: i > lastEnd && lastEnd >= 0 ? null : "t", ts: at(hms), source: event.type === "user_message" ? "server" : "agent", origin: "ws",
    providerId: "claude", refId: null, type: event.type, payloadJson: JSON.stringify(event),
  })));
}
const user = (text: string): Event => ({ type: "user_message", text });
const done: Event = { type: "done", sessionId: "s" };
const shell = (id: string, description: string): Event => ({ type: "tool_use", tool: "Bash", toolUseId: id, input: { command: "sleep 600", description, run_in_background: true } });
const started = (taskId: string, toolUseId: string): Event => ({ type: "system", subtype: "task_started", taskId, taskToolUseId: toolUseId });
const failed = (taskId: string): Event => ({ type: "system", subtype: "task_notification", taskId, taskStatus: "failed" });

const titles: Record<string, string> = {
  "nx-manager": "Merge the PRs when green, then deploy",
  "nx-reset": "Reset password: BE builds the link, drop the redirect",
  "nx-upgrade": "Upgrade the payroll engine",
};

function deps(): BackgroundWorkDeps {
  return {
    traceDb: getTraceDb(),
    sessionOf: (id) => id,
    projectPathOf: (id) => (titles[id] ? "/p/nx" : null),
    projectNameOf: (path) => (path === "/p/nx" ? "nx" : null),
    providerOf: () => "claude",
    titleOf: (id) => titles[id] ?? null,
    isAssistant: () => false,
    isDesign: () => false,
    managerOf: () => "nx-manager",
    parentOf: () => null,
    openCardsOf: () => 0,
  };
}

/** The wake queue with the hour's turns already spent, a pending card of another source, and a stand-in chat control. */
function queueWithCapSpent(store: RestartNewsStore) {
  const lifecycle = createChatLifecycle();
  const sent: Array<{ text: string; opts: SendUserMessageOpts }> = [];
  const control = {
    async sendUserMessage(sessionId: string, text: string, opts: SendUserMessageOpts) { sent.push({ text, opts }); return { ok: true, sessionId }; },
    answerApproval: () => "stale", cancelTurn: () => false, liveState: () => null, listLive: () => [],
  } as unknown as ChatControl;
  const now = Date.now();
  let turns: string | null = JSON.stringify({ [MAIN]: Array.from({ length: WAKE_TURNS_PER_HOUR }, (_, i) => now - (i + 1) * 60_000) });
  const turnLog = { load: () => turns, save: (json: string) => { turns = json; } };
  const queue = new AssistantWakeQueue({ control: () => control, lifecycle, now: () => now, provider: () => "claude", quiet: () => false, tickMs: 3_600_000, turnLog });
  queue.start();
  queues.push(queue);
  queue.addSource(createRestartNewsSource({ store, mainSession: () => MAIN, canonical: (id) => id, managers: () => [{ projectName: "nx", sessionId: "nx-manager" }] }));
  const card: WakeItem = { key: "card-1", at: now, news: { kind: "report", key: "card-1", project: "nx", sessionId: "nx-manager", at: now, reportKind: "done", title: "Shipped" } };
  let cardPending = true;
  const cards: WakeSource = {
    name: "cards", sessions: () => (cardPending ? [MAIN] : []), pending: () => (cardPending ? [card] : []),
    delivered: () => { cardPending = false; }, ended: () => {}, failed: () => true,
  };
  queue.addSource(cards);
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const answer = () => lifecycle.emit("turn_ended", { sessionId: MAIN, outcome: "done", finalText: "Asked the manager.", projectName: "", providerId: "claude" });
  return { queue, sent, settle, answer, turnTimes: () => (JSON.parse(turns ?? "{}")[MAIN] as number[]).length, cardPending: () => cardPending };
}

describe("restart news after a reboot, with the hour's wake turns spent", () => {
  it("finds every chat the reboot stopped, merges both restarts, reaches the Assistant at once, and lets the title through to the manager", async () => {
    // The 16:22 run: an upgrade cut one chat off mid-turn; nobody was told before the reboot.
    trace("nx-upgrade", [["16:20:00", user("Upgrade the payroll engine")], ["16:22:50", { type: "tool_use", tool: "Edit", toolUseId: "e", input: {} }]]);
    // The 18:19 reboot.
    trace("nx-manager", [
      ["18:15:40", user("Keep waiting to merge the PRs when green, then deploy")],
      ["18:15:43", shell("m1", "Keep waiting to merge the PRs when green and deploy")], ["18:15:43.5", started("bxa5v5ube", "m1")],
      ["18:15:48", done], ["18:19:22", failed("bxa5v5ube")],
      ["18:19:26", { type: "tool_use", tool: "Bash", toolUseId: "m2", input: {} }], ["18:19:36", { type: "text", content: "The watcher died" }],
    ]);
    trace("nx-reset", [
      ["17:51:10", user("Wait for both integration runs to finish")],
      ["17:51:15", shell("r1", "Wait for both integration runs to finish")], ["17:51:15.5", started("b0bucruza", "r1")],
      ["17:51:24", done], ["18:19:22", failed("b0bucruza")],
      ["18:19:28", { type: "tool_use", tool: "Bash", toolUseId: "r2", input: {} }], ["18:19:37", { type: "thinking", content: "…" }],
    ]);

    let json: string | null = null;
    const store: RestartNewsStore = { load: () => json, save: (j) => { json = j; } };
    const first = { since: at("14:45:27"), restartAt: at("16:22:57") };
    addRestartNews(store, { at: first.restartAt, kind: "manual", toVersion: "0.26.5" }, findInterruptedChats(deps(), first), findBackgroundWorkChats(deps(), first));
    const second = { since: at("16:22:57"), restartAt: at("18:23:56") };
    const cut = findInterruptedChats(deps(), second);
    const bg = findBackgroundWorkChats(deps(), second, new Set(cut.allIds));
    addRestartNews(store, { at: second.restartAt, kind: "boot", toVersion: "0.26.5", cleanStop: false }, withKilledTasks(cut, bg), bg);

    const pending = pendingRestartNews(store)!;
    expect(pending.restarts.map((r) => r.kind)).toEqual(["manual", "boot"]);
    expect(pending.chats.map((c) => c.sessionId).sort()).toEqual(["nx-manager", "nx-reset", "nx-upgrade"]);
    expect(pending.chats.filter((c) => c.continued).map((c) => c.sessionId).sort()).toEqual(["nx-manager", "nx-reset"]);

    const h = queueWithCapSpent(store);
    h.queue.schedule(MAIN);
    await h.settle();
    // One turn past the cap, carrying the merged restart news only; the card keeps waiting.
    expect(h.sent).toHaveLength(1);
    const news = h.sent[0]!.opts.wakeNews!;
    expect(news.map((n) => n.kind)).toEqual(["restart"]);
    expect(news[0]!.restart!.restarts).toHaveLength(2);
    expect(h.turnTimes()).toBe(WAKE_TURNS_PER_HOUR + 1);
    expect(h.cardPending()).toBe(true);
    const entry = restartNewsEntry([news[0]!.restart!])!;
    expect(entry).toContain("PPM restarted 2 times since you were last told:");
    expect(entry).toContain("Chats cut off mid-turn (3):");
    expect(entry).toContain('Its background work "Keep waiting to merge the PRs when green and deploy" was killed at shutdown');
    expect(entry).toContain('Its background work "Wait for both integration runs to finish" was killed at shutdown');

    // The Assistant's message to the project's manager quotes a title PPM wrote: not a secret.
    const quoted = restartTextCarried(h.queue, MAIN, "nx");
    expect(quoted).toContain(titles["nx-reset"]);
    const message = `PPM restarted (reboot). Please check nx-reset "Reset password: BE builds the link" and nx-upgrade.`;
    expect(looksLikeSecret(message, quoted)).toBe(false);
    expect(looksLikeSecret(message, restartTextCarried(h.queue, MAIN, "another-project"))).toBe(true);
    expect(looksLikeSecret(`${message} Use sk-ant-${"z".repeat(30)}.`, quoted)).toBe(true);

    // Answered: the news is told and cleared; outside the turn nothing is quoted any more.
    h.answer();
    await h.settle();
    expect(pendingRestartNews(store)).toBeNull();
    expect(restartTextCarried(h.queue, MAIN, "nx")).toEqual([]);
    expect(h.cardPending()).toBe(true);
  });
});
