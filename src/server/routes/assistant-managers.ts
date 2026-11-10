import { Hono } from "hono";
import { managerChats, ManagerChatError } from "../../services/assistant-managers/manager-chats.service.ts";
import { getMainSession, MainSessionError, setMainSession } from "../../services/assistant/assistant-main-session.ts";
import { followMainSession } from "../../services/assistant-telegram/assistant-telegram-binding.ts";
import { MANAGER_TELEGRAM_DETAILS, type ManagerAssignCheck, type ManagerTelegramDetail } from "../../shared/assistant-managers.ts";
import { createLogger } from "../../services/logger.ts";
import { ok, err } from "../../types/api.ts";

/**
 * The main Assistant session and each project's manager chat (`/api/assistant/main-session`,
 * `/api/assistant/managers…`), behind PPM's auth. `:project` is the project's name.
 */
export const assistantManagerRoutes = new Hono();

const log = createLogger("assistant-managers");
const ID_RE = /^[\w.:-]{1,256}$/;

/** The announcement reaches the chat registry, which loads after the routes. */
const announce = () => import("../../services/assistant-managers/manager-chats-announce.ts");

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function failure(e: unknown): { message: string; status: 400 | 404 | 500 } {
  if (e instanceof ManagerChatError) return { message: e.message, status: e.status };
  if (e instanceof MainSessionError) return { message: e.message, status: 400 };
  return { message: (e as Error).message, status: 500 };
}

assistantManagerRoutes.get("/main-session", (c) => c.json(ok({ main: getMainSession() })));

assistantManagerRoutes.put("/main-session", async (c) => {
  const body = await readBody(c);
  if (typeof body?.sessionId !== "string" || !ID_RE.test(body.sessionId)) return c.json(err("sessionId is required"), 400);
  try {
    const { previous, current } = setMainSession(body.sessionId);
    // Chats that talked to the old main follow it; chats on a one-off session stay put.
    if (previous && previous !== current) followMainSession(previous, current);
    return c.json(ok({ main: getMainSession() }));
  } catch (e) {
    const f = failure(e);
    return c.json(err(f.message), f.status);
  }
});

assistantManagerRoutes.get("/managers", async (c) => {
  try {
    return c.json(ok({ managers: await (await announce()).managerSummaries() }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** What the assign dialog states before it asks: the chat's mode, and the manager it replaces. */
assistantManagerRoutes.get("/managers/:project/check", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId || !ID_RE.test(sessionId)) return c.json(err("sessionId is required"), 400);
  try {
    const { sessionId: current, replaces } = await managerChats.checkAssign(c.req.param("project"), sessionId);
    const { chatTargetMode } = await import("../ws/chat.ts");
    const check: ManagerAssignCheck = {
      permissionMode: chatTargetMode(current, "claude").mode,
      replaces: replaces
        ? { sessionId: replaces.sessionId, title: await (await announce()).managerChatTitle(replaces.sessionId, replaces.providerId, replaces.projectPath) }
        : null,
      already: managerChats.managerFor(managerChats.project(c.req.param("project")).path)?.sessionId === current,
    };
    return c.json(ok(check));
  } catch (e) {
    const f = failure(e);
    return c.json(err(f.message), f.status);
  }
});

assistantManagerRoutes.put("/managers/:project", async (c) => {
  const body = await readBody(c);
  if (typeof body?.sessionId !== "string" || !ID_RE.test(body.sessionId)) return c.json(err("sessionId is required"), 400);
  try {
    const project = c.req.param("project");
    const { row, replaced } = await managerChats.assign(project, body.sessionId, "user");
    log.info(`Manager chat of ${project} is now ${row.sessionId}${replaced ? ` (replaces ${replaced})` : ""}`);
    return c.json(ok({ sessionId: row.sessionId, replaced }));
  } catch (e) {
    const f = failure(e);
    return c.json(err(f.message), f.status);
  }
});

assistantManagerRoutes.delete("/managers/:project", (c) => {
  try {
    const project = c.req.param("project");
    const removed = managerChats.unassign(project);
    if (removed) log.info(`${project} has no manager chat now`);
    return c.json(ok({ removed }));
  } catch (e) {
    const f = failure(e);
    return c.json(err(f.message), f.status);
  }
});

assistantManagerRoutes.patch("/managers/:project", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json(err("Body must be a JSON object"), 400);
  const patch: { digest?: boolean; telegramDetail?: ManagerTelegramDetail } = {};
  if (body.digest !== undefined) {
    if (typeof body.digest !== "boolean") return c.json(err("digest must be true or false"), 400);
    patch.digest = body.digest;
  }
  if (body.telegramDetail !== undefined) {
    if (!MANAGER_TELEGRAM_DETAILS.includes(body.telegramDetail as ManagerTelegramDetail)) {
      return c.json(err(`telegramDetail must be one of ${MANAGER_TELEGRAM_DETAILS.join(", ")}`), 400);
    }
    patch.telegramDetail = body.telegramDetail as ManagerTelegramDetail;
  }
  try {
    if (!managerChats.patch(c.req.param("project"), patch)) return c.json(err("That project has no manager chat"), 404);
    return c.json(ok({ updated: true }));
  } catch (e) {
    const f = failure(e);
    return c.json(err(f.message), f.status);
  }
});
