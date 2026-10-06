import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { configService } from "../../../src/services/config.service.ts";
import { NotificationService, type NotificationPayload } from "../../../src/services/notification.service.ts";
import { webPushService } from "../../../src/services/web-push/web-push.service.ts";
import { telegramService } from "../../../src/services/telegram-notification.service.ts";
import { ntfyService } from "../../../src/services/ntfy-notification.service.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../../src/shared/notification-settings.ts";
import { openTestDb, setDb, setSessionProvider } from "../../../src/services/db.service.ts";

// Patch the channel singletons rather than mock.module, which leaks across test files.
const originals = { push: webPushService.send, telegram: telegramService.send, ntfy: ntfyService.send, settings: configService.get("notifications") };
afterAll(() => {
  webPushService.send = originals.push;
  telegramService.send = originals.telegram;
  ntfyService.send = originals.ntfy;
  configService.set("notifications", originals.settings!);
});

let pushed: Array<{ title: string; body: string; path: string; tag: string; urgency: string; providerId: string }>;
let telegrammed: NotificationPayload[];
let ntfied: Array<{ title: string; urgent: boolean }>;
webPushService.send = (async (message: (typeof pushed)[number]) => {
  pushed.push(message);
  return { sent: 1, failed: 0, removed: 0 };
}) as unknown as typeof webPushService.send;
telegramService.send = (async (payload: NotificationPayload) => { telegrammed.push(payload); }) as typeof telegramService.send;
const recordNtfy = (async (payload: NotificationPayload, urgent: boolean) => { ntfied.push({ title: payload.title, urgent }); }) as typeof ntfyService.send;
ntfyService.send = recordNtfy;

function settings(patch: Partial<NotificationSettings>): void {
  configService.set("notifications", { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), ...patch });
}

const payload = (sessionId = "s1", extra: Partial<NotificationPayload> = {}): NotificationPayload => ({
  title: "Chat completed", body: "ppm — Fix login", project: "ppm", sessionId, ...extra,
});

// One "second" of delay is one millisecond here.
const service = () => new NotificationService(1);

describe("NotificationService.broadcast", () => {
  beforeEach(() => {
    setDb(openTestDb());
    pushed = [];
    telegrammed = [];
    ntfied = [];
    ntfyService.send = recordNtfy;
    settings({});
  });

  it("names the session's provider in the link, from the event or else from the session's record", async () => {
    settings({ delay_seconds: 0 });
    await service().broadcast("done", payload("s1", { providerId: "codex" }));
    setSessionProvider("s2", "codex");
    await service().broadcast("done", payload("s2"));
    await service().broadcast("done", payload("s3"));
    expect(pushed.map((p) => [p.path, p.providerId])).toEqual([
      ["/project/ppm?openChat=codex%2Fs1", "codex"],
      ["/project/ppm?openChat=codex%2Fs2", "codex"],
      ["/project/ppm?openChat=s3", ""],
    ]);
    expect(telegrammed.map((p) => p.providerId)).toEqual(["codex", "codex", undefined]);
  });

  it("sends to push, Telegram and ntfy right away when the delay is 0", async () => {
    settings({ delay_seconds: 0 });
    await service().broadcast("done", payload("s1", { detail: "All 12 tests pass." }));
    expect(telegrammed).toHaveLength(1);
    expect(ntfied).toEqual([{ title: "Chat completed", urgent: false }]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      title: "Chat completed · PPM",
      body: "ppm — Fix login\nAll 12 tests pass.",
      path: "/project/ppm?openChat=s1",
      tag: "ppm-s1",
      urgency: "normal",
    });
  });

  it("marks approvals and questions urgent", async () => {
    settings({ delay_seconds: 0 });
    await service().broadcast("approval_request", payload());
    await service().broadcast("question", payload("s2"));
    expect(pushed.map((p) => p.urgency)).toEqual(["high", "high"]);
    expect(ntfied.map((n) => n.urgent)).toEqual([true, true]);
  });

  it("sends no ntfy when ntfy is off, and an ntfy failure costs the other channels nothing", async () => {
    settings({ delay_seconds: 0, ntfy: false });
    await service().broadcast("done", payload());
    expect(ntfied).toHaveLength(0);
    expect(pushed).toHaveLength(1);

    settings({ delay_seconds: 0 });
    ntfyService.send = async () => { throw new Error("ntfy.example.com answered 500"); };
    await service().broadcast("done", payload("s2"));
    expect(pushed).toHaveLength(2);
    expect(telegrammed).toHaveLength(2);
  });

  it("sends nothing for a switched-off event, and no Telegram when Telegram is off", async () => {
    settings({ delay_seconds: 0, events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, jira: false }, telegram: false });
    await service().broadcast("jira", payload(""));
    expect(pushed).toHaveLength(0);
    await service().broadcast("done", payload());
    expect(pushed).toHaveLength(1);
    expect(telegrammed).toHaveLength(0);
  });

  it("waits the delay, then drops what was seen meanwhile", async () => {
    settings({ delay_seconds: 30 });
    let unread = 1;
    const sent = service().broadcast("done", payload(), { stillUnseen: () => unread > 0 });
    unread = 0; // the session was opened on some device before the delay ran out
    await sent;
    expect(pushed).toHaveLength(0);
    expect(telegrammed).toHaveLength(0);
  });

  it("waits the delay, then sends what is still unseen", async () => {
    settings({ delay_seconds: 30 });
    const started = performance.now();
    await service().broadcast("done", payload(), { stillUnseen: () => true });
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(pushed).toHaveLength(1);
    expect(telegrammed).toHaveLength(1);
  });

  it("sends when it cannot tell whether it was seen", async () => {
    settings({ delay_seconds: 1 });
    await service().broadcast("approval_request", payload(), { stillUnseen: () => { throw new Error("db closed"); } });
    expect(pushed).toHaveLength(1);
  });

  it("keeps only the newest pending notification per session", async () => {
    settings({ delay_seconds: 20 });
    const svc = service();
    const first = svc.broadcast("done", payload("s1", { title: "first" }), { stillUnseen: () => true });
    const second = svc.broadcast("approval_request", payload("s1", { title: "second" }), { stillUnseen: () => true });
    const other = svc.broadcast("done", payload("s2", { title: "other session" }), { stillUnseen: () => true });
    await Promise.all([first, second, other]);
    expect(telegrammed.map((p) => p.title).sort()).toEqual(["other session", "second"]);
  });

  it("does not collapse events that belong to no session", async () => {
    settings({ delay_seconds: 1 });
    const svc = service();
    await Promise.all([svc.broadcast("jira", payload("", { title: "a" })), svc.broadcast("jira", payload("", { title: "b" }))]);
    expect(telegrammed).toHaveLength(2);
    expect(new Set(pushed.map((p) => p.tag)).size).toBe(2);
    expect(pushed[0]!.path).toBe("/project/ppm");
  });
});
