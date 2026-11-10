import type { SessionCollabModeSource } from "../../shared/session-collab.ts";
import { effectivePermissionMode, type CollabCaller, type CollabEnv, type CollabTarget } from "./collab-context.ts";

/**
 * The card a PPM Assistant message waits on before it goes into one of the user's chats. The chat
 * works on the message in its own permission mode, so the card names that mode and where it came
 * from: a chat set to bypass permissions runs whatever follows unasked, and the user must see that
 * before allowing. If the chat would run the message in another mode by the time the user allows
 * it (its session started meanwhile in a different one), nothing is sent: checked here once the
 * card is answered, and again by the delivery under the chat's own lock (`expectedMode`).
 *
 * A message is not refused because the chat is waiting on a card of its own: it waits behind that
 * card and never answers it (`deliverToSession`). It is not counted as a pair or a link either:
 * the Assistant's chats belong to no project, so a project chat's linked-sessions bar could not
 * open it there; the message's own from-session bubble links back.
 */

export type AssistantSendCheck = { ok: true; mode: string } | { ok: false; message: string };

/** The mode a message to `target` would run in now. */
function modeOf(env: CollabEnv, target: CollabTarget): { mode: string; source: SessionCollabModeSource } {
  return env.chatMode?.(target.sessionId, target.providerId) ?? {
    mode: effectivePermissionMode(env, target.sessionId, target.providerId) ?? "bypassPermissions",
    source: "provider-default",
  };
}

/** The mode the user approved the message in, or why it is not sent, for the Assistant to read. */
export async function assistantSendCheck(
  env: CollabEnv, caller: CollabCaller, target: CollabTarget, message: string, signal: AbortSignal,
): Promise<AssistantSendCheck> {
  const before = modeOf(env, target);
  const answer = await env.approve(caller.sessionId, {
    kind: "message", targetSessionId: target.sessionId, targetTitle: target.title, projectName: target.projectName,
    providerId: target.providerId, permissionMode: before.mode, modeSource: before.source, message,
  }, signal);
  if (!answer.allowed) return { ok: false, message: `The message was not sent. ${answer.message}` };
  const now = modeOf(env, target);
  if (now.mode !== before.mode) {
    return {
      ok: false,
      message: `"${target.title}" would now run the message in "${now.mode}" rather than "${before.mode}", the mode the user `
        + "approved, so nothing was sent. Ask again.",
    };
  }
  return { ok: true, mode: before.mode };
}
