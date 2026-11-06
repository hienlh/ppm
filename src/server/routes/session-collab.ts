import { resolve } from "node:path";
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { chatService } from "../../services/chat.service.ts";
import { getSessionProjectPath, getSessionProvider, resolveMigratedSession } from "../../services/db.service.ts";
import { collabApprovalBroker } from "../../services/session-collab/collab-approval-broker.ts";
import { collabWaits } from "../../services/session-collab/collab-waits.ts";
import { childrenOf, linkedSessions } from "../../services/session-collab/session-links.service.ts";
import { SESSION_ID_RE } from "../../shared/session-turn-ids.ts";
import { ppmApprovals } from "../ws/chat-ppm-approvals.ts";
import { collabLiveState } from "../ws/chat.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

/**
 * POST /api/sessions-collab/approvals/:requestId — body `{ answer: "allow_once" | "allow_session" | "deny" }`.
 * The user's answer to a session tool's card (create, pair limit, escalation). Behind PPM's auth;
 * the chat socket never answers these. 404 once the card is no longer waiting, 400 for an answer
 * the card does not offer.
 */
export const sessionCollabRoutes = new Hono();

sessionCollabRoutes.post("/approvals/:requestId", async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const answered = collabApprovalBroker.answer(c.req.param("requestId"), body);
  if (!answered.ok) return c.json(err(answered.error), answered.status);
  return c.json(ok({ answer: answered.answer }));
});

const samePath = (a: string, b: string): boolean => {
  const x = resolve(a), y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * POST /chat/sessions/:id/stop-children — stops every running session the given one's AI created
 * (direct children only), through the same abort a Stop press uses. Mounted under one project's
 * `/chat`; a child recorded under another project is left alone. Answers which were stopped.
 */
export const chatSessionCollabRoutes = new Hono<Env>();

/** Whether PPM records the session as this project's (registry first, then the database). */
function inProject(sessionId: string, projectPath: string): boolean {
  const path = collabLiveState(sessionId)?.projectPath ?? getSessionProjectPath(resolveMigratedSession(sessionId));
  return !!path && samePath(path, projectPath);
}

/**
 * GET /chat/sessions/:id/links — `SessionLink[]`: the session's creator, the sessions it created,
 * and those it exchanged messages with, each once with every relation that applies, by canonical
 * id. Read from PPM's database and the pair sidecar, so links from before a restart are there too.
 * Only sessions this project owns are listed.
 */
chatSessionCollabRoutes.get("/sessions/:id/links", (c) => {
  const raw = c.req.param("id");
  if (!SESSION_ID_RE.test(raw)) return c.json(err("Invalid session id"), 400);
  const projectPath = c.get("projectPath");
  if (!inProject(raw, projectPath)) return c.json(ok([]));
  const links = linkedSessions(raw).filter((link) => inProject(link.sessionId, projectPath));
  return c.json(ok(links));
});

chatSessionCollabRoutes.post("/sessions/:id/stop-children", (c) => {
  const raw = c.req.param("id");
  if (!SESSION_ID_RE.test(raw)) return c.json(err("Invalid session id"), 400);
  const projectPath = c.get("projectPath");
  const stopped: string[] = [];
  for (const child of childrenOf(resolveMigratedSession(raw))) {
    if (!inProject(child, projectPath)) continue;
    const live = collabLiveState(child);
    const running = (live && live.phase !== "idle") || chatService.turnActivity(child).running;
    if (!running) continue;
    const providerId = live?.providerId ?? getSessionProvider(child);
    if (!providerId) continue;
    ppmApprovals.cancelSession(child, "The user stopped the session before answering, so nothing was done.");
    collabWaits.cancelWaiter(child);
    chatService.abortQuery(providerId, child, "stop_children", "ws");
    stopped.push(child);
  }
  return c.json(ok({ stopped }));
});
