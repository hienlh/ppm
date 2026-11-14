import { describe, expect, it } from "bun:test";
import {
  DB_APPROVAL_REMINDER_BEFORE_MS, DB_APPROVAL_WAIT_MS, createDbApprovalBroker, type DbApprovalChat, type DbApprovalEvent,
} from "../../../src/services/db-ai-tools/db-approval-broker.ts";
import { createDbAttentionEvents, type DbAttentionEvents } from "../../../src/services/db-ai-tools/db-attention-events.ts";
import { DB_TOOLS_TIMEOUT_MS, dbToolDefinitions } from "../../../src/services/db-ai-tools/db-ai-tools-tool.ts";

const INPUT = {
  connectionId: 7, connectionName: "Prod", dbType: "postgres" as const, group: "Live", color: null, readonly: true,
  sql: "DELETE FROM jobs WHERE id = 1", reason: "Drop the stuck job", expectedRows: 1,
};

function setup(opts: { announce?: boolean; canonical?: (id: string) => string } = {}) {
  const announced: Array<{ sessionId: string; event: DbApprovalEvent }> = [];
  const resolved: Array<{ sessionId: string; requestId: string; approved: boolean }> = [];
  const chat: DbApprovalChat = {
    announce: (sessionId, event) => {
      announced.push({ sessionId, event });
      return opts.announce ?? true;
    },
    resolved: (sessionId, requestId, approved) => { resolved.push({ sessionId, requestId, approved }); },
  };
  const broker = createDbApprovalBroker({
    chat: () => chat,
    canonical: opts.canonical,
    passwordRequired: () => true,
    checkPassword: (typed) => typed === "s3cret",
  });
  const lastId = () => announced.at(-1)!.event.requestId;
  return { broker, announced, resolved, lastId };
}

describe("db_execute approvals", () => {
  it("shows the change in the session's chat and runs it once the right password is typed", async () => {
    const { broker, announced, resolved, lastId } = setup();
    const outcome = broker.request("s1", INPUT);
    expect(announced).toEqual([{ sessionId: "s1", event: { type: "approval_request", requestId: lastId(), tool: "ppm:db_execute", input: { ...INPUT, passwordRequired: true } } }]);
    expect(broker.pendingEvent("s1")?.requestId).toBe(lastId());
    expect(broker.answer(lastId(), { approved: true, password: "nope" })).toEqual({ ok: false, status: 403, error: "Wrong password" });
    expect(broker.answer(lastId(), { approved: true })).toEqual({ ok: false, status: 403, error: "Wrong password" });
    expect(broker.has(lastId())).toBe(true);
    expect(broker.answer(lastId(), { approved: true, password: "s3cret" })).toEqual({ ok: true, approved: true });
    expect(await outcome).toEqual({ approved: true });
    expect(resolved).toEqual([{ sessionId: "s1", requestId: announced[0]!.event.requestId, approved: true }]);
    expect(broker.pendingCount()).toBe(0);
    // Answered: the same approval cannot be used again.
    expect(broker.answer(announced[0]!.event.requestId, { approved: true, password: "s3cret" })).toMatchObject({ ok: false, status: 404 });
  });

  it("settles as declined without asking for the password, and refuses an answer that is not yes or no", async () => {
    const { broker, lastId, resolved } = setup();
    const outcome = broker.request("s1", INPUT);
    expect(broker.answer(lastId(), { password: "s3cret" } as never)).toMatchObject({ ok: false, status: 400 });
    expect(broker.answer(lastId(), null)).toMatchObject({ ok: false, status: 400 });
    expect(broker.answer(lastId(), { approved: false })).toEqual({ ok: true, approved: false });
    expect(await outcome).toMatchObject({ approved: false, reason: "declined" });
    expect(resolved.map((r) => r.approved)).toEqual([false]);
  });

  it("holds one approval per session, following a renamed session", async () => {
    const renamed = new Map([["draft", "real"]]);
    const { broker, lastId } = setup({ canonical: (id) => renamed.get(id) ?? id });
    const first = broker.request("draft", INPUT);
    expect(await broker.request("real", INPUT)).toMatchObject({ approved: false, reason: "busy" });
    expect(broker.pendingEvent("real")?.requestId).toBe(lastId());
    const other = broker.request("s2", INPUT);
    expect(broker.pendingCount()).toBe(2);
    expect(broker.cancelSession("real", "The user sent a message instead.")).toBe(true);
    expect(await first).toEqual({ approved: false, reason: "cancelled", message: "The user sent a message instead." });
    expect(broker.cancelSession("real", "again")).toBe(false);
    broker.cancelSession("s2", "done");
    await other;
  });

  it("gives up when no chat can show it, when nobody answers in time, and when the call is cancelled", async () => {
    expect(await setup({ announce: false }).broker.request("s1", INPUT)).toMatchObject({ approved: false, reason: "no-chat" });

    const timed = setup();
    expect(await timed.broker.request("s1", INPUT, 20)).toMatchObject({ approved: false, reason: "timeout" });
    expect(timed.resolved).toHaveLength(1);
    expect(timed.broker.pendingCount()).toBe(0);

    const aborted = setup();
    const controller = new AbortController();
    const outcome = aborted.broker.request("s1", INPUT, undefined, controller.signal);
    controller.abort();
    expect(await outcome).toMatchObject({ approved: false, reason: "cancelled" });
    expect(aborted.resolved).toHaveLength(1);

    // Cancelled before it was shown: nothing to take off the chat.
    const early = setup();
    expect(await early.broker.request("s1", INPUT, undefined, AbortSignal.abort())).toMatchObject({ approved: false, reason: "cancelled" });
    expect(early.announced).toEqual([]);
    expect(early.resolved).toEqual([]);
  });
});

describe("telling the user's other channels", () => {
  function told(waitMs: number, reminderBeforeMs: number) {
    const events = createDbAttentionEvents();
    const shown: Array<DbAttentionEvents["approval_shown"]> = [];
    const reminders: Array<DbAttentionEvents["approval_reminder"]> = [];
    events.on("approval_shown", (p) => shown.push(p));
    events.on("approval_reminder", (p) => reminders.push(p));
    const ids: string[] = [];
    const broker = createDbApprovalBroker({
      chat: () => ({ announce: (_s, ev) => { ids.push(ev.requestId); return true; }, resolved: () => {} }),
      passwordRequired: () => true, checkPassword: (typed) => typed === "pw", events, now: () => 1_000, reminderBeforeMs,
    });
    return { broker, shown, reminders, lastId: () => ids.at(-1)! };
  }

  it("waits 30 minutes, and every timeout above the call outlasts that", () => {
    expect(DB_APPROVAL_WAIT_MS).toBe(30 * 60_000);
    expect(DB_APPROVAL_REMINDER_BEFORE_MS).toBe(5 * 60_000);
    // Claude takes the MCP timeout in ms, Codex in seconds; both include the approved script's own run.
    expect(DB_TOOLS_TIMEOUT_MS).toBeGreaterThan(DB_APPROVAL_WAIT_MS + 25 * 60_000);
    const execute = dbToolDefinitions("", () => true).find((t) => t.name === "db_execute") as { description: string };
    expect(execute.description).toContain("do not answer within 30 minutes");
  });

  it("tells them once when the approval is shown, and reminds them once before it gives up", async () => {
    const t = told(80, 40);
    const outcome = t.broker.request("s1", INPUT, 80);
    expect(t.shown).toEqual([{ sessionId: "s1", requestId: t.lastId(), input: { ...INPUT, passwordRequired: true }, expiresAt: 1_080 }]);
    expect(t.reminders).toEqual([]);
    await Bun.sleep(55);
    expect(t.reminders).toEqual([{ sessionId: "s1", requestId: t.lastId(), input: { ...INPUT, passwordRequired: true }, expiresAt: 1_080 }]);
    expect(await outcome).toMatchObject({ reason: "timeout" });
    expect(t.reminders).toHaveLength(1);
  });

  it("sends no reminder for an approval answered before it, and none for a wait shorter than the reminder", async () => {
    const answered = told(80, 40);
    const outcome = answered.broker.request("s1", INPUT, 80);
    expect(answered.broker.answer(answered.lastId(), { approved: false })).toEqual({ ok: true, approved: false });
    await outcome;
    await Bun.sleep(60);
    expect(answered.shown).toHaveLength(1);
    expect(answered.reminders).toEqual([]);

    const short = told(30, 40);
    await short.broker.request("s1", INPUT, 30);
    expect(short.shown).toHaveLength(1);
    expect(short.reminders).toEqual([]);
  });

  it("tells nobody about an approval no chat could show", async () => {
    const events = createDbAttentionEvents();
    const shown: unknown[] = [];
    events.on("approval_shown", (p) => shown.push(p));
    const broker = createDbApprovalBroker({ chat: () => ({ announce: () => false, resolved: () => {} }), passwordRequired: () => true, events });
    expect(await broker.request("s1", INPUT)).toMatchObject({ reason: "no-chat" });
    expect(shown).toEqual([]);
  });
});
