import { VALID_PERMISSION_MODES } from "../../types/config.ts";
import type { CreateSessionResult } from "../../shared/session-collab.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import {
  effectivePermissionMode, preview, sanitizeTitle, type CollabCaller, type CollabEnv,
} from "./collab-context.ts";
import { deliverAndWait } from "./collab-deliver.ts";
import { jsonResult, statusOf } from "./collab-status.ts";
import { MAX_COLLAB_MESSAGE_CHARS, MAX_COLLAB_TITLE_CHARS } from "./session-collab-tool.ts";

/**
 * `create_session`: a new ordinary session in the caller's project, given a task by the caller.
 *
 * Refused outright past the depth limit or the running limit (a created session counts as running
 * from its creation until its first turn ends, so a burst of creates cannot overshoot it). The
 * child runs under the caller's own permission mode, read from what the caller actually runs
 * under; when PPM cannot tell what that is, nothing is created — a child never falls back to the
 * most permissive mode. Unless the user switched it off, they are asked first.
 */

const isMode = (mode: string | null): mode is string =>
  !!mode && (VALID_PERMISSION_MODES as readonly string[]).includes(mode);

function runningLimitHit(env: CollabEnv, caller: CollabCaller): string | null {
  const max = env.settings().maxRunningSpawned;
  if (env.runningSpawned(caller.projectName).length < max) return null;
  return `${max} AI-created sessions of this project are already running, the most the user allows at once. `
    + "Wait for one to finish (session_status shows which), or do the work yourself.";
}

export async function createSessionTool(env: CollabEnv, caller: CollabCaller, args: Json, signal: AbortSignal): Promise<Json> {
  const title = sanitizeTitle(args.title, MAX_COLLAB_TITLE_CHARS);
  if (!title) return textResult("`title` is required: a few words the user will see in the session list.", true);
  const task = typeof args.task === "string" ? args.task : "";
  if (!task.trim()) return textResult("`task` is required.", true);
  if (task.length > MAX_COLLAB_MESSAGE_CHARS) return textResult(`\`task\` is longer than ${MAX_COLLAB_MESSAGE_CHARS} characters.`, true);
  if (args.project !== undefined && args.project !== caller.projectName) {
    return textResult(`Sessions are created in your own project only ("${caller.projectName}"). Leave \`project\` out.`, true);
  }
  if (args.wait !== undefined && typeof args.wait !== "boolean") return textResult("`wait` must be true or false.", true);
  const providerId = args.provider ?? caller.providerId;
  if ((providerId !== "claude" && providerId !== "codex") || !env.providerExists(providerId)) {
    return textResult("`provider` must be claude or codex, and available in this PPM.", true);
  }
  if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim() || args.model.length > 100)) {
    return textResult("`model` must be a model name.", true);
  }
  const callerModel = env.live(caller.sessionId)?.model ?? env.storedModel(caller.sessionId);
  const model = typeof args.model === "string" ? args.model.trim() : providerId === caller.providerId ? callerModel : null;

  const settings = env.settings();
  const depth = env.links.depthOf(caller.sessionId) + 1;
  if (depth > settings.maxDepth) {
    return textResult(`Sessions created by sessions may go ${settings.maxDepth} levels deep, and yours is already at that depth. Do the work yourself, or report back to the session that created yours.`, true);
  }
  const busy = runningLimitHit(env, caller);
  if (busy) return textResult(busy, true);
  const permissionMode = effectivePermissionMode(env, caller.sessionId, caller.providerId);
  if (!isMode(permissionMode)) {
    return textResult("PPM cannot tell which permission mode your session runs under, so it will not create a session that might get more rights than yours. The user can pick a mode for this chat and ask again.", true);
  }

  if (settings.askBeforeCreate && !env.pairs.canCreateWithoutAsking(caller.sessionId)) {
    const answer = await env.approve(caller.sessionId, {
      kind: "create", title, providerId, model, taskPreview: preview(task), depth,
    }, signal);
    if (!answer.allowed) return textResult(`The session was not created. ${answer.message}`, true);
    if (answer.answer === "allow_session") env.pairs.setAllowCreate(caller.sessionId);
    // Time passed while the user read the card.
    const nowBusy = runningLimitHit(env, caller);
    if (nowBusy) return textResult(nowBusy, true);
  }
  if (signal.aborted) return textResult("The call was cancelled, so no session was created.", true);

  let childId: string;
  try {
    childId = env.canonical(await env.createSession(providerId, { projectName: caller.projectName, projectPath: caller.projectPath, title }));
  } catch (e) {
    return textResult(`The session could not be created: ${(e as Error).message}`, true);
  }
  const childDepth = env.links.recordSpawn(childId, caller.sessionId);
  env.persistChild(childId, { title, permissionMode, model, projectName: caller.projectName, projectPath: caller.projectPath });
  env.markStarting(childId, caller.projectName);
  env.announceCreated({
    sessionId: childId, providerId, projectName: caller.projectName, title,
    spawnedBy: caller.sessionId, depth: childDepth, createdAt: new Date().toISOString(),
  });
  env.announceLinks(caller.projectName, [caller.sessionId, childId]);
  env.pairs.record(caller.sessionId, childId);

  const turnRef = await env.currentTurnRef(caller).catch(() => null);
  const target = { sessionId: childId, providerId: providerId as "claude" | "codex", title };
  const out = await deliverAndWait(env, {
    caller, target, body: task, wait: args.wait === true, signal, permissionMode, turnRefs: turnRef ? [turnRef] : null,
  });
  if (!out.ok) {
    return textResult(`Session ${childId} ("${title}") was created, but its task was not delivered: ${out.message} Send it again with send_to_session.`, true);
  }
  env.nameInProvider(childId, providerId, title, caller.projectPath, out.clientMessageId);
  const result: CreateSessionResult = {
    sessionId: childId, title, providerId, model,
    status: statusOf(env, childId, providerId, caller.sessionId, !!out.reply),
    ...(out.reply ? { reply: out.reply } : {}),
  };
  return jsonResult(result);
}
