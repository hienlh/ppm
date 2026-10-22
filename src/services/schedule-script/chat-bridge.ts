/**
 * `ctx.ai.chat(key, prompt, opts)`: one PPM chat per key of a schedule. Picks the chat (the
 * session the script names, else the one the key used last, else a new one), runs one turn in
 * it (`chat-loopback.ts`), names it, and remembers key → chat.
 *
 * A new chat whose first turn wrote nothing is deleted again rather than left empty in the
 * project's list, as the review bot did. A name is given once, after the first turn (PPM can
 * only rename a chat that has a transcript), and changed later only when the script asks for a
 * different one than it gave before — a name the user typed in PPM since is theirs.
 */
import type { Schedule } from "../../types/scheduler.ts";
import { chatService } from "../chat.service.ts";
import { claudeTranscriptExists } from "../claude-transcript-exists.ts";
import { deleteChatSession, renameChatSession } from "../chat-session-admin.ts";
import { getSessionProjectPath, getSessionProvider, getSessionTitle } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import { projectService } from "../project.service.ts";
import { getProjectDefaultTagId, setSessionTag } from "../tag.service.ts";
import { startChatTurn, type ChatTurnOutcome } from "./chat-loopback.ts";
import { bindScheduleChat, finishAiTurn, getScheduleChat, startAiTurn, unbindScheduleChat, type ScheduleChat } from "./schedule-chat-db.ts";

const log = createLogger("scheduler");

export const CHAT_DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface ChatCallOptions {
  title?: string;
  projectPath?: string;
  sessionId?: string;
  wait?: boolean;
  timeoutMs?: number;
}

export interface ChatCallResult {
  ok: boolean;
  text: string;
  sessionId: string | null;
  costUsd?: number;
  account?: string;
  busy?: boolean;
  started?: boolean;
  timedOut?: boolean;
  error?: string;
}

interface Project { name: string; path: string }

export async function scheduleChat(schedule: Schedule, key: string, prompt: string, opts: ChatCallOptions): Promise<ChatCallResult> {
  const requested = registeredProject(opts.projectPath ?? schedule.project_path);
  const bound = getScheduleChat(schedule.id, key);
  let sessionId = [opts.sessionId, bound?.session_id].find((id): id is string => !!id && sessionKnown(id)) ?? null;
  let project = requested;
  const isNew = sessionId === null;
  if (sessionId) {
    // A chat keeps the project it was made in, whatever the script asks for new ones.
    const own = getSessionProjectPath(sessionId);
    project = (own && tryRegisteredProject(own)) || requested;
  } else {
    const session = await chatService.createSession(schedule.provider_id, {
      projectName: project.name, projectPath: project.path, title: opts.title ?? key, adoptWarmSpare: true,
    });
    const tag = getProjectDefaultTagId(project.path);
    if (tag) setSessionTag(session.id, tag, project.path);
    sessionId = session.id;
  }

  const turn = startChatTurn({
    sessionId, projectName: project.name, content: prompt,
    permissionMode: schedule.permission_mode, timeoutMs: opts.timeoutMs ?? CHAT_DEFAULT_TIMEOUT_MS,
  });
  const settled = turn.done.then((outcome) => settle({ schedule, key, opts, project, isNew, bound, outcome }));
  const sent = await turn.sent;
  // Bound as soon as the turn has started, so the key's next call finds this chat busy rather
  // than opening a second one; `settle` names it, or forgets it if it is deleted again.
  if (sent) bindScheduleChat(schedule.id, key, sessionId, bound?.session_id === sessionId ? bound.title : null);
  if (opts.wait !== false || !sent) return settled; // waiting, or no turn started (busy, refused)

  const rowId = startAiTurn(schedule.id, key, sessionId);
  const startedIn = sessionId;
  void settled
    .then((r) => finishAiTurn(rowId, { ...r, sessionId: r.sessionId ?? startedIn }))
    .catch((e) => {
      log.warn(`Schedule ${schedule.id}: background chat turn for key "${key}" failed: ${(e as Error).message}`);
      finishAiTurn(rowId, { ok: false, text: "", sessionId: startedIn, error: (e as Error).message });
    });
  return { ok: true, text: "", sessionId, started: true };
}

async function settle(p: {
  schedule: Schedule; key: string; opts: ChatCallOptions; project: Project; isNew: boolean;
  bound: ScheduleChat | null; outcome: ChatTurnOutcome;
}): Promise<ChatCallResult> {
  const { schedule, key, opts, project, isNew, bound, outcome } = p;
  const result: ChatCallResult = {
    ok: outcome.ok, text: outcome.text, sessionId: outcome.sessionId,
    ...(outcome.costUsd !== undefined && { costUsd: outcome.costUsd }),
    ...(outcome.account !== undefined && { account: outcome.account }),
    ...(outcome.busy && { busy: true }),
    ...(outcome.timedOut && { timedOut: true }),
    ...(outcome.error !== undefined && { error: outcome.error }),
  };
  if (outcome.busy) return result;
  const id = outcome.sessionId;

  if (isNew && !(await hasTranscript(schedule.provider_id, id))) {
    await deleteChatSession(schedule.provider_id, id, project.path)
      .catch((e) => log.warn(`Schedule ${schedule.id}: could not delete empty chat ${id}: ${(e as Error).message}`));
    unbindScheduleChat(schedule.id, key);
    return { ...result, sessionId: null };
  }

  const last = isNew ? null : bound?.session_id === id ? bound.title : getSessionTitle(id);
  const wanted = isNew ? (opts.title ?? key) : opts.title;
  let title = last;
  if (wanted !== undefined && wanted !== last) {
    try {
      await renameChatSession(id, wanted, project.path);
      title = wanted;
    } catch (e) {
      log.warn(`Schedule ${schedule.id}: could not name chat ${id} "${wanted}": ${(e as Error).message}`);
    }
  }
  bindScheduleChat(schedule.id, key, id, title);
  return result;
}

/** Whether PPM still has the chat: it recorded its provider, Claude has its transcript, or it is live. */
function sessionKnown(id: string): boolean {
  return getSessionProvider(id) !== null || claudeTranscriptExists(id) || chatService.getSession(id) !== null;
}

async function hasTranscript(providerId: string, id: string): Promise<boolean> {
  try {
    return (await chatService.getMessages(providerId, id)).length > 0;
  } catch {
    return true; // unreadable is not empty: keep it
  }
}

function tryRegisteredProject(nameOrPath: string): Project | null {
  try {
    const { name, path } = projectService.resolve(nameOrPath);
    return { name, path };
  } catch {
    return null;
  }
}

function registeredProject(nameOrPath: string): Project {
  const project = tryRegisteredProject(nameOrPath);
  if (!project) throw new Error(`${nameOrPath} is not a project in PPM`);
  return project;
}
