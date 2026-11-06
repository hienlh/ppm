import { normalizeFromSessionTitle, type FromSessionReference } from "../../shared/chat-from-session.ts";
import type { TurnReference } from "../../shared/chat-turn-ref.ts";
import type { SessionDelivery, SessionWaitOutcome } from "../../shared/session-collab.ts";
import type { CollabCaller, CollabEnv, CollabTarget } from "./collab-context.ts";
import type { WaitHandle } from "./collab-waits.ts";

/**
 * One message from a session tool into another session, optionally waited on. Shared by
 * `create_session` (the task) and `send_to_session`, so both deliver, link and wait alike.
 */

export type DeliverOutcome =
  | { ok: true; delivered: SessionDelivery; clientMessageId: string; reply?: SessionWaitOutcome }
  | { ok: false; message: string };

export function fromSessionOf(env: CollabEnv, caller: CollabCaller): FromSessionReference {
  const turnId = env.live(caller.sessionId)?.currentTurnId;
  return {
    version: 1, sessionId: caller.sessionId, providerId: caller.providerId, projectName: caller.projectName,
    title: normalizeFromSessionTitle(caller.title), ...(turnId ? { turnId } : {}), sentAt: new Date().toISOString(),
  };
}

export async function deliverAndWait(env: CollabEnv, input: {
  caller: CollabCaller;
  target: CollabTarget;
  body: string;
  wait: boolean;
  signal: AbortSignal;
  turnRefs?: TurnReference[] | null;
  permissionMode?: string;
}): Promise<DeliverOutcome> {
  const { caller, target } = input;
  let handle: WaitHandle | null = null;
  if (input.wait) {
    // Registered before delivery: a reply faster than the delivery's return is still this wait's.
    const begun = env.waits.begin({
      waiter: caller.sessionId, target: target.sessionId, signal: input.signal,
      timeoutMs: env.settings().waitTimeoutMinutes * 60_000,
    });
    if (!begun.ok) return { ok: false, message: begun.message };
    handle = begun.wait;
  }
  let delivered;
  try {
    delivered = await env.deliver({
      targetSessionId: target.sessionId, providerId: target.providerId,
      projectName: caller.projectName, projectPath: caller.projectPath,
      body: input.body, fromSession: fromSessionOf(env, caller),
      ...(input.turnRefs?.length ? { turnRefs: input.turnRefs } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    });
  } catch (e) {
    handle?.abandon();
    return { ok: false, message: `The message was not delivered: ${(e as Error).message}` };
  }
  // A message the target reads outside a wait: it shows in `session_status` as unread by that session.
  env.unread.add(caller.sessionId, target.sessionId);
  if (!handle) return { ok: true, delivered: delivered.delivered, clientMessageId: delivered.clientMessageId };
  handle.attach(delivered.clientMessageId, delivered.delivered, !!delivered.turnBinding);
  const reply = await handle.outcome;
  return { ok: true, delivered: delivered.delivered, clientMessageId: delivered.clientMessageId, reply };
}
