import { neutralizeFences } from "../../shared/untrusted-text.ts";
import type { SessionStatus, SessionStatusResult, SessionWaitOutcome } from "../../shared/session-collab.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import {
  preview, resolveTarget, titleOf, toEpochIso, type CollabCaller, type CollabEnv,
} from "./collab-context.ts";
import { MAX_STATUS_SESSIONS } from "./session-collab-tool.ts";

/**
 * `session_status`, and the status every other tool result carries. Read from what this process
 * holds — the chat registry and PPM's database — never from a transcript, so it is as cheap for a
 * session nobody has open as for a running one; a session not open here reports no last answer.
 */

const LAST_ANSWER_CHARS = 300;

/** One session's status as `caller` sees it. `consume` marks its messages to the caller as told. */
export function statusOf(env: CollabEnv, sessionId: string, providerId: string, caller?: string, consume = false): SessionStatus {
  const id = env.canonical(sessionId);
  const live = env.live(id);
  const unread = caller ? (consume ? env.unread.take(id, caller) : env.unread.peek(id, caller)) : 0;
  return {
    sessionId: id,
    title: titleOf(env, id),
    providerId: live?.providerId ?? providerId,
    model: live?.model ?? env.storedModel(id),
    phase: live?.phase ?? "idle",
    waitingFor: live?.waitingFor ?? null,
    spawnedBy: env.links.parentOf(id),
    depth: env.links.depthOf(id),
    lastAssistantText: live?.lastAnswer ? neutralizeFences(preview(live.lastAnswer, LAST_ANSWER_CHARS)) : null,
    unreadReplies: unread,
    updatedAt: toEpochIso(live?.updatedAt),
  };
}

/**
 * A result put another AI's words in front of the PPM Assistant (a chat's last answer, a reply it
 * waited for): its turn is no longer one only the user wrote into, which its next messages to
 * manager chats say.
 */
export function noteAiTextRead(env: CollabEnv, caller: CollabCaller, statuses: readonly SessionStatus[], reply?: SessionWaitOutcome): void {
  if (caller.kind !== "assistant") return;
  // A card's title is the other session's words as much as a reply is.
  const aiText = !!reply && (reply.replied || reply.reason === "waiting_for_user");
  if (aiText || statuses.some((s) => !!s.lastAssistantText)) env.markUntrusted?.(caller.sessionId, "read");
}

/** The tools' JSON answer: the shapes in `src/shared/session-collab.ts`, as the chat card reads them. */
export const jsonResult = (value: unknown, isError = false): Json => textResult(JSON.stringify(value, null, 2), isError);

export function sessionStatusTool(env: CollabEnv, caller: CollabCaller, args: Json): Json {
  let ids: string[];
  if (args.session_ids === undefined || args.session_ids === null) {
    // The Assistant links to no chat; what it asks about by default is every project's manager.
    ids = caller.kind === "assistant" ? (env.managers?.() ?? []).map((m) => m.sessionId) : env.links.linked(caller.sessionId);
  } else {
    const raw = args.session_ids;
    if (!Array.isArray(raw) || raw.length > MAX_STATUS_SESSIONS || !raw.every((v) => typeof v === "string")) {
      return textResult(`\`session_ids\` must list at most ${MAX_STATUS_SESSIONS} session ids.`, true);
    }
    ids = [...new Set(raw as string[])];
  }
  const sessions: SessionStatus[] = [];
  const problems: string[] = [];
  for (const raw of ids.slice(0, MAX_STATUS_SESSIONS)) {
    const target = resolveTarget(env, caller, raw);
    if (!target.ok) {
      problems.push(`${raw.slice(0, 64)}: ${target.message}`);
      continue;
    }
    sessions.push(statusOf(env, target.value.sessionId, target.value.providerId, caller.sessionId, true));
  }
  noteAiTextRead(env, caller, sessions);
  // `errors` names ids that were refused; with none asked for, an empty list means nothing is linked yet.
  const result: SessionStatusResult & { errors?: string[] } = { sessions, ...(problems.length ? { errors: problems } : {}) };
  return jsonResult(result, sessions.length === 0 && problems.length > 0);
}
