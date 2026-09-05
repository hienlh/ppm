import { Hono } from "hono";
import { clearSessionUnreadMany } from "../../services/db.service.ts";
import { ok, err } from "../../types/api.ts";

/**
 * Unread routes that are deliberately *not* project-scoped.
 *
 * The per-session read route lives under `/api/project/:projectName/chat`, but it never
 * read the project segment — and being mounted there means the project middleware 404s
 * first. That makes the entries most in need of clearing the ones that cannot be:
 * a session whose project was renamed or deleted, or one PPM never recorded a project
 * for. Unread state is keyed by session, so clearing it does not need a project at all.
 */
export const chatUnreadRoutes = new Hono();

/** POST /chat/sessions/read — mark many sessions as read, in one request */
chatUnreadRoutes.post("/sessions/read", async (c) => {
  try {
    const body = await c.req.json<{ sessionIds?: unknown }>();
    const ids = Array.isArray(body.sessionIds)
      ? body.sessionIds.filter((v): v is string => typeof v === "string" && v.length > 0)
      : null;
    if (!ids) return c.json(err("sessionIds must be an array of session ids"), 400);

    clearSessionUnreadMany(ids);
    // One broadcast per session, but one request and one DB transaction: "Clear all" used
    // to be N requests fanned out to every connected device.
    const { broadcastGlobalEvent } = await import("../ws/chat.ts");
    for (const id of ids) {
      broadcastGlobalEvent({ type: "session:unread_changed", sessionId: id, unreadCount: 0, unreadType: null, projectName: "" });
    }
    return c.json(ok({ cleared: ids.length }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
