import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { NotificationService, type NotificationPayload } from "../../../src/services/notification.service.ts";
import { webPushService } from "../../../src/services/web-push/web-push.service.ts";
import { telegramService } from "../../../src/services/telegram-notification.service.ts";
import { ntfyService } from "../../../src/services/ntfy-notification.service.ts";
import { formatTelegramNotification } from "../../../src/services/notification-format.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../../src/shared/notification-settings.ts";
import {
  DesignShareNotifier, formatReviewerNames, type GuestWrite,
} from "../../../src/services/design/share/design-share-notifier.ts";
import type { ShareLinkRecord } from "../../../src/services/design/share/design-share-links-store.ts";
import { shareRateClock } from "../../../src/services/design/share/design-share-rate-limit.ts";
import { guestHeaders, guestKey, makeShareFixture } from "../server/design-share-guest-fixture.ts";

// Patch the channel singletons rather than mock.module, which leaks across test files.
const originals = {
  push: webPushService.send, telegram: telegramService.send, ntfy: ntfyService.send,
  settings: configService.get("notifications"), projects: [...configService.get("projects")],
};
afterAll(() => {
  webPushService.send = originals.push;
  telegramService.send = originals.telegram;
  ntfyService.send = originals.ntfy;
  configService.set("notifications", originals.settings!);
  configService.set("projects", originals.projects);
});

let pushed: Array<{ title: string; body: string; path: string; tag: string }>;
let telegrammed: NotificationPayload[];
webPushService.send = (async (message: (typeof pushed)[number]) => {
  pushed.push(message);
  return { sent: 1, failed: 0, removed: 0 };
}) as unknown as typeof webPushService.send;
telegramService.send = (async (payload: NotificationPayload) => { telegrammed.push(payload); return "sent=1"; }) as typeof telegramService.send;
ntfyService.send = (async () => {}) as typeof ntfyService.send;

function settings(patch: Partial<NotificationSettings>): void {
  configService.set("notifications", { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), ...patch });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROJECT_PATH = process.platform === "win32" ? "C:\\work\\shop" : "/work/shop";

function link(id = "a1b2c3d4e5f6"): Pick<ShareLinkRecord, "id" | "projectPath" | "slug"> {
  return { id, projectPath: PROJECT_PATH, slug: "landing" };
}

/** Delay "seconds" are milliseconds here; the floor is 60 ms. */
function makeNotifier(floorMs = 60) {
  const notifications = new NotificationService(1);
  return new DesignShareNotifier({
    broadcast: (type, payload, opts) => notifications.broadcast(type, payload, opts),
    floorMs,
    titleOf: async () => "Landing page",
  });
}

const note = (n: DesignShareNotifier, write: GuestWrite, id?: string) =>
  n.noteGuestWrite({ link: link(id) as ShareLinkRecord, designDir: "/unused" }, write);

describe("DesignShareNotifier", () => {
  beforeEach(() => {
    pushed = [];
    telegrammed = [];
    configService.set("projects", [{ name: "shop", path: PROJECT_PATH }]);
    settings({});
  });

  it("folds five writes inside the delay into one notification that opens the design", async () => {
    settings({ delay_seconds: 40 });
    const n = makeNotifier();
    for (const name of ["Alice", "Bob", "Alice", "Carol", "Dan"]) await note(n, { name, body: `from ${name}` });
    await sleep(120);
    expect(pushed).toHaveLength(1);
    expect(telegrammed).toHaveLength(1);
    expect(telegrammed[0]).toMatchObject({
      title: "New design feedback",
      body: "5 new comments on Landing page from Alice, Bob, Carol and 1 more",
      detail: "from Dan",
      project: "shop",
      sessionId: "",
      path: "/project/shop/design/landing",
    });
    expect(pushed[0]!.path).toBe("/project/shop/design/landing");
    expect(pushed[0]!.tag).toBe("ppm-design-share:a1b2c3d4e5f6");
    expect(n.pendingCount()).toBe(0);
  });

  it("with no delay, sends once, then one summary when the floor ends", async () => {
    settings({ delay_seconds: 0 });
    const n = makeNotifier();
    for (let i = 0; i < 10; i++) await note(n, { name: i < 5 ? "Ann" : "Ben", body: `c${i}` });
    await sleep(5);
    expect(telegrammed.map((p) => p.body)).toEqual(["1 new comment on Landing page from Ann"]);
    await sleep(90);
    expect(telegrammed.map((p) => p.body)).toEqual([
      "1 new comment on Landing page from Ann",
      "9 new comments on Landing page from Ann and Ben",
    ]);
    expect(telegrammed[1]!.detail).toBe("c9");
    await sleep(80);
    expect(telegrammed).toHaveLength(2);
  });

  it("keeps links apart", async () => {
    settings({ delay_seconds: 0 });
    const n = makeNotifier();
    await note(n, { name: "Ann", body: "x" }, "aaaaaaaaaaaa");
    await note(n, { name: "Ben", body: "y" }, "bbbbbbbbbbbb");
    await sleep(5);
    expect(telegrammed.map((p) => p.body)).toEqual([
      "1 new comment on Landing page from Ann",
      "1 new comment on Landing page from Ben",
    ]);
  });

  it("sends nothing while the event is switched off, and does not save the writes up", async () => {
    settings({ delay_seconds: 0, events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, design_review: false } });
    const n = makeNotifier(0);
    await note(n, { name: "Ann", body: "x" });
    await note(n, { name: "Ann", body: "y" });
    await sleep(5);
    expect(pushed).toHaveLength(0);
    expect(n.pendingCount()).toBe(0);

    settings({ delay_seconds: 0 });
    await note(n, { name: "Ben", body: "z" });
    await sleep(5);
    expect(telegrammed.map((p) => p.body)).toEqual(["1 new comment on Landing page from Ben"]);
  });

  it("reduces reviewer text to one capped line, and Telegram shows it escaped", async () => {
    settings({ delay_seconds: 0 });
    const n = makeNotifier();
    await note(n, { name: "<b>Eve</b>\u202e", body: `<a href="https://evil.example">click</a>\n\n${"x".repeat(500)}` });
    await sleep(5);
    const sent = telegrammed[0]!;
    expect(sent.body).toBe("1 new comment on Landing page from <b>Eve</b>");
    expect(sent.detail!.length).toBeLessThanOrEqual(200);
    expect(sent.detail).not.toContain("\n");
    const html = formatTelegramNotification(sent, "PPM", "https://ppm.example/project/shop/design/landing");
    expect(html).not.toContain("<b>Eve");
    expect(html).not.toContain("<a href=\"https://evil");
    expect(html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
  });

  it("opens the project's root when the project is not registered", async () => {
    settings({ delay_seconds: 0 });
    configService.set("projects", []);
    const n = makeNotifier();
    await note(n, { name: "Ann", body: "x" });
    await sleep(5);
    expect(telegrammed[0]!.path).toBeUndefined();
    expect(pushed[0]!.path).toBe("/");
  });
});

describe("formatReviewerNames", () => {
  it("names up to three reviewers, then counts the rest", () => {
    expect(formatReviewerNames([])).toBe("a reviewer");
    expect(formatReviewerNames(["Ann", "Ann"])).toBe("Ann");
    expect(formatReviewerNames(["Ann", "Ben"])).toBe("Ann and Ben");
    expect(formatReviewerNames(["Ann", "Ben", "Cy"])).toBe("Ann, Ben and Cy");
    expect(formatReviewerNames(["Ann", "Ben", "Cy", "Di", "Ed"])).toBe("Ann, Ben, Cy and 2 more");
  });
});

describe("guest routes tell the notifier", () => {
  it("for a new comment and a new reply, not for an edit", async () => {
    const f = await makeShareFixture();
    let now = 1_000_000;
    shareRateClock.now = () => (now += 600);
    try {
      const key = guestKey("ann");
      const anchor = { file: "index.html", ppmId: null, gen: null, tag: "h1", cssPath: "h1", quote: { exact: "Pinned", prefix: "", suffix: "" } };
      const send = (method: string, path: string, body: unknown) =>
        f.get(path, { method, headers: guestHeaders(key), body: JSON.stringify(body) });
      const created = await send("POST", "/comments", { anchor, name: "Ann", body: "Bigger logo", versionId: f.link.snapshotId });
      expect(created.status).toBe(201);
      const id = (await created.json()).data.thread.id;
      expect((await send("POST", `/comments/${id}/replies`, { name: "Ann", body: "And bolder" })).status).toBe(201);
      expect((await send("PATCH", `/comments/${id}`, { body: "Edited" })).status).toBe(200);
      expect(f.notes).toEqual([{ name: "Ann", body: "Bigger logo" }, { name: "Ann", body: "And bolder" }]);
    } finally {
      f.restore();
    }
  });
});
