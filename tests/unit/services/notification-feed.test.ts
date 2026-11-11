import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { globalWebSocket } from "../../../src/server/ws/global.ts";
import { configService } from "../../../src/services/config.service.ts";
import { CURRENT_SCHEMA_VERSION, getDb, openTestDb, setDb } from "../../../src/services/db.service.ts";
import {
  FEED_RETENTION_MS,
  FeedNotFoundError,
  list,
  markSessionRead,
  MAX_FEED_ROWS,
  prune,
  readAll,
  record,
  setRead,
} from "../../../src/services/notification-feed.service.ts";
import { NotificationService, type NotificationPayload } from "../../../src/services/notification.service.ts";
import { ntfyService } from "../../../src/services/ntfy-notification.service.ts";
import { telegramService } from "../../../src/services/telegram-notification.service.ts";
import { webPushService } from "../../../src/services/web-push/web-push.service.ts";
import { NOTIFICATION_FEED_CHANGED_EVENT } from "../../../src/shared/notification-feed.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../../src/shared/notification-settings.ts";

const originals = {
  push: webPushService.send,
  telegram: telegramService.send,
  ntfy: ntfyService.send,
  settings: configService.get("notifications"),
};

afterAll(() => {
  webPushService.send = originals.push;
  telegramService.send = originals.telegram;
  ntfyService.send = originals.ntfy;
  configService.set("notifications", originals.settings!);
});

webPushService.send = (async () => ({ sent: 1, failed: 0, removed: 0 })) as unknown as typeof webPushService.send;
telegramService.send = (async () => "sent") as unknown as typeof telegramService.send;
ntfyService.send = (async () => {}) as typeof ntfyService.send;

function setNotificationSettings(patch: Partial<NotificationSettings>): void {
  configService.set("notifications", { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), ...patch });
}

describe("notification_feed schema and service", () => {
  let wsEvents: unknown[];
  const socket = {
    data: { type: "global" },
    send: (raw: string) => {
      wsEvents.push(JSON.parse(raw));
      return raw.length;
    },
  };

  beforeEach(() => {
    setDb(openTestDb());
    setNotificationSettings({ delay_seconds: 0 });
    wsEvents = [];
    globalWebSocket.open(socket);
    wsEvents = [];
  });

  afterEach(() => {
    globalWebSocket.close(socket);
  });

  it("creates the notification_feed table and indexes at CURRENT_SCHEMA_VERSION", () => {
    const db = getDb();
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(61);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);

    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("notification_feed");

    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain("notification_feed_created");
    expect(indexes).toContain("notification_feed_session");
  });

  it("records notifications, lists them newest first, and paginates with limit and before", () => {
    const r1 = record({
      kind: "done",
      projectName: "ppm",
      sessionId: "s1",
      title: "Chat completed",
      body: "ppm — First task",
      createdAt: 1000,
    });
    const r2 = record({
      kind: "schedule",
      projectName: "ppm",
      scheduleId: "sched-1",
      title: "Schedule: Nightly backup — error",
      body: "Failed: disk full",
      createdAt: 2000,
    });
    const r3 = record({
      kind: "approval",
      projectName: "ppm",
      sessionId: "s2",
      title: "Waiting for approval",
      body: "ppm — Bash needs permission",
      createdAt: 3000,
    });

    expect(r1).toMatchObject({
      kind: "done",
      project: "ppm",
      sessionId: "s1",
      scheduleId: null,
      title: "Chat completed",
      body: "ppm — First task",
      createdAt: 1000,
      read: false,
    });
    expect(r2.scheduleId).toBe("sched-1");
    expect(r2.sessionId).toBeNull();

    const firstPage = list({ limit: 2 });
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.rows.map((r) => r.id)).toEqual([r3.id, r2.id]);

    const secondPageById = list({ limit: 2, before: r2.id });
    expect(secondPageById.hasMore).toBe(false);
    expect(secondPageById.rows.map((r) => r.id)).toEqual([r1.id]);

    const secondPageByTimestamp = list({ limit: 2, before: r2.createdAt });
    expect(secondPageByTimestamp.hasMore).toBe(false);
    expect(secondPageByTimestamp.rows.map((r) => r.id)).toEqual([r1.id]);
  });

  it("marks individual notifications read and unread and emits notifications:feed_changed", () => {
    const row = record({
      kind: "question",
      projectName: "ppm",
      sessionId: "s1",
      title: "AI has a question",
      body: "ppm — Question",
    });
    wsEvents = [];

    const markedRead = setRead(row.id, true);
    expect(markedRead.read).toBe(true);
    expect(list().rows[0]?.read).toBe(true);
    expect(wsEvents).toContainEqual({ type: NOTIFICATION_FEED_CHANGED_EVENT });

    wsEvents = [];
    const markedUnread = setRead(row.id, false);
    expect(markedUnread.read).toBe(false);
    expect(list().rows[0]?.read).toBe(false);
    expect(wsEvents).toContainEqual({ type: NOTIFICATION_FEED_CHANGED_EVENT });

    expect(() => setRead(999_999, true)).toThrow(FeedNotFoundError);
  });

  it("marks all notifications for a session read via markSessionRead", () => {
    const s1a = record({ kind: "approval", projectName: "ppm", sessionId: "s1", title: "Approval", body: "b1" });
    const s1b = record({ kind: "done", projectName: "ppm", sessionId: "s1", title: "Done", body: "b2" });
    const s2 = record({ kind: "done", projectName: "ppm", sessionId: "s2", title: "Other", body: "b3" });
    const sched = record({ kind: "schedule", projectName: "ppm", scheduleId: "42", title: "Schedule", body: "b4" });
    wsEvents = [];

    markSessionRead("s1");

    const rowsById = new Map(list().rows.map((r) => [r.id, r.read]));
    expect(rowsById.get(s1a.id)).toBe(true);
    expect(rowsById.get(s1b.id)).toBe(true);
    expect(rowsById.get(s2.id)).toBe(false);
    expect(rowsById.get(sched.id)).toBe(false);
    expect(wsEvents).toContainEqual({ type: NOTIFICATION_FEED_CHANGED_EVENT });
  });

  it("marks every notification read via readAll", () => {
    record({ kind: "done", projectName: "ppm", sessionId: "s1", title: "One", body: "b1" });
    record({ kind: "schedule", projectName: "ppm", scheduleId: "7", title: "Two", body: "b2" });
    wsEvents = [];

    readAll();

    const rows = list().rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.read)).toBe(true);
    expect(wsEvents).toContainEqual({ type: NOTIFICATION_FEED_CHANGED_EVENT });
  });

  it("prunes rows older than 30 days and caps the feed at 500 rows", () => {
    const now = 1_700_000_000_000;
    const tooOld = record({
      kind: "done",
      projectName: "ppm",
      title: "Old",
      body: "expired",
      createdAt: now - FEED_RETENTION_MS - 1000,
    });
    const recent = record({
      kind: "done",
      projectName: "ppm",
      title: "Recent",
      body: "kept",
      createdAt: now - 1000,
    });

    prune(now);
    expect(list({ limit: 100 }).rows.map((r) => r.id)).toEqual([recent.id]);
    expect(list({ limit: 100 }).rows.map((r) => r.id)).not.toContain(tooOld.id);

    // Insert 505 fresh rows and verify only the newest 500 remain after prune
    for (let i = 0; i < MAX_FEED_ROWS + 5; i++) {
      record({
        kind: "done",
        projectName: "ppm",
        title: `Row ${i}`,
        body: "",
        createdAt: now + i,
      });
    }
    prune(now + MAX_FEED_ROWS + 10);

    const countRow = getDb().query("SELECT COUNT(*) AS n FROM notification_feed").get() as { n: number };
    expect(countRow.n).toBe(MAX_FEED_ROWS);
    const newest = list({ limit: 1 }).rows[0];
    expect(newest?.title).toBe(`Row ${MAX_FEED_ROWS + 4}`);
  });

  it("records a feed entry whenever NotificationService delivers a chat or schedule notification", async () => {
    const svc = new NotificationService(1);
    const basePayload = (extra: Partial<NotificationPayload> = {}): NotificationPayload => ({
      title: "Chat completed",
      body: "ppm — Fix login",
      project: "ppm",
      sessionId: "s1",
      ...extra,
    });

    await svc.broadcast("approval_request", basePayload({ title: "Waiting for approval" }));
    await svc.broadcast("question", basePayload({ sessionId: "s2", title: "AI has a question" }));
    await svc.broadcast("done", basePayload({ sessionId: "s3", title: "Chat completed" }));
    await svc.broadcast("schedule", {
      title: "Schedule: Nightly backup — ok",
      body: "Backup finished",
      project: "ppm",
      sessionId: "",
    });

    const rows = list({ limit: 10 }).rows;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => [r.kind, r.title, r.sessionId, r.read])).toEqual([
      ["schedule", "Schedule: Nightly backup — ok", null, false],
      ["done", "Chat completed", "s3", false],
      ["question", "AI has a question", "s2", false],
      ["approval", "Waiting for approval", "s1", false],
    ]);

    // Switched-off events are not delivered and therefore not recorded
    setNotificationSettings({
      delay_seconds: 0,
      events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, schedule: false },
    });
    await svc.broadcast("schedule", {
      title: "Schedule: Muted",
      body: "Should not record",
      project: "ppm",
      sessionId: "",
    });
    expect(list({ limit: 10 }).rows).toHaveLength(4);
  });
});
