import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { notificationService } from "../../../src/services/notification.service.ts";
import { runScheduleOnce, ensureScheduleSession } from "../../../src/services/scheduler-runner.ts";
import { insertSchedule, getSchedule, setScheduleSessionId } from "../../../src/services/scheduler-db.service.ts";
import type { ChatEvent } from "../../../src/types/chat.ts";
import type { Schedule } from "../../../src/types/scheduler.ts";

// ── Monkey-patch singletons (NOT mock.module — module mocks leak across
// test files in bun and would poison chat/config for unrelated suites) ──
const originals = {
  createSession: chatService.createSession.bind(chatService),
  resumeSession: chatService.resumeSession.bind(chatService),
  sendMessage: chatService.sendMessage.bind(chatService),
  configGet: configService.get.bind(configService),
  broadcast: notificationService.broadcast.bind(notificationService),
};
afterAll(() => {
  chatService.createSession = originals.createSession;
  chatService.resumeSession = originals.resumeSession;
  chatService.sendMessage = originals.sendMessage;
  configService.get = originals.configGet;
  notificationService.broadcast = originals.broadcast;
});

let sendEvents: ChatEvent[] = [];
let telegramConfig: { bot_token?: string } | undefined;
const createSessionMock = mock(() =>
  Promise.resolve({ id: "fresh-session", providerId: "p", title: "", createdAt: "" }));
const resumeSessionMock = mock(() =>
  Promise.resolve({ id: "existing", providerId: "p", title: "", createdAt: "" }));
const broadcastMock = mock(() => Promise.resolve());

chatService.createSession = createSessionMock as unknown as typeof chatService.createSession;
chatService.resumeSession = resumeSessionMock as unknown as typeof chatService.resumeSession;
chatService.sendMessage = async function* () { for (const ev of sendEvents) yield ev; } as typeof chatService.sendMessage;
configService.get = ((key: string) => (key === "telegram" ? telegramConfig : undefined)) as typeof configService.get;
notificationService.broadcast = broadcastMock as unknown as typeof notificationService.broadcast;

function makeSchedule(over: Partial<Schedule> = {}): Schedule {
  const id = insertSchedule({
    name: "t",
    cron_expr: "* * * * *",
    provider_id: "claude-agent-sdk",
    project_path: "/tmp/p",
    prompt: "go",
  });
  if (over.session_id) setScheduleSessionId(id, over.session_id);
  return { ...getSchedule(id)!, ...over, id };
}

const doneEvent = (extra: Partial<Extract<ChatEvent, { type: "done" }>> = {}): ChatEvent =>
  ({ type: "done", sessionId: "existing", resultSubtype: "success", ...extra });

describe("scheduler-runner", () => {
  beforeEach(() => {
    setDb(openTestDb());
    sendEvents = [];
    telegramConfig = undefined;
    createSessionMock.mockClear();
    resumeSessionMock.mockClear();
    broadcastMock.mockClear();
  });

  it("drains text events and captures contextWindowPct + costUsd from done", async () => {
    sendEvents = [
      { type: "text", content: "hello " },
      { type: "text", content: "world" },
      doneEvent({ contextWindowPct: 40, costUsd: 0.05 }),
    ];
    const schedule = makeSchedule({ session_id: "existing" });
    const result = await runScheduleOnce(schedule, "existing");
    expect(result.status).toBe("done");
    expect(result.output).toBe("hello world");
    expect(result.contextWindowPct).toBe(40);
    expect(result.costUsd).toBe(0.05);
  });

  it("marks error on error events and non-success subtype", async () => {
    sendEvents = [{ type: "error", message: "boom" }, doneEvent()];
    const result = await runScheduleOnce(makeSchedule(), "existing");
    expect(result.status).toBe("error");
    expect(result.error).toContain("boom");

    sendEvents = [doneEvent({ resultSubtype: "error_max_turns" })];
    const result2 = await runScheduleOnce(makeSchedule(), "existing");
    expect(result2.status).toBe("error");
  });

  it("rotates session when contextWindowPct > 80 and persists new id", async () => {
    sendEvents = [doneEvent({ contextWindowPct: 85 })];
    const schedule = makeSchedule({ session_id: "existing" });
    const result = await runScheduleOnce(schedule, "existing");
    expect(result.rotatedToSessionId).toBe("fresh-session");
    expect(getSchedule(schedule.id)!.session_id).toBe("fresh-session");
  });

  it("does not rotate at 70%", async () => {
    sendEvents = [doneEvent({ contextWindowPct: 70 })];
    const schedule = makeSchedule({ session_id: "existing" });
    const result = await runScheduleOnce(schedule, "existing");
    expect(result.rotatedToSessionId).toBeUndefined();
    expect(getSchedule(schedule.id)!.session_id).toBe("existing");
  });

  it("notifies via broadcast only when telegram configured", async () => {
    sendEvents = [doneEvent()];
    await runScheduleOnce(makeSchedule(), "existing");
    expect(broadcastMock).not.toHaveBeenCalled();

    telegramConfig = { bot_token: "tok" };
    sendEvents = [{ type: "text", content: "result text" }, doneEvent()];
    await runScheduleOnce(makeSchedule({ session_id: "existing" }), "existing");
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [type, payload] = broadcastMock.mock.calls[0] as unknown as [string, { title: string; body: string }];
    expect(type).toBe("done");
    expect(payload.title).toContain("done");
    expect(payload.body).toContain("result text");
  });

  it("truncates output beyond 32KB keeping head and tail", async () => {
    const chunk = "x".repeat(50 * 1024);
    sendEvents = [{ type: "text", content: chunk }, doneEvent()];
    const result = await runScheduleOnce(makeSchedule(), "existing");
    expect(result.output.length).toBeLessThan(40 * 1024);
    expect(result.output).toContain("[truncated");
  });

  it("ensureScheduleSession resumes existing, creates+persists when missing", async () => {
    const withSession = makeSchedule({ session_id: "existing" });
    expect(await ensureScheduleSession(withSession)).toBe("existing");
    expect(resumeSessionMock).toHaveBeenCalled();

    const withoutSession = makeSchedule();
    expect(await ensureScheduleSession(withoutSession)).toBe("fresh-session");
    expect(getSchedule(withoutSession.id)!.session_id).toBe("fresh-session");
  });

  it("falls back to a new session when resume throws", async () => {
    resumeSessionMock.mockImplementationOnce(() => Promise.reject(new Error("gone")));
    const schedule = makeSchedule({ session_id: "stale" });
    expect(await ensureScheduleSession(schedule)).toBe("fresh-session");
    expect(getSchedule(schedule.id)!.session_id).toBe("fresh-session");
  });
});
