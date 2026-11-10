import { VALID_PERMISSION_MODES } from "../../types/config.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import type { CreateSessionResult, SessionCollabCreateApproval } from "../../shared/session-collab.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { effectivePermissionMode, sanitizeTitle, type CollabCaller, type CollabEnv } from "./collab-context.ts";
import { deliverAndWait } from "./collab-deliver.ts";
import { createManagerSessionTool } from "./collab-create-manager.ts";
import { jsonResult, noteAiTextRead, statusOf } from "./collab-status.ts";
import { collabTextTooLarge, MAX_COLLAB_TITLE_CHARS } from "./session-collab-tool.ts";

/**
 * `create_session`: a new ordinary session, given a task by the caller.
 *
 * Refused outright past the depth limit or the running limit. A create holds one of the running
 * limit's slots from its check — taken in the same synchronous step, so creates arriving together
 * cannot all see one free slot — through the card and the creation, after which the created
 * session counts as running until its first turn ends.
 *
 * An ordinary session creates in its own project, at its own depth + 1, under its own permission
 * mode read from what it actually runs under; when PPM cannot tell what that is, nothing is created
 * — a child never falls back to the most permissive mode. Unless the user switched it off, they
 * are asked first, and shown the whole task.
 *
 * The PPM Assistant names the project, and the chat it opens is set up as one the user opens
 * there: depth 0, not recorded as AI-created, the provider's default mode and model unless a model
 * is given. It always asks, and the card states the project and the mode. With `manager: true` it
 * asks to create the project's manager chat instead (`collab-create-manager.ts`).
 */

const isMode = (mode: string | null): mode is string =>
  !!mode && (VALID_PERMISSION_MODES as readonly string[]).includes(mode);

interface CreatePlan {
  title: string;
  task: string;
  providerId: "claude" | "codex";
  model: string | null;
  depth: number;
  permissionMode: string;
  wait: boolean;
  project: { name: string; path: string };
}

/** Sessions counted against the limit, other than `ownSlots` slots this create already holds. */
function runningLimitHit(env: CollabEnv, projectName: string, ownSlots: number): string | null {
  const max = env.settings().maxRunningSpawned;
  const used = env.runningSpawned(projectName).length + env.reservedSpawnSlots(projectName) - ownSlots;
  if (used < max) return null;
  return `${max} AI-created sessions of this project are already running, the most the user allows at once. `
    + "Wait for one to finish (session_status shows which), or do the work yourself.";
}

/** The project a create goes to: the caller's own, or for the Assistant the one it named. */
function projectFor(env: CollabEnv, caller: CollabCaller, raw: unknown): { name: string; path: string } | string {
  if (caller.kind !== "assistant") {
    if (raw !== undefined && raw !== caller.projectName) return `Sessions are created in your own project only ("${caller.projectName}"). Leave \`project\` out.`;
    return { name: caller.projectName, path: caller.projectPath };
  }
  if (typeof raw !== "string" || !raw.trim()) return "`project` is required: the registered project to open the chat in (see projects_list).";
  if (isAssistantProject(raw)) return "The Assistant's own chats are not a project. Name one of the user's projects (see projects_list).";
  const project = env.projectByName?.(raw) ?? null;
  return project ?? `No registered project is named "${raw.slice(0, 100)}". Call projects_list for the names.`;
}

/** `manager: true`: the project's manager chat, checked here and created in `collab-create-manager.ts`. */
async function createManagerFromArgs(env: CollabEnv, caller: CollabCaller, args: Json, signal: AbortSignal): Promise<Json> {
  const title = args.title === undefined ? null : sanitizeTitle(args.title, MAX_COLLAB_TITLE_CHARS);
  if (args.title !== undefined && !title) return textResult("`title` must be a few words the user will see in the session list.", true);
  if (args.task !== undefined && typeof args.task !== "string") return textResult("`task` must be text.", true);
  const task = typeof args.task === "string" ? args.task : "";
  const tooLarge = collabTextTooLarge("task", task);
  if (tooLarge) return textResult(tooLarge, true);
  const project = projectFor(env, caller, args.project);
  if (typeof project === "string") return textResult(project, true);
  if (args.wait !== undefined && typeof args.wait !== "boolean") return textResult("`wait` must be true or false.", true);
  return createManagerSessionTool(env, caller, { title, task, project, provider: args.provider, model: args.model, wait: args.wait === true }, signal);
}

export async function createSessionTool(env: CollabEnv, caller: CollabCaller, args: Json, signal: AbortSignal): Promise<Json> {
  if (args.manager !== undefined && typeof args.manager !== "boolean") return textResult("`manager` must be true or false.", true);
  if (args.manager === true) return createManagerFromArgs(env, caller, args, signal);
  const assistant = caller.kind === "assistant";
  const title = sanitizeTitle(args.title, MAX_COLLAB_TITLE_CHARS);
  if (!title) return textResult("`title` is required: a few words the user will see in the session list.", true);
  const task = typeof args.task === "string" ? args.task : "";
  if (!task.trim()) return textResult("`task` is required.", true);
  const tooLarge = collabTextTooLarge("task", task);
  if (tooLarge) return textResult(tooLarge, true);
  const project = projectFor(env, caller, args.project);
  if (typeof project === "string") return textResult(project, true);
  if (args.wait !== undefined && typeof args.wait !== "boolean") return textResult("`wait` must be true or false.", true);
  const providerId = args.provider ?? caller.providerId;
  if ((providerId !== "claude" && providerId !== "codex") || !env.providerExists(providerId)) {
    return textResult("`provider` must be claude or codex, and available in this PPM.", true);
  }
  if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim() || args.model.length > 100)) {
    return textResult("`model` must be a model name.", true);
  }
  const callerModel = assistant ? null : env.live(caller.sessionId)?.model ?? env.storedModel(caller.sessionId);
  const model = typeof args.model === "string" ? args.model.trim() : providerId === caller.providerId ? callerModel : null;

  const settings = env.settings();
  const depth = assistant ? 0 : env.links.depthOf(caller.sessionId) + 1;
  if (depth > settings.maxDepth) {
    return textResult(`Sessions created by sessions may go ${settings.maxDepth} levels deep, and yours is already at that depth. Do the work yourself, or report back to the session that created yours.`, true);
  }
  // The Assistant's chat gets the mode a chat the user opens there gets; a session's, its own.
  const configured = assistant ? env.providerDefaultPermissionMode(providerId) : null;
  const permissionMode = assistant
    ? (isMode(configured) ? configured : "bypassPermissions")
    : effectivePermissionMode(env, caller.sessionId, caller.providerId);
  if (!isMode(permissionMode)) {
    return textResult("PPM cannot tell which permission mode your session runs under, so it will not create a session that might get more rights than yours. The user can pick a mode for this chat and ask again.", true);
  }
  // Checked and reserved in one synchronous step: nothing may await between the two.
  const busy = runningLimitHit(env, project.name, 0);
  if (busy) return textResult(busy, true);
  const release = env.reserveSpawnSlot(project.name);
  try {
    return await createReserved(env, caller, {
      title, task, providerId: providerId as "claude" | "codex", model, depth, permissionMode, wait: args.wait === true, project,
    }, release, signal);
  } finally {
    // Refused, failed or done: the slot goes back (a no-op once the created session took it over).
    release();
  }
}

async function createReserved(env: CollabEnv, caller: CollabCaller, plan: CreatePlan, releaseSlot: () => void, signal: AbortSignal): Promise<Json> {
  const { title, task, providerId, model, depth, permissionMode, project } = plan;
  const assistant = caller.kind === "assistant";
  if (assistant || (env.settings().askBeforeCreate && !env.pairs.canCreateWithoutAsking(caller.sessionId))) {
    const card: SessionCollabCreateApproval = {
      kind: "create", title, providerId, model, task, depth,
      ...(assistant ? { askedBy: "assistant" as const, projectName: project.name, permissionMode, modeSource: "provider-default" as const } : {}),
    };
    const answer = await env.approve(caller.sessionId, card, signal);
    if (!answer.allowed) return textResult(`The session was not created. ${answer.message}`, true);
    if (answer.answer === "allow_session" && !assistant) env.pairs.setAllowCreate(caller.sessionId);
    // Time passed while the user read the card; this create's own slot is still held.
    const nowBusy = runningLimitHit(env, project.name, 1);
    if (nowBusy) return textResult(nowBusy, true);
  }
  if (signal.aborted) return textResult("The call was cancelled, so no session was created.", true);

  let childId: string;
  try {
    childId = env.canonical(await env.createSession(providerId, {
      projectName: project.name, projectPath: project.path, title, ...(assistant ? { asUserChat: true } : {}),
    }));
  } catch (e) {
    return textResult(`The session could not be created: ${(e as Error).message}`, true);
  }
  // The created session now counts as starting, which takes over the slot this create held.
  env.markStarting(childId, project.name);
  releaseSlot();
  env.persistChild(childId, { title, permissionMode, model, projectName: project.name, projectPath: project.path });
  if (assistant) {
    // A chat the user allowed the Assistant to open is the user's chat, as if opened by hand: not
    // AI-created (so it notifies, and leaves the running limit once its first turn ends) and not
    // linked to the Assistant, whose chats belong to no project. Its first message names the sender.
    env.announceCreated({
      sessionId: childId, providerId, projectName: project.name, title, spawnedBy: null, depth: 0, createdAt: new Date().toISOString(),
    });
  } else {
    const childDepth = env.links.recordSpawn(childId, caller.sessionId);
    env.announceCreated({
      sessionId: childId, providerId, projectName: project.name, title,
      spawnedBy: caller.sessionId, parentTitle: env.title(caller.sessionId) || null, parentProviderId: caller.providerId,
      depth: childDepth, createdAt: new Date().toISOString(),
    });
    env.announceLinks(project.name, [caller.sessionId, childId]);
    env.pairs.record(caller.sessionId, childId);
  }

  // A turn reference points at the creator's turn in its project; the Assistant's chats are in none.
  const turnRef = assistant ? null : await env.currentTurnRef(caller).catch(() => null);
  const target = { sessionId: childId, providerId, title, projectName: project.name, projectPath: project.path };
  const out = await deliverAndWait(env, {
    caller, target, body: task, wait: plan.wait, signal, permissionMode, turnRefs: turnRef ? [turnRef] : null,
  });
  if (!out.ok) {
    return textResult(`Session ${childId} ("${title}") was created, but its task was not delivered: ${out.message} Send it again with send_to_session.`, true);
  }
  env.nameInProvider(childId, providerId, title, project.path, out.clientMessageId);
  // The id the chat keeps, so the one the Assistant is told is the one its later news names.
  const settled = assistant ? env.settledSessionId?.(childId, providerId) : undefined;
  const sessionId = settled ? await settled.catch(() => childId) : childId;
  const result: CreateSessionResult & { project?: string } = {
    sessionId, title, providerId, model,
    status: statusOf(env, sessionId, providerId, caller.sessionId, !!out.reply),
    ...(out.reply ? { reply: out.reply } : {}),
    ...(assistant ? { project: project.name } : {}),
  };
  noteAiTextRead(env, caller, [result.status], out.reply);
  return jsonResult(result);
}
