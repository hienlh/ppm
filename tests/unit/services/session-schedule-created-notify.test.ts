/**
 * The "AI scheduled a prompt" notice through the real notification service: the user's switch, its
 * own device tag, and the check that the schedule still exists once the notification delay ends —
 * all exercised on the path the live schedule tools use, with only the channels recorded.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import type { NotificationPayload } from "../../../src/services/notification.service.ts";
import { ntfyService } from "../../../src/services/ntfy-notification.service.ts";
import { getSchedule } from "../../../src/services/scheduler-db.service.ts";
import {
  sendAiScheduleNotice, sessionScheduleToolCall, type SessionScheduleToolEnv,
} from "../../../src/services/session-collab/collab-schedules.ts";
import { AiScheduleNoticeLimit } from "../../../src/services/session-collab/collab-schedule-notice-limit.ts";
import type { ScheduleTargetDeps } from "../../../src/services/session-schedules/session-schedule-target.ts";
import { telegramService } from "../../../src/services/telegram-notification.service.ts";
import { webPushService } from "../../../src/services/web-push/web-push.service.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../../src/shared/notification-settings.ts";

// Patch the channel singletons rather than mock.module, which leaks across test files.
const originals = { push: webPushService.send, telegram: telegramService.send, ntfy: ntfyService.send, settings: configService.get("notifications") };
afterAll(() => {
  webPushService.send = originals.push;
  telegramService.send = originals.telegram;
  ntfyService.send = originals.ntfy;
  configService.set("notifications", originals.settings!);
});

let pushed: Array<{ title: string; tag: string; path: string }>;
let telegrammed: NotificationPayload[];
webPushService.send = (async (message: (typeof pushed)[number]) => {
  pushed.push(message);
  return { sent: 1, failed: 0, removed: 0 };
}) as unknown as typeof webPushService.send;
telegramService.send = (async (payload: NotificationPayload) => { telegrammed.push(payload); }) as typeof telegramService.send;
ntfyService.send = (async () => {}) as typeof ntfyService.send;

function settings(patch: Partial<NotificationSettings>): void {
  configService.set("notifications", { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), ...patch });
}

const CHAT = "chat-sched-notify";
const target: ScheduleTargetDeps = {
  canonical: (id) => id,
  stored: (id, read) => read(id),
  isDesign: () => false,
  isAssistant: () => false,
  hasClaudeTranscript: () => false,
  projectByPath: (p) => (p === "/work/proj" ? { name: "proj", path: "/work/proj" } : null),
  projectPath: (id) => (id === CHAT ? "/work/proj" : null),
  provider: (id) => (id === CHAT ? "claude" : null),
};
/** The live notice sender behind a chat the test makes up. */
const env = (): SessionScheduleToolEnv => ({
  target, changed: () => {}, now: () => new Date("2026-11-15T01:00:00Z"), localZone: () => "Asia/Saigon",
  chatTitle: () => "Nightly", notify: sendAiScheduleNotice, noticeLimit: new AiScheduleNoticeLimit(),
});
type Result = { content: Array<{ text: string }> };
const create = (e: SessionScheduleToolEnv) =>
  JSON.parse((sessionScheduleToolCall(e, CHAT, "session_schedule_create" as never, { cron: "0 9 * * *", prompt: "Check" }) as Result).content[0]!.text).id as number;

/** Waits until the channels have answered, or `ms` passes. */
async function settle(ms: number, done: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}

const notice = (stillRelevant?: () => boolean) => ({
  payload: { title: "AI scheduled a prompt: Check", body: "In Nightly (proj).", project: "proj", sessionId: CHAT, providerId: "claude" },
  key: "session-schedule-created-42",
  ...(stillRelevant ? { stillRelevant } : {}),
});

describe("the AI-created schedule notice, sent for real", () => {
  beforeEach(() => {
    setDb(openTestDb());
    pushed = [];
    telegrammed = [];
  });

  it("goes out under its own key, so it neither replaces nor is replaced by the chat's own notification", async () => {
    settings({ delay_seconds: 0 });
    expect(await sendAiScheduleNotice(notice())).toBe("sent");
    expect(pushed).toEqual([expect.objectContaining({ tag: "ppm-session-schedule-created-42", path: "/project/proj?openChat=claude%2Fchat-sched-notify" })]);
    expect(telegrammed.map((p) => p.title)).toEqual(["AI scheduled a prompt: Check"]);
  });

  it("is not sent when the user switched the event off", async () => {
    settings({ delay_seconds: 0, events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, schedule_created: false } });
    expect(await sendAiScheduleNotice(notice())).toBe("off");
    expect(pushed).toEqual([]);
    expect(telegrammed).toEqual([]);
  });

  it("asks whether it is still relevant once the delay ends, and sends nothing when it is not", async () => {
    settings({ delay_seconds: 1 });
    const [gone, kept] = await Promise.all([sendAiScheduleNotice(notice(() => false)), sendAiScheduleNotice({ ...notice(() => true), key: "k2" })]);
    expect(gone).toBe("seen");
    expect(kept).toBe("sent");
    expect(pushed.map((p) => p.tag)).toEqual(["ppm-k2"]);
  }, 10_000);

  it("announces a schedule the AI created, but not one it deleted before the delay ended", async () => {
    settings({ delay_seconds: 1 });
    const e = env();
    const kept = create(e);
    const gone = create(e);
    sessionScheduleToolCall(e, CHAT, "session_schedule_delete" as never, { id: gone });
    expect(getSchedule(gone)).toBeNull();
    await settle(3000, () => pushed.length > 0 && telegrammed.length > 0);
    await new Promise((r) => setTimeout(r, 200)); // give the deleted one's timer its chance to misfire
    expect(pushed.map((p) => p.tag)).toEqual([`ppm-session-schedule-created-${kept}`]);
  }, 10_000);
});
