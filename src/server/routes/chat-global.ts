import { Hono } from "hono";
import { clearSessionUnreadMany } from "../../services/db.service.ts";
import { ok, err } from "../../types/api.ts";
import { listChatSessionStatus } from "../../services/chat-session-status.service.ts";
import { STATUS_DEFAULT_SINCE_HOURS, STATUS_MAX_SINCE_HOURS } from "../../shared/chat-session-status.ts";

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
 * GET /chat/sessions/status — every session with trace activity in the last `sinceHours`
 * (default 336, at most 2160), across all registered projects: what it is waiting on, how its
 * last turn ended, and whether the user has replied since the AI's last answer. `project`
 * narrows it to one project. Read-only: nothing here marks anything read.
 */
chatGlobalRoutes.get("/sessions/status", async (c) => {
  const rawHours = c.req.query("sinceHours");
  const sinceHours = rawHours === undefined ? STATUS_DEFAULT_SINCE_HOURS : Number(rawHours);
  if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > STATUS_MAX_SINCE_HOURS) {
    return c.json(err(`sinceHours must be a whole number from 1 to ${STATUS_MAX_SINCE_HOURS}`), 400);
  }
  const project = c.req.query("project") || undefined;
  try {
    const { listSessionLiveState } = await import("../ws/chat.ts");
    const { chatSessionStatusSources } = await import("../../services/chat-session-status-sources.ts");
    return c.json(ok(listChatSessionStatus(chatSessionStatusSources(listSessionLiveState), { sinceHours, project })));
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
