import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { notificationRoutes } from "../../../src/server/routes/notifications.ts";
import { globalWebSocket } from "../../../src/server/ws/global.ts";
import { getSessionUnreadCount, openTestDb, setDb, setSessionUnread } from "../../../src/services/db.service.ts";
import { list, record } from "../../../src/services/notification-feed.service.ts";
import { NOTIFICATION_FEED_CHANGED_EVENT } from "../../../src/shared/notification-feed.ts";

const app = new Hono()
  .route("/api/notifications", notificationRoutes)
  .route("/chat", chatRoutes);

async function request(method: string, path: string, body?: unknown) {
  const res = await app.request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as { ok: boolean; data?: any; error?: string },
  };
}

describe("notification feed HTTP routes", () => {
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
    wsEvents = [];
    globalWebSocket.open(socket);
    wsEvents = [];
  });

  afterEach(() => {
    globalWebSocket.close(socket);
  });

  it("GET /api/notifications/feed lists rows with pagination and validates query params", async () => {
    const first = record({
      kind: "done",
      projectName: "ppm",
      sessionId: "s1",
      title: "First",
      body: "Body 1",
      createdAt: 1000,
    });
    const second = record({
      kind: "schedule",
      projectName: "ppm",
      scheduleId: "sched-2",
      title: "Second",
      body: "Body 2",
      createdAt: 2000,
    });
    const third = record({
      kind: "approval",
      projectName: "ppm",
      sessionId: "s2",
      title: "Third",
      body: "Body 3",
      createdAt: 3000,
    });

    const page1 = await request("GET", "/api/notifications/feed?limit=2");
    expect(page1.status).toBe(200);
    expect(page1.json.ok).toBe(true);
    expect(page1.json.data.hasMore).toBe(true);
    expect(page1.json.data.rows.map((r: { id: number }) => r.id)).toEqual([third.id, second.id]);

    const page2 = await request("GET", `/api/notifications/feed?limit=2&before=${second.id}`);
    expect(page2.status).toBe(200);
    expect(page2.json.data.hasMore).toBe(false);
    expect(page2.json.data.rows.map((r: { id: number }) => r.id)).toEqual([first.id]);

    const badLimit = await request("GET", "/api/notifications/feed?limit=0");
    expect(badLimit.status).toBe(400);

    const badBefore = await request("GET", "/api/notifications/feed?before=not-a-number");
    expect(badBefore.status).toBe(400);
  });

  it("POST /api/notifications/feed/:id/read and /unread toggle read state and broadcast notifications:feed_changed", async () => {
    const item = record({
      kind: "question",
      projectName: "ppm",
      sessionId: "s1",
      title: "AI has a question",
      body: "Which layout?",
    });
    wsEvents = [];

    const readRes = await request("POST", `/api/notifications/feed/${item.id}/read`);
    expect(readRes.status).toBe(200);
    expect(readRes.json.data).toMatchObject({ id: item.id, read: true });
    expect(wsEvents).toContainEqual({ type: NOTIFICATION_FEED_CHANGED_EVENT });

    wsEvents = [];
    const unreadRes = await request("POST", `/api/notifications/feed/${item.id}/unread`);
    expect(unreadRes.status).toBe(200);
    expect(unreadRes.json.data).toMatchObject({ id: item.id, read: false });
    expect(wsEvents).toContainEqual({ type: NOTIFICATION_FEED_CHANGED_EVENT });

    const missing = await request("POST", "/api/notifications/feed/99999/read");
    expect(missing.status).toBe(404);

    const invalid = await request("POST", "/api/notifications/feed/abc/read");
    expect(invalid.status).toBe(400);
  });

  it("POST /api/notifications/feed/read-all marks every notification read", async () => {
    record({ kind: "done", projectName: "ppm", sessionId: "s1", title: "One", body: "1" });
    record({ kind: "schedule", projectName: "ppm", scheduleId: "9", title: "Two", body: "2" });
    wsEvents = [];

    const res = await request("POST", "/api/notifications/feed/read-all");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(list().rows.every((r) => r.read)).toBe(true);
    expect(wsEvents).toContainEqual({ type: NOTIFICATION_FEED_CHANGED_EVENT });
  });

  it("POST /chat/sessions/:id/read marks that session's feed entries read alongside session_metadata", async () => {
    setSessionUnread("s1", "approval_request", "Fix login", "ppm");
    const target1 = record({ kind: "approval", projectName: "ppm", sessionId: "s1", title: "Waiting", body: "b1" });
    const target2 = record({ kind: "done", projectName: "ppm", sessionId: "s1", title: "Done", body: "b2" });
    const other = record({ kind: "done", projectName: "ppm", sessionId: "s2", title: "Other", body: "b3" });
    wsEvents = [];

    const res = await request("POST", "/chat/sessions/s1/read");
    expect(res.status).toBe(200);
    expect(getSessionUnreadCount("s1")).toBe(0);

    const byId = new Map(list().rows.map((r) => [r.id, r.read]));
    expect(byId.get(target1.id)).toBe(true);
    expect(byId.get(target2.id)).toBe(true);
    expect(byId.get(other.id)).toBe(false);
    expect(wsEvents).toContainEqual({ type: NOTIFICATION_FEED_CHANGED_EVENT });
  });
});
