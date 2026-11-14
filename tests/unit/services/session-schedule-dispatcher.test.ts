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
  listLive: () => [],
};

function env(): SessionScheduleDispatchEnv {
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
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
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

  it("deletes a one-shot once its turn has started", async () => {
    const id = pending({ recurring: false });
    await dispatcher.due(id);
    expect(sent).toHaveLength(1);
    expect(getSchedule(id)).toBeNull();
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

  it("pauses when the chat cannot be resumed, without trying again", async () => {
    reply = () => ({ ok: false, error: "Could not resume the session: thread not found" });
    const id = pending();
    await dispatcher.due(id);
    await dispatcher.due(id);
    expect(sent).toHaveLength(1);
    expect(getSchedule(id)!.paused_reason).toContain("Could not resume the session");
    expect(notices.map((n) => n.kind)).toEqual(["paused"]);
  });
});
