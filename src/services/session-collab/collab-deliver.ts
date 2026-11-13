import { normalizeFromSessionTitle, type FromSessionReference } from "../../shared/chat-from-session.ts";
import type { TurnReference } from "../../shared/chat-turn-ref.ts";
import type { AssistantProvenance } from "../../shared/assistant-provenance.ts";
import type { SessionDelivery, SessionWaitOutcome, WaitingCard } from "../../shared/session-collab.ts";
import type { CollabCaller, CollabEnv, CollabTarget } from "./collab-context.ts";
import type { WaitHandle } from "./collab-waits.ts";

/**
 * One message from a session tool into another session, optionally waited on. Shared by
 * `create_session` (the task) and `send_to_session`, so both deliver, link and wait alike.
 */

export type DeliverOutcome =
  | { ok: true; delivered: SessionDelivery; clientMessageId: string; reply?: SessionWaitOutcome }
  | { ok: false; message: string };

/** The sender as the from-session block names it; the PPM Assistant is marked as such. */
export function fromSessionOf(env: CollabEnv, caller: CollabCaller): FromSessionReference {
  const turnId = env.live(caller.sessionId)?.currentTurnId;
  return {
    version: 1, sessionId: caller.sessionId, providerId: caller.providerId, projectName: caller.projectName,
    title: normalizeFromSessionTitle(caller.title), ...(turnId ? { turnId } : {}), sentAt: new Date().toISOString(),
    ...(caller.kind === "assistant" ? { kind: "assistant" as const } : {}),
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
  /** The mode the user approved the message in; the delivery refuses a chat that would run it in another. */
  expectedMode?: string;
  /** `later` waits for the target's running turn to end; `next` (the default) joins it. */
  priority?: "next" | "later";
  /** A PPM Assistant message to a manager chat: how the Assistant's turn started. */
  provenance?: AssistantProvenance;
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
    // The target's own project: a chat with no live entry is started there, never in the caller's.
    delivered = await env.deliver({
      targetSessionId: target.sessionId, providerId: target.providerId,
      projectName: target.projectName, projectPath: target.projectPath,
      body: input.body, fromSession: fromSessionOf(env, caller),
      ...(input.turnRefs?.length ? { turnRefs: input.turnRefs } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.expectedMode ? { expectedMode: input.expectedMode } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
    });
  } catch (e) {
    handle?.abandon();
    return { ok: false, message: `The message was not delivered: ${(e as Error).message}` };
  }
  // Unread by the target until a turn of it takes the message; a turn already named has it.
  if (!delivered.turnBinding) env.unread.add(caller.sessionId, target.sessionId, delivered.clientMessageId, delivered.delivered);
  if (!handle) return { ok: true, delivered: delivered.delivered, clientMessageId: delivered.clientMessageId };
  // A target already in front of the user (a question, an approval) cannot answer until the user
  // does: the wait ends now, naming the card, instead of running out its timeout in silence.
  const live = env.live(target.sessionId);
  handle.attach(delivered.clientMessageId, delivered.delivered, !!delivered.turnBinding, live?.waitingFor ? live.waitingCard ?? fallbackCard(live.waitingFor) : null);
  const reply = await handle.outcome;
  return { ok: true, delivered: delivered.delivered, clientMessageId: delivered.clientMessageId, reply };
}

/** A card the registry reported without its title. */
const fallbackCard = (kind: "approval" | "question"): WaitingCard => ({ kind, title: kind === "question" ? "A question" : "An approval" });
