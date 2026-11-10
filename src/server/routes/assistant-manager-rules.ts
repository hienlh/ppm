import { Hono, type Context } from "hono";
import { managerChats } from "../../services/assistant-managers/manager-chats.service.ts";
import { decideManagerRules, managerRulesView, setManagerRulesText } from "../../services/assistant-managers/manager-rules.service.ts";
import { getAssistantSettings } from "../../services/assistant/assistant-settings.service.ts";
import { createProjectChatSession } from "../../services/chat-session-create.ts";
import { chatService } from "../../services/chat.service.ts";
import { setSessionMetadata, setSessionPermissionMode, setSessionTitle } from "../../services/db.service.ts";
import { createLogger } from "../../services/logger.ts";
import { MANAGER_PROVIDER_ID } from "../../shared/assistant-managers.ts";
import { RULES_FILE_MAX_BYTES } from "../../shared/assistant-limits.ts";
import { ok, err } from "../../types/api.ts";
import { managerRouteFailure, readJsonObject } from "./assistant-manager-route-helpers.ts";

/**
 * A project's manager rules (`.ppm/manager.md`) and creating a manager chat, under
 * `/api/assistant/managers/:project`, behind PPM's auth. `:project` is the project's name.
 */
export const assistantManagerRulesRoutes = new Hono();

const log = createLogger("manager-rules");
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_TITLE = 200;

function fail(c: Context, e: unknown) {
  const f = managerRouteFailure(e);
  return c.json(err(f.message), f.status);
}

assistantManagerRulesRoutes.get("/managers/:project/rules", (c) => {
  try {
    return c.json(ok({ rules: managerRulesView(c.req.param("project")) }));
  } catch (e) {
    return fail(c, e);
  }
});

/** The user's own rules: written and in force at once, announced with the diff, no decision card. */
assistantManagerRulesRoutes.put("/managers/:project/rules", async (c) => {
  const body = await readJsonObject(c);
  if (typeof body?.text !== "string") return c.json(err("text is required"), 400);
  if (Buffer.byteLength(body.text) > RULES_FILE_MAX_BYTES) return c.json(err(`Rules must be at most ${RULES_FILE_MAX_BYTES / 1024} KB`), 400);
  try {
    const project = c.req.param("project");
    const fetchSite = c.req.header("sec-fetch-site") ?? null;
    await setManagerRulesText(project, body.text, fetchSite);
    log.info(`Rules of ${project} set from Settings (fetch-site=${fetchSite ?? "none"})`);
    return c.json(ok({ rules: managerRulesView(project) }));
  } catch (e) {
    return fail(c, e);
  }
});

assistantManagerRulesRoutes.post("/managers/:project/rules/decision", async (c) => {
  const body = await readJsonObject(c);
  if (body?.action !== "approve" && body?.action !== "revert") return c.json(err("action must be approve or revert"), 400);
  if (typeof body.hash !== "string" || !HASH_RE.test(body.hash)) return c.json(err("hash is required"), 400);
  try {
    const project = c.req.param("project");
    await decideManagerRules(project, body.action, body.hash);
    log.info(`Rules change ${body.hash.slice(0, 12)} of ${project}: ${body.action}`);
    return c.json(ok({ rules: managerRulesView(project) }));
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * A new Claude chat in the project, made its manager: titled "Manager" unless named, in the mode
 * Settings → PPM Assistant gives new manager chats, with the rules files ensured. No card: a
 * person pressed the button.
 */
assistantManagerRulesRoutes.post("/managers/:project/create", async (c) => {
  const body = (await readJsonObject(c)) ?? {};
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length > MAX_TITLE)) {
    return c.json(err(`title must be text of at most ${MAX_TITLE} characters`), 400);
  }
  const title = (typeof body.title === "string" && body.title.trim()) || "Manager";
  try {
    const project = managerChats.project(c.req.param("project"));
    const mode = getAssistantSettings().manager_default_mode;
    const session = await createProjectChatSession({
      providerId: MANAGER_PROVIDER_ID, projectName: project.name, projectPath: project.path, title,
      // A warm spare runs with an ordinary chat's mode, which may not be the manager's.
      adoptWarmSpare: false,
    });
    setSessionMetadata(session.id, project.name, project.path);
    setSessionTitle(session.id, title);
    setSessionPermissionMode(session.id, mode);
    const live = chatService.getSession(session.id);
    if (live) live.title = title;
    const { row, replaced } = await managerChats.assign(project.name, session.id, "user");
    log.info(`Created manager chat ${row.sessionId} for ${project.name} in ${mode} mode${replaced ? ` (replaces ${replaced})` : ""}`);
    return c.json(ok({ sessionId: row.sessionId, providerId: MANAGER_PROVIDER_ID, permissionMode: mode, replaced }), 201);
  } catch (e) {
    return fail(c, e);
  }
});
