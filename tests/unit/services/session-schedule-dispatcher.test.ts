/**
 * Delivering a session schedule's pending fire into its chat: only when the chat is quiet, as one
 * turn of its own, in the chat's own permission mode, with the run recorded only once that turn
 * starts. A chat that cannot take it pauses the schedule; nothing ever creates a chat.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import {
  getSchedule, insertSchedule, listScheduleRuns, setSessionSchedulePending, updateSchedule,
} from "../../../src/services/scheduler-db.service.ts";
import { validateScheduleRun } from "../../../src/shared/chat-schedule-run.ts";
import { onServerScheduleChange } from "../../../src/services/session-schedules/session-schedules-changed.ts";
import { createChatLifecycle, type ChatLifecycle } from "../../../src/services/chat-control/chat-lifecycle.ts";
import type {
  ChatControl, DeliverResult, LiveChatState, SendUserMessageOpts,
} from "../../../src/services/chat-control/chat-control.ts";
import { SessionScheduleDispatcher } from "../../../src/services/session-schedules/session-schedule-dispatcher.ts";
import type { ScheduleNotice, SessionScheduleDispatchEnv } from "../../../src/services/session-schedules/session-schedule-dispatch-types.ts";
import type { ScheduleTargetResolution } from "../../../src/services/session-schedules/session-schedule-target.ts";

const CHAT = "chat-target-1";

interface Sent { sessionId: string; text: string; opts: SendUserMessageOpts }

let lifecycle: ChatLifecycle;
let live: LiveChatState | null;
let sent: Sent[];
let notices: ScheduleNotice[];
let reply: (s: Sent) => DeliverResult;
let target: ScheduleTargetResolution;
/** What the chat answers when asked whether a queued schedule message is still waiting. */
let queuedAnswer: boolean | null;
let dispatcher: SessionScheduleDispatcher;
let ids = 0;

const control: ChatControl = {
  sendUserMessage: (sessionId, text, opts) => {
    const s = { sessionId, text, opts };
    sent.push(s);
    return Promise.resolve(reply(s));
  },
  answerApproval: () => "stale",
  cancelTurn: () => false,
  liveState: () => live,
  messageQueued: () => queuedAnswer,
  listLive: () => [],
};

function env(over: Partial<SessionScheduleDispatchEnv> = {}): SessionScheduleDispatchEnv {
  return {
    control: () => control,
    lifecycle,
    now: () => Date.now(),
    canonical: (id) => id,
    target: () => target,
    notify: (n) => { notices.push(n); },
    chatTitle: () => "My chat",
    newClientMessageId: () => `schedule-test-${++ids}`,
    promptText: (p) => p,
    retryDelayMs: 60_000,
    flightCheckMs: 60_000,
    queuedCheckMs: 60_000,
    retryBackoffMs: [60_000, 300_000, 900_000],
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
/** Waits for `check`, up to two seconds: timer-driven steps run late on a loaded machine. */
async function kitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}
const busyLive = (over: Partial<LiveChatState> = {}): LiveChatState => ({
  phase: "streaming", running: true, projectName: "proj", providerId: "claude", queuedCards: 0, ...over,
});

/** A session schedule with a fire already pending. */
function pending(over: { name?: string; recurring?: boolean; since?: string } = {}): number {
  const id = insertSchedule({
    name: over.name ?? "daily check", cron_expr: "0 9 * * *", provider_id: "claude", project_path: "/tmp/p",
    prompt: "check the deploy", kind: "session", target_session_id: CHAT, timezone: "Asia/Saigon",
    recurring: over.recurring ?? true, next_fire_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  setSessionSchedulePending(id, over.since ?? new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 86_400_000).toISOString());
  return id;
}

const turnEnded = (outcome: "done" | "stopped" | "failed" = "done") => lifecycle.emit("turn_ended", {
  sessionId: CHAT, outcome, finalText: "all good", projectName: "proj", providerId: "claude",
});

beforeEach(() => {
  setDb(openTestDb());
  lifecycle = createChatLifecycle();
  live = null;
  queuedAnswer = null;
  sent = [];
  notices = [];
  reply = (s) => ({ ok: true, sessionId: s.sessionId, delivered: "started" });
  target = { ok: true, target: { sessionId: CHAT, projectName: "proj", projectPath: "/tmp/p", providerId: "claude" } };
  dispatcher = new SessionScheduleDispatcher(env());
  dispatcher.start();
});

afterEach(() => dispatcher.stop());

describe("delivery into an idle chat", () => {
  it("sends into a cold chat as a schedule turn with no permission mode, and records the run", async () => {
    const id = pending();
    await dispatcher.due(id);

    expect(sent).toHaveLength(1);
    const { opts, text, sessionId } = sent[0]!;
    expect(sessionId).toBe(CHAT);
    expect(text).toBe("check the deploy");
    expect(opts.origin).toBe("schedule");
    expect(opts.permissionMode).toBeUndefined();
    expect(opts.scheduleRun?.scheduleId).toBe(id);
    expect(opts.scheduleRun?.name).toBe("daily check");
    expect(opts.scheduleRun?.timezone).toBe("Asia/Saigon");

    const after = getSchedule(id)!;
    expect(after.pending_since).toBeNull();
    expect(after.last_run_at).not.toBeNull();
    expect(listScheduleRuns(id)[0]!.status).toBe("running");

    turnEnded("done");
    const run = listScheduleRuns(id)[0]!;
    expect(run.status).toBe("done");
    expect(run.output_truncated).toBe("all good");
  });

  it("sends a schedule stored with a tab, a newline or a double space in its name or cron", async () => {
    // A row saved before names were normalized: the chat refuses a run block it would rewrite.
    const id = pending({ name: "Daily  check\tnow\nplease" });
    updateSchedule(id, { cron_expr: "0  9 * * *" });
    await dispatcher.due(id);

    expect(sent).toHaveLength(1);
    const ref = sent[0]!.opts.scheduleRun!;
    expect(ref.name).toBe("Daily check now please");
    expect(ref.cron).toBe("0 9 * * *");
    expect(validateScheduleRun(ref)).not.toBeNull();
    expect(getSchedule(id)!.paused_reason).toBeNull();
  });

  it("keeps the run open through a builtin command answered inside the scheduled turn", async () => {
    const id = pending();
    await dispatcher.due(id);
    lifecycle.emit("turn_ended", {
      sessionId: CHAT, outcome: "done", finalText: "PPM v1.0", turnStillRunning: true, projectName: "proj", providerId: "claude",
    });
    expect(listScheduleRuns(id)[0]!.status).toBe("running");

    turnEnded("done");
    const run = listScheduleRuns(id)[0]!;
    expect(run.status).toBe("done");
    expect(run.output_truncated).toBe("all good");
  });

  it("records a turn that did not finish as an error", async () => {
    const id = pending();
    await dispatcher.due(id);
    turnEnded("failed");
    expect(listScheduleRuns(id)[0]!.status).toBe("error");
  });

  it("deletes a one-shot only once its turn has ended without failing", async () => {
    const id = pending({ recurring: false });
    await dispatcher.due(id);
    expect(sent).toHaveLength(1);
    // Running: still there, its fire still pending, its run recorded.
    expect(getSchedule(id)!.pending_since).not.toBeNull();
    expect(listScheduleRuns(id)[0]!.status).toBe("running");
    turnEnded("done");
    expect(getSchedule(id)).toBeNull();
  });

  it("deletes a one-shot whose turn the user stopped, or that ran into Max Turns", async () => {
    const a = pending({ recurring: false });
    await dispatcher.due(a);
    lifecycle.emit("turn_ended", { sessionId: CHAT, outcome: "stopped", cancelledBy: "ws", projectName: "proj", providerId: "claude" });
    expect(getSchedule(a)).toBeNull();

    const b = pending({ recurring: false });
    await dispatcher.due(b);
    lifecycle.emit("turn_ended", {
      sessionId: CHAT, outcome: "stopped", stop: { message: "Reached maximum number of turns (8)", subtype: "error_max_turns", at: Date.now() },
      projectName: "proj", providerId: "claude",
    });
    expect(getSchedule(b)).toBeNull();
  });
});

describe("telling open PPMs what delivery changed", () => {
  let told = 0;
  let off: () => void = () => {};
  beforeEach(() => { told = 0; off = onServerScheduleChange(() => { told++; }); });
  afterEach(() => off());

  it("when a turn takes the fire, when it ends, and when a one-shot goes", async () => {
    const id = pending({ recurring: false });
    await dispatcher.due(id);
    expect(told).toBe(1);
    turnEnded("done");
    expect(getSchedule(id)).toBeNull();
    expect(told).toBe(2);
  });

  it("when the chat cannot be reached and its schedules pause", async () => {
    target = { ok: false, reason: "The chat this schedule runs in no longer exists." };
    await dispatcher.due(pending());
    expect(told).toBe(1);
  });

  it("not while a busy chat only keeps its fire waiting", async () => {
    live = busyLive();
    await dispatcher.due(pending());
    expect(told).toBe(0);
  });
});

describe("a one-shot whose turn failed", () => {
  function quick(): void {
    dispatcher.stop();
    dispatcher = new SessionScheduleDispatcher(env({ retryBackoffMs: [15, 15, 15] }));
    dispatcher.start();
  }
  const failedTurn = () => lifecycle.emit("turn_ended", {
    sessionId: CHAT, outcome: "failed", error: "Not signed in", projectName: "proj", providerId: "claude",
  });

  it("is kept with its fire pending, records the run as an error, tells the user once and goes again", async () => {
    quick();
    const id = pending({ recurring: false });
    await dispatcher.due(id);
    failedTurn();

    const kept = getSchedule(id)!;
    expect(kept.pending_since).not.toBeNull();
    expect(kept.paused_reason).toBeNull();
    expect(listScheduleRuns(id)[0]).toMatchObject({ status: "error", error: "Not signed in" });
    expect(notices.map((n) => n.kind)).toEqual(["retrying"]);
    expect(notices[0]!.body).toBe("Its turn failed: Not signed in. PPM will send it again in 1 minute.");

    await kitUntil(() => sent.length === 2);
    failedTurn();
    await kitUntil(() => sent.length === 3);
    // Told once, not at every retry.
    expect(notices.map((n) => n.kind)).toEqual(["retrying"]);
    turnEnded("done");
    expect(getSchedule(id)).toBeNull();
  });

  it("is paused, with one notice, once every retry has failed", async () => {
    quick();
    const id = pending({ recurring: false });
    await dispatcher.due(id);
    for (let i = 1; i <= 4; i++) {
      await kitUntil(() => sent.length === i);
      failedTurn();
    }
    await Bun.sleep(60);
    expect(sent).toHaveLength(4);
    const paused = getSchedule(id)!;
    expect(paused.paused_reason).toBe("Its turn failed: Not signed in. It failed 4 times in a row.");
    expect(paused.pending_since).toBeNull();
    expect(notices.map((n) => n.kind)).toEqual(["retrying", "paused"]);
  });
});

describe("a turn that failed after it had started working", () => {
  function quick(): void {
    dispatcher.stop();
    dispatcher = new SessionScheduleDispatcher(env({ retryBackoffMs: [15, 15, 15] }));
    dispatcher.start();
  }
  const streamed = (event: unknown) => lifecycle.emit("stream", { sessionId: CHAT, event });
  const overloaded = () => lifecycle.emit("turn_ended", {
    sessionId: CHAT, outcome: "failed", error: "Overloaded", projectName: "proj", providerId: "claude",
  });

  it("is not sent again once a tool ran: the one-shot pauses, with one notice", async () => {
    quick();
    const id = pending({ recurring: false, name: "tag the release" });
    await dispatcher.due(id);
    streamed({ type: "tool_use", tool: "Bash", input: { command: "git push --tags" }, toolUseId: "t1" });
    overloaded();
    await Bun.sleep(60);

    expect(sent).toHaveLength(1);
    const paused = getSchedule(id)!;
    expect(paused.paused_reason).toBe("The scheduled turn failed partway (Overloaded); resume it to try again.");
    expect(paused.pending_since).toBeNull();
    expect(listScheduleRuns(id)[0]).toMatchObject({ status: "error", error: "Overloaded" });
    expect(notices.map((n) => n.kind)).toEqual(["failed"]);
    expect(notices[0]!.title).toBe("Schedule failed partway: tag the release");
  });

  it("is not sent again once it had written part of its answer", async () => {
    quick();
    const id = pending({ recurring: false });
    await dispatcher.due(id);
    streamed({ type: "thinking", content: "Let me look." });
    streamed({ type: "text", content: "Pushing the tag now." });
    overloaded();
    await Bun.sleep(60);

    expect(sent).toHaveLength(1);
    expect(getSchedule(id)!.paused_reason).not.toBeNull();
    expect(notices.map((n) => n.kind)).toEqual(["failed"]);
  });

  it("leaves a recurring schedule on, waiting for its next fire, and tells the user once", async () => {
    quick();
    const id = pending();
    await dispatcher.due(id);
    streamed({ type: "tool_use", tool: "Bash", input: {}, toolUseId: "t1" });
    overloaded();
    await Bun.sleep(60);

    expect(sent).toHaveLength(1);
    const after = getSchedule(id)!;
    expect(after.enabled).toBe(1);
    expect(after.paused_reason).toBeNull();
    expect(after.pending_since).toBeNull();
    expect(listScheduleRuns(id)[0]!.status).toBe("error");
    expect(notices.map((n) => n.kind)).toEqual(["failed"]);
    expect(notices[0]!.body).toContain("It runs again at its next time.");
  });

  it("sends a recurring schedule again when its turn failed before doing anything", async () => {
    quick();
    const id = pending();
    await dispatcher.due(id);
    // Thinking alone is not work anyone can see.
    streamed({ type: "thinking", content: "Let me look." });
    overloaded();
    expect(getSchedule(id)!.pending_since).not.toBeNull();
    expect(notices.map((n) => n.kind)).toEqual(["retrying"]);

    await kitUntil(() => sent.length === 2);
    turnEnded("done");
    expect(getSchedule(id)!.pending_since).toBeNull();
    expect(listScheduleRuns(id).map((r) => r.status).sort()).toEqual(["done", "error"]);
  });

  it("does not count what streamed for the turn a queued message waited behind", async () => {
    quick();
    reply = (s) => ({ ok: true, sessionId: s.sessionId, delivered: "queued" });
    queuedAnswer = true;
    const id = pending({ recurring: false });
    await dispatcher.due(id);
    // The person's own turn, ahead of it, calls a tool.
    streamed({ type: "tool_use", tool: "Bash", input: {}, toolUseId: "t0" });
    streamed({ type: "turn_started", clientMessageId: sent[0]!.opts.clientMessageId });
    overloaded();

    expect(getSchedule(id)!.paused_reason).toBeNull();
    expect(notices.map((n) => n.kind)).toEqual(["retrying"]);
  });
});

describe("a busy chat", () => {
  it("waits for the running turn to end, then sends exactly once", async () => {
    live = busyLive();
    const id = pending();
    await dispatcher.due(id);
    expect(sent).toHaveLength(0);
    expect(getSchedule(id)!.pending_since).not.toBeNull();

    live = null;
    turnEnded();
    await flush();
    expect(sent).toHaveLength(1);
    // Its own turn's end wakes nothing more.
    turnEnded();
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("waits behind a card and tells the user once per pending period", async () => {
    live = busyLive({ card: { requestId: "r1" } as LiveChatState["card"] });
    const id = pending();
    await dispatcher.due(id);
    await dispatcher.due(id);
    lifecycle.emit("approval_resolved", { sessionId: CHAT, requestId: "r0", approved: true, reason: "answered" });
    await flush();

    expect(sent).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe("waiting");
    expect(notices[0]!.body).toBe("Schedule daily check is waiting: an approval is pending in My chat");
    expect(notices[0]!.stillRelevant?.()).toBe(true);

    live = null;
    expect(notices[0]!.stillRelevant?.()).toBe(false);
    lifecycle.emit("approval_resolved", { sessionId: CHAT, requestId: "r1", approved: true, reason: "answered" });
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("folds fires that come due while waiting into one turn", async () => {
    live = busyLive();
    const id = pending();
    await dispatcher.due(id);
    setSessionSchedulePending(id, new Date().toISOString(), null);
    await dispatcher.due(id);
    live = null;
    turnEnded();
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("sends several schedules of one chat one turn after another", async () => {
    const a = pending({ name: "first", since: new Date(Date.now() - 5000).toISOString() });
    const b = pending({ name: "second" });
    live = busyLive();
    await dispatcher.due(b);
    await dispatcher.due(a);
    live = null;
    turnEnded();
    await flush();
    expect(sent.map((s) => s.opts.scheduleRun?.name)).toEqual(["first"]);
    turnEnded();
    await flush();
    expect(sent.map((s) => s.opts.scheduleRun?.name)).toEqual(["first", "second"]);
  });
});

describe("when the turn starts", () => {
  it("keeps the fire pending while the message waits behind a turn that started meanwhile", async () => {
    reply = (s) => ({ ok: true, sessionId: s.sessionId, delivered: "queued" });
    const id = pending();
    await dispatcher.due(id);
    expect(getSchedule(id)!.pending_since).not.toBeNull();
    expect(listScheduleRuns(id)).toHaveLength(0);

    lifecycle.emit("stream", { sessionId: CHAT, event: { type: "turn_started", clientMessageId: sent[0]!.opts.clientMessageId } });
    expect(getSchedule(id)!.pending_since).toBeNull();
    expect(listScheduleRuns(id)[0]!.status).toBe("running");
  });

  it("leaves the fire pending when the chat says busy", async () => {
    reply = () => ({ ok: false, error: "busy" });
    const id = pending();
    await dispatcher.due(id);
    const after = getSchedule(id)!;
    expect(after.pending_since).not.toBeNull();
    expect(after.paused_reason).toBeNull();
  });
});

describe("a chat PPM cannot reach", () => {
  it("pauses the schedule and sends nothing when the chat is gone", async () => {
    target = { ok: false, reason: "The chat this schedule runs in no longer exists." };
    const id = pending();
    await dispatcher.due(id);
    expect(sent).toHaveLength(0);
    const after = getSchedule(id)!;
    expect(after.paused_reason).toBe("The chat this schedule runs in no longer exists.");
    expect(after.pending_since).toBeNull();
    expect(notices.map((n) => n.kind)).toEqual(["paused"]);
  });

  it("tells the user once for the chat, naming every schedule it paused", async () => {
    const a = pending({ name: "morning" });
    const b = pending({ name: "evening" });
    live = busyLive();
    await dispatcher.due(a);
    await dispatcher.due(b);
    target = { ok: false, reason: "The chat this schedule runs in no longer exists." };
    live = null;
    await dispatcher.pump(CHAT);

    expect(getSchedule(a)!.paused_reason).not.toBeNull();
    expect(getSchedule(b)!.paused_reason).not.toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe("2 schedules paused");
    expect(notices[0]!.body).toBe(
      "The chat this schedule runs in no longer exists. Paused: \"morning\", \"evening\". Turn them back on once the chat can take them again.",
    );
    expect(notices[0]!.schedules.map((s) => s.id).sort()).toEqual([a, b].sort());
  });

  it("pauses at once when the chat turns out to be gone after a send failed", async () => {
    reply = () => {
      target = { ok: false, reason: "The chat's conversation is no longer on this machine." };
      return { ok: false, error: "Could not resume the session: thread not found" };
    };
    const id = pending();
    await dispatcher.due(id);
    expect(getSchedule(id)!.paused_reason).toBe("The chat's conversation is no longer on this machine.");
    expect(notices.map((n) => n.kind)).toEqual(["paused"]);
  });
});

describe("a send that fails for a reason that may pass", () => {
  it("keeps the fire pending and tries again after each wait, then pauses with one notice", async () => {
    dispatcher.stop();
    dispatcher = new SessionScheduleDispatcher(env({ retryBackoffMs: [15, 15, 15] }));
    dispatcher.start();
    reply = () => ({ ok: false, error: "Could not resume the session: the CLI exited" });
    const id = pending();
    await dispatcher.due(id);
    expect(sent).toHaveLength(1);
    const waiting = getSchedule(id)!;
    expect(waiting.pending_since).not.toBeNull();
    expect(waiting.paused_reason).toBeNull();
    // A fire coming due meanwhile waits for the backoff rather than going at once.
    await dispatcher.due(id);
    expect(sent).toHaveLength(1);
    expect(notices).toHaveLength(0);

    await kitUntil(() => getSchedule(id)!.paused_reason !== null);
    expect(sent).toHaveLength(4);
    const paused = getSchedule(id)!;
    expect(paused.paused_reason).toBe(
      "PPM could not send it into its chat: Could not resume the session: the CLI exited. It failed 4 times in a row.",
    );
    expect(notices.map((n) => n.kind)).toEqual(["paused"]);
  });

  it("counts from one again after a send goes through", async () => {
    dispatcher.stop();
    dispatcher = new SessionScheduleDispatcher(env({ retryBackoffMs: [15, 15, 15] }));
    dispatcher.start();
    let calls = 0;
    reply = (s) => (++calls % 3 === 0 ? { ok: true, sessionId: s.sessionId, delivered: "started" } : { ok: false, error: "Could not deliver the message: EPIPE" });
    const id = pending();
    await dispatcher.due(id);
    await kitUntil(() => sent.length === 3);
    turnEnded();
    setSessionSchedulePending(id, new Date().toISOString(), null);
    await dispatcher.due(id);
    await kitUntil(() => sent.length === 6);
    expect(getSchedule(id)!.paused_reason).toBeNull();
  });
});

describe("a message queued behind a turn that started after the quiet check", () => {
  /** A dispatcher that looks at a queued or running message again within milliseconds. */
  function quick(): void {
    dispatcher.stop();
    dispatcher = new SessionScheduleDispatcher(env({ queuedCheckMs: 10, flightCheckMs: 20 }));
    dispatcher.start();
  }
  const turnStarted = (clientMessageId: string) =>
    lifecycle.emit("stream", { sessionId: CHAT, event: { type: "turn_started", turnId: `t-${clientMessageId}`, clientMessageId } });
  const stopped = () => lifecycle.emit("turn_ended", {
    sessionId: CHAT, outcome: "stopped", cancelledBy: "ws", projectName: "proj", providerId: "claude",
  });

  it("is not counted as run by the end of the turn it waited behind", async () => {
    quick();
    reply = (s) => ({ ok: true, sessionId: s.sessionId, delivered: "queued" });
    queuedAnswer = true;
    const id = pending();
    await dispatcher.due(id);
    stopped();
    expect(getSchedule(id)!.pending_since).not.toBeNull();
    expect(listScheduleRuns(id)).toHaveLength(0);

    // Its own turn opens, named by the provider: only now is the fire spent.
    turnStarted(sent[0]!.opts.clientMessageId!);
    expect(getSchedule(id)!.pending_since).toBeNull();
    expect(listScheduleRuns(id)[0]!.status).toBe("running");
    turnEnded("done");
    expect(listScheduleRuns(id)[0]!.status).toBe("done");
  });

  it("stays pending and is sent again once when Stop dropped it with the turn ahead of it", async () => {
    quick();
    let replies = 0;
    reply = (s) => {
      if (++replies === 1) return { ok: true, sessionId: s.sessionId, delivered: "queued" };
      // Sent again into the idle chat: its own turn runs now.
      live = busyLive();
      return { ok: true, sessionId: s.sessionId, delivered: "started" };
    };
    const id = pending();
    await dispatcher.due(id);
    expect(sent).toHaveLength(1);

    // Stop killed the provider with the scheduled message still in its queue.
    queuedAnswer = false;
    stopped();
    expect(listScheduleRuns(id)).toHaveLength(0);
    await kitUntil(() => sent.length === 2);

    expect(sent[1]!.opts.clientMessageId).not.toBe(sent[0]!.opts.clientMessageId);
    expect(listScheduleRuns(id)).toHaveLength(1);
    expect(getSchedule(id)!.pending_since).toBeNull();
    live = null;
    turnEnded("done");
    await Bun.sleep(40);
    expect(sent).toHaveLength(2);
    expect(listScheduleRuns(id)[0]!.status).toBe("done");
  });

  it("waits while the chat still holds it behind a running turn", async () => {
    quick();
    reply = (s) => ({ ok: true, sessionId: s.sessionId, delivered: "queued" });
    queuedAnswer = true;
    const id = pending();
    await dispatcher.due(id);
    live = busyLive();
    turnEnded();
    await Bun.sleep(60);
    expect(sent).toHaveLength(1);
    expect(getSchedule(id)!.pending_since).not.toBeNull();
    // A turn opened by another message is not this one's.
    turnStarted("someone-else");
    expect(listScheduleRuns(id)).toHaveLength(0);
  });

  it("is sent again when a provider that cannot say leaves an idle chat for several looks", async () => {
    quick();
    let replies = 0;
    reply = (s) => ({ ok: true, sessionId: s.sessionId, delivered: ++replies === 1 ? "queued" : "started" });
    queuedAnswer = null;
    const id = pending();
    await dispatcher.due(id);
    turnEnded();
    expect(sent).toHaveLength(1);
    await kitUntil(() => sent.length === 2);
  });
});

describe("a turn end PPM never hears", () => {
  it("closes the run once the chat is idle, and the chat's next schedule goes", async () => {
    dispatcher.stop();
    dispatcher = new SessionScheduleDispatcher(env({ flightCheckMs: 20 }));
    dispatcher.start();
    const a = pending({ name: "first", since: new Date(Date.now() - 5000).toISOString() });
    const b = pending({ name: "second" });
    live = busyLive();
    await dispatcher.due(a);
    await dispatcher.due(b);
    live = null;
    await dispatcher.pump(CHAT);
    expect(sent.map((s) => s.opts.scheduleRun?.name)).toEqual(["first"]);

    // Still running at the first look: nothing is closed.
    live = busyLive();
    await Bun.sleep(30);
    expect(listScheduleRuns(a)[0]!.status).toBe("running");
    // Idle with no end heard: the run is closed and the next schedule is sent.
    live = null;
    await kitUntil(() => sent.length === 2);
    const run = listScheduleRuns(a)[0]!;
    expect(run.status).toBe("error");
    expect(run.error).toBe("PPM did not hear how this turn ended.");
    expect(sent.map((s) => s.opts.scheduleRun?.name)).toEqual(["first", "second"]);
  });
});
