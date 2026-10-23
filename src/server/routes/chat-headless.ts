import { Hono } from "hono";
import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { dbApprovalBroker } from "../../services/db-ai-tools/db-approval-broker.ts";
import { getSessionProjectPath, getSessionProvider, resolveMigratedSession } from "../../services/db.service.ts";
import { validateHeadlessSend } from "../ws/chat-headless-turn-helpers.ts";
import type { ChatSendPayload } from "../../types/api.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

/**
 * The headless chat turn over HTTP, for callers outside the extension host. Both routes
 * refuse a session of another project and never create a session: `POST /sessions` first.
 */
export const chatHeadlessRoutes = new Hono<Env>();

/**
 * 400 when a session belongs to a different project than the one in context. Checked
 * against the DB row (true across restarts), the provider's in-memory session (one resumed
 * mid-request, or never persisted) and the WS registry entry — the path a running turn
 * actually uses, which `getOrCreateEntry` would otherwise overwrite from the caller's project.
 */
async function crossProjectMismatch(id: string, projectPath: string): Promise<boolean> {
  const dbPath = getSessionProjectPath(id);
  if (dbPath && dbPath !== projectPath) return true;
  const memPath = chatService.getSession(id)?.projectPath;
  if (memPath && memPath !== projectPath) return true;
  // Loaded on use, as the other chat routes load the socket module.
  const { getActiveSessionProjectPath } = await import("../ws/chat.ts");
  const activePath = getActiveSessionProjectPath(id);
  if (activePath && activePath !== projectPath) return true;
  return false;
}

function sessionKnown(id: string): boolean {
  return !!chatService.getSession(id) || !!getSessionProjectPath(id);
}

function providerOf(id: string): string {
  return chatService.getSession(id)?.providerId ?? getSessionProvider(id) ?? providerRegistry.getDefault().id;
}

/**
 * POST /chat/sessions/:id/messages — run a prompt with no browser attached.
 *
 * The body is the WS `message` frame plus `timeoutMs` (wall-clock budget, default 30 min)
 * and `notifyOnDone`. Answers 202 before the turn ends; poll `/sessions/running` or read
 * `GET .../messages` to see it finish.
 */
chatHeadlessRoutes.post("/sessions/:id/messages", async (c) => {
  try {
    const id = resolveMigratedSession(c.req.param("id"));
    const projectName = c.get("projectName");
    const projectPath = c.get("projectPath");
    const body = await c.req.json<ChatSendPayload & { timeoutMs?: number; notifyOnDone?: boolean }>().catch(() => null);
    const invalid = validateHeadlessSend(body as Record<string, unknown> | null);
    if (invalid || !body) return c.json(err(invalid ?? "content is required"), 400);
    if (!sessionKnown(id)) return c.json(err("Session not found"), 404);
    if (await crossProjectMismatch(id, projectPath)) return c.json(err("Session belongs to a different project"), 400);

    const { BUSY_DIFFERENT_MODEL, startHeadlessTurn } = await import("../ws/chat-headless-turn.ts");
    try {
      const { queued } = await startHeadlessTurn(id, { ...body, providerId: providerOf(id), projectName, projectPath });
      return c.json(ok({ sessionId: id, queued }), 202);
    } catch (e) {
      const message = (e as Error).message;
      return c.json(err(message), message === BUSY_DIFFERENT_MODEL ? 409 : 500);
    }
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /chat/sessions/:id/cancel — stop a turn in flight, headless or not. */
chatHeadlessRoutes.post("/sessions/:id/cancel", async (c) => {
  try {
    const id = resolveMigratedSession(c.req.param("id"));
    const projectPath = c.get("projectPath");
    if (!sessionKnown(id)) return c.json(err("Session not found"), 404);
    if (await crossProjectMismatch(id, projectPath)) return c.json(err("Session belongs to a different project"), 400);
    dbApprovalBroker.cancelSession(id, "The turn was stopped before the user approved, so nothing ran.");
    chatService.abortQuery(providerOf(id), id, "rest_cancel", "extension");
    return c.json(ok({ cancelled: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
