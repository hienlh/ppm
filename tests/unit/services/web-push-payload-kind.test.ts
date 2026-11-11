import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { NotificationService, type NotificationPayload, type NotificationType } from "../../../src/services/notification.service.ts";
import { ntfyService } from "../../../src/services/ntfy-notification.service.ts";
import { telegramService } from "../../../src/services/telegram-notification.service.ts";
import { webPushService, type PushMessage } from "../../../src/services/web-push/web-push.service.ts";
import { FEED_KINDS, type FeedKind } from "../../../src/shared/notification-feed.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../../src/shared/notification-settings.ts";
import { OPEN_FROM_NOTIFICATION, readWebPushPayload, type WebPushPayload } from "../../../src/shared/web-push-payload.ts";
import { routeNotificationClick, type NotificationWindow } from "../../../src/web/sw-notification-click.ts";
import { decryptPushBody, makeReceiver } from "../../helpers/web-push-receiver.ts";

const realFetch = globalThis.fetch;
const originals = {
  push: webPushService.send,
  telegram: telegramService.send,
  ntfy: ntfyService.send,
  settings: configService.get("notifications"),
};

afterAll(() => {
  globalThis.fetch = realFetch;
  webPushService.send = originals.push;
  telegramService.send = originals.telegram;
  ntfyService.send = originals.ntfy;
  configService.set("notifications", originals.settings!);
});

function setNotificationSettings(patch: Partial<NotificationSettings>): void {
  configService.set("notifications", { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), ...patch });
}

describe("WebPushPayload kind", () => {
  beforeEach(() => {
    setDb(openTestDb());
    globalThis.fetch = realFetch;
    webPushService.send = originals.push;
    telegramService.send = (async () => "sent") as unknown as typeof telegramService.send;
    ntfyService.send = (async () => {}) as typeof ntfyService.send;
    setNotificationSettings({ delay_seconds: 0 });
  });

  it("reads valid kind values in readWebPushPayload and ignores unknown ones", () => {
    for (const kind of FEED_KINDS) {
      const parsed = readWebPushPayload({
        title: "PPM",
        body: "Body",
        url: "/project/ppm",
        tag: "ppm-1",
        project: "ppm",
        sessionId: "s1",
        providerId: "claude",
        kind,
      });
      expect(parsed.kind).toBe(kind);
    }

    expect(readWebPushPayload({ title: "PPM", kind: "unknown-kind" }).kind).toBeUndefined();
    expect(readWebPushPayload({ title: "PPM", kind: 42 }).kind).toBeUndefined();
    expect(readWebPushPayload(null).kind).toBeUndefined();
  });

  it("ignores kind in service worker notification click routing", async () => {
    const origin = "https://ppm.example";
    const push = readWebPushPayload({
      title: "Waiting for approval",
      body: "ppm — Bash",
      url: `${origin}/project/ppm?openChat=s1`,
      tag: "ppm-s1",
      project: "ppm",
      sessionId: "s1",
      providerId: "claude",
      kind: "approval",
    });
    expect(push.kind).toBe("approval");

    const posted: unknown[] = [];
    const win: NotificationWindow = {
      url: `${origin}/project/ppm`,
      focused: true,
      visibilityState: "visible",
      postMessage: (m) => { posted.push(m); },
      focus: async () => win,
    };
    await routeNotificationClick(push, {
      matchAll: async () => [win],
      openWindow: async () => null,
    }, origin);

    expect(posted).toEqual([
      {
        type: OPEN_FROM_NOTIFICATION,
        url: `${origin}/project/ppm?openChat=s1`,
        project: "ppm",
        sessionId: "s1",
        providerId: "claude",
      },
    ]);
  });

  it("populates kind on PushMessage for each NotificationService event type", async () => {
    const pushed: PushMessage[] = [];
    webPushService.send = (async (msg: PushMessage) => {
      pushed.push(msg);
      return { sent: 1, failed: 0, removed: 0 };
    }) as typeof webPushService.send;

    const svc = new NotificationService(1);
    const makePayload = (title: string, sessionId = "s1"): NotificationPayload => ({
      title,
      body: "ppm — Task",
      project: "ppm",
      sessionId,
    });

    const cases: Array<[NotificationType, FeedKind]> = [
      ["approval_request", "approval"],
      ["collab_approval", "approval"],
      ["question", "question"],
      ["done", "done"],
      ["schedule", "schedule"],
      ["jira", "other"],
      ["design_review", "other"],
    ];

    for (const [idx, [eventType]] of cases.entries()) {
      await svc.broadcast(eventType, makePayload(`Event ${idx}`, `s-${idx}`));
    }

    expect(pushed.map((p) => (p as WebPushPayload).kind)).toEqual(cases.map(([, expectedKind]) => expectedKind));
  });

  it("encrypts kind into the Web Push payload delivered by webPushService.send", async () => {
    const capturedBodies: Uint8Array<ArrayBuffer>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBodies.push(new Uint8Array(init?.body as Uint8Array));
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const receiver = await makeReceiver();
    await webPushService.subscribe(
      receiver.subscription("https://fcm.googleapis.com/fcm/send/device-1"),
      "Android · Pixel",
      "https://ppm.example.ts.net",
    );

    const svc = new NotificationService(1);
    await svc.broadcast("approval_request", {
      title: "Waiting for approval",
      body: "ppm — Run migration",
      project: "ppm",
      sessionId: "s-approval",
      providerId: "claude",
    });

    expect(capturedBodies).toHaveLength(1);
    const decrypted = JSON.parse(
      new TextDecoder().decode(await decryptPushBody(capturedBodies[0]!, receiver)),
    ) as WebPushPayload;

    expect(decrypted).toMatchObject({
      title: "Waiting for approval · PPM",
      body: "ppm — Run migration",
      url: "https://ppm.example.ts.net/project/ppm?openChat=claude%2Fs-approval",
      tag: "ppm-s-approval",
      project: "ppm",
      sessionId: "s-approval",
      providerId: "claude",
      kind: "approval",
    });
  });
});
