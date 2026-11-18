import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { list } from "../../../src/services/notification-feed.service.ts";
import { ntfyService } from "../../../src/services/ntfy-notification.service.ts";
import { ctxHost } from "../../../src/services/schedule-script/ctx-host.ts";
import { getSchedule, insertSchedule } from "../../../src/services/scheduler-db.service.ts";
import { runScheduleOnce } from "../../../src/services/scheduler-runner.ts";
import { liveDispatchEnv } from "../../../src/services/session-schedules/session-schedule-dispatch-env.ts";
import { telegramService } from "../../../src/services/telegram-notification.service.ts";
import { webPushService } from "../../../src/services/web-push/web-push.service.ts";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../../../src/shared/notification-settings.ts";
import type { ChatEvent } from "../../../src/types/chat.ts";
import type { Schedule } from "../../../src/types/scheduler.ts";

// Every channel stubbed, so a notification goes nowhere but the feed. Singletons are patched
// and restored rather than mock.module'd, which would leak into other test files.
const originals = {
  push: webPushService.send,
  telegram: telegramService.send,
  ntfy: ntfyService.send,
  sendMessage: chatService.sendMessage,
  settings: configService.get("notifications"),
};
afterAll(() => {
  webPushService.send = originals.push;
  telegramService.send = originals.telegram;
  ntfyService.send = originals.ntfy;
  chatService.sendMessage = originals.sendMessage;
  configService.set("notifications", originals.settings!);
});
webPushService.send = (async () => ({ sent: 1, failed: 0, removed: 0 })) as unknown as typeof webPushService.send;
telegramService.send = (async () => "sent") as unknown as typeof telegramService.send;
ntfyService.send = (async () => {}) as typeof ntfyService.send;

function makeSchedule(over: Partial<Parameters<typeof insertSchedule>[0]> = {}): Schedule {
  return getSchedule(insertSchedule({
    name: "nightly", cron_expr: "0 * * * * *", provider_id: "mock", project_path: "/tmp/not-a-project", prompt: "go",
    ...over,
  }))!;
}

/** The senders queue their broadcast without awaiting it; wait until the feed holds a row. */
async function feedRows() {
  for (let i = 0; i < 100; i++) {
    const rows = list({ limit: 10 }).rows;
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

describe("schedule notifications in the feed carry their schedule id", () => {
  beforeEach(() => {
    setDb(openTestDb());
    configService.set("notifications", { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), delay_seconds: 0 });
  });

  it("a prompt schedule's run summary", async () => {
    const events: ChatEvent[] = [{ type: "text", content: "all good" }, { type: "done", sessionId: "s", resultSubtype: "success" }];
    chatService.sendMessage = async function* () { for (const ev of events) yield ev; } as typeof chatService.sendMessage;
    const schedule = makeSchedule();

    await runScheduleOnce(schedule, "s");

    const rows = await feedRows();
    expect(rows.map((r) => [r.kind, r.scheduleId])).toEqual([["schedule", String(schedule.id)]]);
  });

  it("a script schedule's ctx.notify", async () => {
    const schedule = makeSchedule({ kind: "script", mode: "tick", script: "export default async () => {}" });

    await ctxHost(schedule)("notify", { title: "PR #12 approved", body: "by a reviewer" });

    const rows = await feedRows();
    expect(rows.map((r) => [r.kind, r.title, r.scheduleId])).toEqual([["schedule", "PR #12 approved", String(schedule.id)]]);
  });

  it("a session schedule's notice about one schedule, and none for a notice about several", async () => {
    const one = makeSchedule();
    const other = makeSchedule();
    const notify = liveDispatchEnv().notify;
    const notice = { kind: "failed" as const, sessionId: "chat-1", projectName: "", title: "Schedule failed", body: "b" };

    notify({ ...notice, key: `failed:${one.id}`, schedules: [one] });
    const rows = await feedRows();
    expect(rows.map((r) => [r.kind, r.scheduleId])).toEqual([["schedule", String(one.id)]]);

    setDb(openTestDb());
    notify({ ...notice, kind: "paused", key: "paused-chat:chat-1", schedules: [one, other], title: "Schedules paused" });
    const pausedRows = await feedRows();
    expect(pausedRows.map((r) => [r.title, r.scheduleId])).toEqual([["Schedules paused", null]]);
  });
});
