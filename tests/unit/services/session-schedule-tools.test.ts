/**
 * The AI's schedule tools reach its own chat only: the chat comes from the token, every schedule
 * is saved by the same rules as the REST route (cap, time zone, cron), and another chat's schedule
 * is out of reach — it reads exactly like one that does not exist.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { getSchedule, insertSchedule } from "../../../src/services/scheduler-db.service.ts";
import { sessionScheduleToolCall, type SessionScheduleToolEnv } from "../../../src/services/session-collab/collab-schedules.ts";
import { createSessionCollabMcpHandler } from "../../../src/services/session-collab/session-collab-endpoint.ts";
import type { ScheduleTargetDeps } from "../../../src/services/session-schedules/session-schedule-target.ts";
import type { NotificationPayload } from "../../../src/services/notification.service.ts";
import { PROMPT_SUMMARY_MAX } from "../../../src/services/session-collab/collab-schedule-created-notice.ts";
import { MAX_SCHEDULES_PER_SESSION } from "../../../src/shared/session-schedule-input.ts";

const CHAT = "chat-sched-own";
const OTHER = "chat-sched-other";
const NOW = new Date("2026-11-15T01:00:00Z");

interface FakeChat { assistant?: boolean; design?: boolean }
let chats: Record<string, FakeChat>;
let migrated: Record<string, string>;
let changes: number;
let notices: Array<{ payload: NotificationPayload; scheduleId: number }>;

const target: ScheduleTargetDeps = {
  canonical: (id) => migrated[id] ?? id,
  stored: (id, read) => read(id),
  isDesign: (id) => !!chats[id]?.design,
  isAssistant: (id) => !!chats[id]?.assistant,
  hasClaudeTranscript: () => false,
  projectByPath: (p) => (p === "/work/proj" ? { name: "proj", path: "/work/proj" } : null),
  projectPath: (id) => (chats[id] ? "/work/proj" : null),
  provider: (id) => (chats[id] ? "claude" : null),
};
const env: SessionScheduleToolEnv = {
  target, changed: () => { changes++; }, now: () => NOW, localZone: () => "Asia/Saigon",
  chatTitle: (id) => `Title of ${id}`,
  notifyCreated: (payload, scheduleId) => { notices.push({ payload, scheduleId }); },
};

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = (sessionId: string, name: string, args: unknown = {}) => sessionScheduleToolCall(env, sessionId, name as never, args) as Result;
const body = (r: Result) => JSON.parse(r.content[0]!.text);

beforeEach(() => {
  setDb(openTestDb());
  chats = { [CHAT]: {}, [OTHER]: {} };
  migrated = {};
  changes = 0;
  notices = [];
});

describe("session_schedule_create", () => {
  it("saves into the token's chat and says when it fires, on the schedule's own clock", () => {
    const res = call(CHAT, "session_schedule_create", { cron: "0 9 * * *", prompt: "Check the build", timezone: "europe/london" });
    expect(res.isError).toBeFalsy();
    const out = body(res);
    expect(out).toMatchObject({ created: true, name: "Check the build", cron: "0 9 * * *", timeZone: "Europe/London", recurring: true });
    expect(out.nextFire).toEqual({ at: "2026-11-15T09:00:00.000Z", local: "2026-11-15 Sun 09:00" });
    expect(out.note).toContain("survives restarts");
    expect(out.note).toContain("idle");
    const stored = getSchedule(out.id)!;
    expect(stored).toMatchObject({ kind: "session", target_session_id: CHAT, project_path: "/work/proj", provider_id: "claude", recurring: 1 });
    expect(changes).toBe(1);
  });

  it("stores the chat's current id when the token still names the one a provider renamed", () => {
    migrated = { "chat-old-name": CHAT };
    const out = body(call("chat-old-name", "session_schedule_create", { cron: "*/30 * * * *", prompt: "ping", recurring: false }));
    expect(getSchedule(out.id)!.target_session_id).toBe(CHAT);
    expect(out.recurring).toBe(false);
    expect(out.schedule).toContain("deletes itself");
  });

  it("refuses a time zone that does not exist and a cron that is not 5 fields, saving nothing", () => {
    const zone = call(CHAT, "session_schedule_create", { cron: "0 9 * * *", prompt: "x", timezone: "Mars/Olympus" });
    expect(zone.isError).toBe(true);
    expect(zone.content[0]!.text).toContain("IANA time zone");
    const cron = call(CHAT, "session_schedule_create", { cron: "0 0 9 * * *", prompt: "x" });
    expect(cron.isError).toBe(true);
    expect(body(call(CHAT, "session_schedule_list")).count).toBe(0);
    expect(changes).toBe(0);
  });

  it(`refuses the schedule after ${MAX_SCHEDULES_PER_SESSION} in one chat`, () => {
    for (let i = 0; i < MAX_SCHEDULES_PER_SESSION; i++) {
      expect(call(CHAT, "session_schedule_create", { cron: "0 9 * * *", prompt: `p${i}` }).isError).toBeFalsy();
    }
    const over = call(CHAT, "session_schedule_create", { cron: "0 9 * * *", prompt: "one more" });
    expect(over.isError).toBe(true);
    expect(over.content[0]!.text).toContain(`at most ${MAX_SCHEDULES_PER_SESSION}`);
    // Another chat has a cap of its own.
    expect(call(OTHER, "session_schedule_create", { cron: "0 9 * * *", prompt: "fine" }).isError).toBeFalsy();
  });

  it("refuses a PPM Assistant chat and a design session", () => {
    chats["assist-chat"] = { assistant: true };
    chats["canvas-chat"] = { design: true };
    expect(call("assist-chat", "session_schedule_create", { cron: "0 9 * * *", prompt: "x" }).content[0]!.text).toContain("PPM Assistant");
    expect(call("canvas-chat", "session_schedule_list").isError).toBe(true);
  });
});

describe("the notice for a schedule the AI created", () => {
  it("tells the user once, naming the schedule, the chat, when it runs and what it will say, linked to the chat", () => {
    const prompt = `Check the nightly build\n\nand   report ${"x".repeat(200)}`;
    const out = body(call(CHAT, "session_schedule_create", { cron: "0 9 * * 1-5", prompt, name: "Build check", timezone: "Asia/Saigon" }));
    expect(notices).toHaveLength(1);
    const { payload, scheduleId } = notices[0]!;
    expect(scheduleId).toBe(out.id);
    expect(payload.title).toBe("AI scheduled a prompt: Build check");
    // 2026-11-15 is a Sunday: the next weekday at 09:00 in Saigon is Monday 02:00 UTC.
    expect(payload.body).toBe(`In Title of ${CHAT} (proj). Weekdays at 09:00 (Asia/Saigon), next run 2026-11-16 Mon 09:00.`);
    expect(payload.detail!.startsWith("Check the nightly build and report xxx")).toBe(true);
    expect(payload.detail).not.toContain("\n");
    expect(payload.detail!.length).toBe(PROMPT_SUMMARY_MAX);
    expect(payload.detail!.endsWith("…")).toBe(true);
    expect(payload).toMatchObject({ project: "proj", sessionId: CHAT, providerId: "claude" });
  });

  it("says a one-shot runs once, on its own zone's clock, and quotes a short prompt whole", () => {
    call(CHAT, "session_schedule_create", { cron: "30 8 * * *", prompt: "ping", recurring: false, timezone: "Europe/London" });
    expect(notices[0]!.payload.body).toBe(`In Title of ${CHAT} (proj). Runs once, at 2026-11-15 Sun 08:30 (Europe/London).`);
    expect(notices[0]!.payload.detail).toBe("ping");
  });

  it("names the chat by its current id when the token still names the one a provider renamed", () => {
    migrated = { "chat-old-name": CHAT };
    call("chat-old-name", "session_schedule_create", { cron: "0 9 * * *", prompt: "x" });
    expect(notices[0]!.payload.sessionId).toBe(CHAT);
  });

  it("sends nothing for a refused schedule, a list or a delete", () => {
    call(CHAT, "session_schedule_create", { cron: "0 0 9 * * *", prompt: "x" });
    call(CHAT, "session_schedule_list");
    call(CHAT, "session_schedule_delete", { id: 1 });
    expect(notices).toEqual([]);
  });

  it("still saves the schedule when the notice cannot be sent", () => {
    const throwing: SessionScheduleToolEnv = { ...env, notifyCreated: () => { throw new Error("notification service down"); } };
    const res = sessionScheduleToolCall(throwing, CHAT, "session_schedule_create" as never, { cron: "0 9 * * *", prompt: "x" }) as Result;
    expect(res.isError).toBeFalsy();
    expect(getSchedule(body(res).id)).not.toBeNull();
  });
});

describe("session_schedule_list and session_schedule_delete", () => {
  const seed = (chat: string, prompt: string) => insertSchedule({
    name: prompt, cron_expr: "0 9 * * *", provider_id: "claude", project_path: "/work/proj", prompt, kind: "session", target_session_id: chat,
  });

  it("lists this chat's schedules only", () => {
    seed(CHAT, "mine");
    seed(OTHER, "theirs");
    const out = body(call(CHAT, "session_schedule_list"));
    expect(out.schedules.map((s: { prompt: string }) => s.prompt)).toEqual(["mine"]);
    expect(out.max).toBe(MAX_SCHEDULES_PER_SESSION);
  });

  it("cannot delete another chat's schedule, and answers as for one that does not exist", () => {
    const theirs = seed(OTHER, "theirs");
    const refused = call(CHAT, "session_schedule_delete", { id: theirs });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe(call(CHAT, "session_schedule_delete", { id: 99999 }).content[0]!.text.replace("99999", String(theirs)));
    expect(getSchedule(theirs)).not.toBeNull();
    expect(changes).toBe(0);
  });

  it("cannot delete a prompt schedule either, whatever its id", () => {
    const prompt = insertSchedule({ name: "p", cron_expr: "0 9 * * *", provider_id: "claude", project_path: "/work/proj", prompt: "p" });
    expect(call(CHAT, "session_schedule_delete", { id: prompt }).isError).toBe(true);
    expect(getSchedule(prompt)).not.toBeNull();
  });

  it("deletes its own", () => {
    const mine = seed(CHAT, "mine");
    expect(body(call(CHAT, "session_schedule_delete", { id: mine }))).toMatchObject({ deleted: true, id: mine });
    expect(getSchedule(mine)).toBeNull();
    expect(changes).toBe(1);
  });
});

describe("through the ppm-sessions endpoint", () => {
  it("answers without the session tools' environment or their rate limit", async () => {
    const handler = createSessionCollabMcpHandler({
      resolveToken: (token) => (token ? { sessionId: token } : null),
      env: () => { throw new Error("the session tools' environment is not used"); },
      enabled: () => true,
      limiter: { acquire: () => ({ ok: false, message: "rate limited" }) } as never,
      schedules: env,
    });
    const app = new Hono();
    app.post("/mcp", handler);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${CHAT}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_schedule_create", arguments: { cron: "0 9 * * *", prompt: "hi" } } }),
    });
    const rpc = await res.json() as { result: Result };
    expect(rpc.result.isError).toBeFalsy();
    expect(body(rpc.result).created).toBe(true);
  });
});
