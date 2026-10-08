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

/**
 * POST /chat/sessions/:id/release — let a tool outside PPM continue this session.
 *
 * A Claude session is one JSONL file, and two processes appending to it at once split its
 * history into branches. PPM keeps an idle session's subprocess for up to an hour, and for as
 * long as its tab is open, so a script resuming the session from outside had to fork it into
 * a copy instead. Dropping the idle subprocess lets that script write into the session itself;
 * PPM's next turn is rebuilt from disk.
 *
 * Refused with 409 mid-turn, where the answer being streamed would be lost, and while a
 * background agent or shell is running in the subprocess, which would die with it.
 */
chatGlobalRoutes.post("/sessions/:id/release", async (c) => {
  try {
    const sessionId = c.req.param("id");
    const { listRunningSessions, dropIdleSubprocess, hasBackgroundWork } = await import("../ws/chat.ts");
    if (listRunningSessions().some((s) => s.sessionId === sessionId)) {
      return c.json(err("Session is running — wait for the turn to finish"), 409);
    }
    if (hasBackgroundWork(sessionId)) {
      return c.json(err("A background agent or shell is still running in this session"), 409);
    }
    dropIdleSubprocess(
      sessionId,
      "external_writer",
      "Subprocess released: another tool is continuing this session, so the next turn is rebuilt from disk",
    );
    return c.json(ok({ sessionId }));
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
