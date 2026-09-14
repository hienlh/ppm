import { Hono } from "hono";
import { clearSessionUnreadMany } from "../../services/db.service.ts";
import { ok, err } from "../../types/api.ts";

/**
 * Chat routes that are deliberately *not* project-scoped.
 *
 * Their state is keyed by session, not by project, so a project segment adds nothing and
 * actively gets in the way: mounted under `/api/project/:projectName/chat` the project
 * middleware 404s first, which makes the entries most in need of attention the ones that
 * cannot be reached — a session whose project was renamed or deleted, or one PPM never
 * recorded a project for.
 */
export const chatGlobalRoutes = new Hono();

/**
 * GET /chat/sessions/running — every session with a turn in flight, across all projects.
 *
 * The project-scoped twin under `/api/project/:projectName/chat` can only ever reconcile the
 * project the user is looking at, which leaves a stale entry from any other project with
 * nothing that can clear it. Consumers that ask "is anything running at all" — the screen
 * wake lock — need the whole picture, so they get it from here.
 */
chatGlobalRoutes.get("/sessions/running", async (c) => {
  try {
    const { listRunningSessions } = await import("../ws/chat.ts");
    return c.json(ok(listRunningSessions()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /chat/sessions/read — mark many sessions as read, in one request */
chatGlobalRoutes.post("/sessions/read", async (c) => {
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
