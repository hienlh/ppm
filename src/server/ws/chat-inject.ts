/**
 * The server's own door into a chat session: delivers a message another session's AI wrote
 * exactly as a browser send would — the same registry entry, `user_message` echo, consumer,
 * phase broadcasts, replay buffer and unread marks — so a browser that opens the session later
 * cannot tell it from a message someone typed, except by the from-session block it carries.
 *
 * Server-internal: no route exposes it. PPM's session tools reach it only after checking the
 * caller, the target's project and the limits. Deliveries to one session are serialized with
 * every browser send to it (`withSessionLock`), so two senders can never start two runs.
 */
import { encodeMessageBlocks } from "../../shared/chat-message-blocks.ts";
import type { AssistantProvenance } from "../../shared/assistant-provenance.ts";
import { neutralizePpmTags } from "../../services/assistant-watch/watch-event-text.ts";
import { defuseUserWordsHeader } from "../../shared/user-words-block.ts";
import { validateFromSession, type FromSessionReference } from "../../shared/chat-from-session.ts";
import { validateTurnRefs, type TurnReference } from "../../shared/chat-turn-ref.ts";
import { SESSION_ID_RE } from "../../shared/session-turn-ids.ts";
import {
  SESSION_CREATED_EVENT, SESSION_LINK_CHANGED_EVENT, SESSION_COLLAB_APPROVAL_EVENT,
  type SessionCollabApprovalEvent, type SessionCreatedEvent, type SessionDelivery,
} from "../../shared/session-collab.ts";
import { getSessionDesignSlug, getSessionProvider, resolveMigratedSession } from "../../services/db.service.ts";
import { countSpawned } from "../../services/session-collab/session-links.service.ts";
import { chatLifecycle } from "../../services/chat-control/chat-lifecycle.ts";
import { createLogger } from "../../services/logger.ts";
import { broadcastGlobalEvent } from "./global.ts";
import { isAssistantSession } from "../../services/assistant/assistant-session.ts";
import {
  chatTargetMode, ensureSessionEntry, listRunningSessions, onTurnBinding, startCleanupTimer,
  submitToSession, withSessionLock, type TurnBinding,
} from "./chat.ts";

const log = createLogger("chat-inject");

/** Longest message body another session may send, in characters. */
export const MAX_INJECT_BODY_CHARS = 100_000;
/** Ids of the messages this door sent, so their `turn_started` can be told apart. */
const CLIENT_ID_PREFIX = "session-";
const MAX_REMEMBERED_BINDINGS = 500;

export interface DeliverToSessionInput {
  /** The receiving session, by any id it has been known by. */
  targetSessionId: string;
  /** The receiving session's provider; a delivery naming another is refused. */
  providerId: string;
  projectName: string;
  projectPath: string;
  /** What the sending AI wrote: plain text, no blocks of its own. */
  body: string;
  /** The sending session, as the from-session block names it. */
  fromSession: FromSessionReference;
  /** Turns the message points at (a created session's link to its creator's turn). */
  turnRefs?: readonly TurnReference[] | null;
  /**
   * The mode to run under when the receiving session has none in this process yet — what a
   * created session inherits from its creator. Never overrides a mode already chosen.
   */
  permissionMode?: string;
  /**
   * The mode the user approved this message in (a PPM Assistant message's card). Checked under the
   * session's lock, so a run started in another mode meanwhile gets nothing.
   */
  expectedMode?: string;
  /**
   * `next` (the default) joins a running turn at its next step; `later` waits until that turn is
   * over. A PPM Assistant message the user did not start cleanly goes `later`.
   */
  priority?: "next" | "later";
  /** How the PPM Assistant's turn started; only with a sender of kind `assistant`, written by the server. */
  provenance?: AssistantProvenance;
}

export interface DeliverToSessionResult {
  delivered: SessionDelivery;
  /** The receiving session's canonical id. */
  targetSessionId: string;
  /** The id the message was sent under; `turn_started` names it (see {@link waitForTurnBinding}). */
  clientMessageId: string;
  /** The message exactly as stored in the receiving session's transcript. */
  content: string;
  /** The turn the message opened or joined, when that was already known on return. */
  turnBinding?: TurnBinding;
}

/** A delivery refused before or during hand-off; the message did not reach the session. */
export class DeliverToSessionError extends Error {
  constructor(message: string, readonly code: "invalid" | "design_session" | "provider_mismatch" | "busy" | "failed") {
    super(message);
    this.name = "DeliverToSessionError";
  }
}

const recentBindings = new Map<string, TurnBinding>();
const bindingWaiters = new Map<string, Set<(binding: TurnBinding) => void>>();

onTurnBinding((binding) => {
  const id = binding.clientMessageId;
  if (!id?.startsWith(CLIENT_ID_PREFIX)) return;
  recentBindings.set(id, binding);
  if (recentBindings.size > MAX_REMEMBERED_BINDINGS) recentBindings.delete(recentBindings.keys().next().value!);
  const waiters = bindingWaiters.get(id);
  if (!waiters) return;
  bindingWaiters.delete(id);
  for (const resolve of waiters) resolve(binding);
});

/**
 * The turn a delivered message opened or joined, once the provider names it; null when it does
 * not within `timeoutMs` (a turn still queued behind an approval, a provider that names none).
 */
export function waitForTurnBinding(clientMessageId: string, timeoutMs: number): Promise<TurnBinding | null> {
  const known = recentBindings.get(clientMessageId);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    const set = bindingWaiters.get(clientMessageId) ?? new Set();
    bindingWaiters.set(clientMessageId, set);
    const done = (binding: TurnBinding | null) => {
      clearTimeout(timer);
      set.delete(onBinding);
      if (!set.size && bindingWaiters.get(clientMessageId) === set) bindingWaiters.delete(clientMessageId);
      resolve(binding);
    };
    const onBinding = (binding: TurnBinding) => done(binding);
    const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
    set.add(onBinding);
  });
}

/**
 * A leading `/` would make the provider run the text as a slash command (`/clear`, a skill) in a
 * session whose user never typed it. A zero-width space in front keeps it a plain message.
 */
function neutralizeLeadingCommand(body: string): string {
  return body.trimStart().startsWith("/") ? `${String.fromCharCode(0x200b)}${body}` : body;
}

/**
 * Delivers a message from another session into `targetSessionId`: inserted into a running turn
 * (`next` — Claude reads it at its next step, Codex steers it in), queued behind whatever the
 * session is waiting on, or opening a new turn (resuming a cold session first). A pending approval
 * or question in the target is never answered by it. Throws {@link DeliverToSessionError} when
 * the message did not reach the session.
 */
export async function deliverToSession(input: DeliverToSessionInput): Promise<DeliverToSessionResult> {
  if (typeof input.targetSessionId !== "string" || !SESSION_ID_RE.test(input.targetSessionId)) {
    throw new DeliverToSessionError("Invalid session id", "invalid");
  }
  if (typeof input.body !== "string" || !input.body.trim()) throw new DeliverToSessionError("The message is empty", "invalid");
  if (input.body.length > MAX_INJECT_BODY_CHARS) {
    throw new DeliverToSessionError(`The message is longer than ${MAX_INJECT_BODY_CHARS} characters`, "invalid");
  }
  const fromSession = validateFromSession({ ...input.fromSession });
  if (!fromSession) throw new DeliverToSessionError("Invalid sending session", "invalid");
  const turnRefs = input.turnRefs?.length ? validateTurnRefs(input.turnRefs) : null;
  if (input.turnRefs?.length && !turnRefs) throw new DeliverToSessionError("Invalid turn references", "invalid");

  const target = resolveMigratedSession(input.targetSessionId);
  if (target === resolveMigratedSession(fromSession.sessionId)) {
    throw new DeliverToSessionError("A session cannot message itself", "invalid");
  }
  if (getSessionDesignSlug(target)) {
    throw new DeliverToSessionError("A design session does not take messages from other sessions", "design_session");
  }
  if (isAssistantSession(target)) {
    throw new DeliverToSessionError("A PPM Assistant session does not take messages from other sessions", "invalid");
  }
  const stored = getSessionProvider(target);
  if (stored && stored !== input.providerId) {
    throw new DeliverToSessionError(`Session ${target} belongs to ${stored}, not ${input.providerId}`, "provider_mismatch");
  }

  if (input.provenance && fromSession.kind !== "assistant") throw new DeliverToSessionError("Only a PPM Assistant message carries a provenance block", "invalid");
  // An AI's text may not pose as a block only PPM writes (the user's words, a provenance): every
  // PPM-looking tag is defused, as a model reads it loosely, and so is the user-words header's
  // sentence, which needs no tag to be copied; the exact block markers are broken by the encoder,
  // so the only blocks that decode are these. This applies between ordinary chats too: a literal
  // `<ppm-…` tag in a session message (HTML naming such an element, say) arrives defused — accepted,
  // since no other door may carry PPM's own tags either.
  const content = encodeMessageBlocks(neutralizeLeadingCommand(defuseUserWordsHeader(neutralizePpmTags(input.body))), {
    fromSession, turnRefs, ownProject: input.projectName || undefined, ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  const clientMessageId = `${CLIENT_ID_PREFIX}${crypto.randomUUID()}`;
  const receivedAt = Date.now();

  return withSessionLock(target, async () => {
    const entry = ensureSessionEntry(target, input.providerId, input.projectPath, input.projectName);
    if (entry.providerId !== input.providerId) {
      // An entry made before the provider was known may still follow it while nothing runs.
      if (entry.phase !== "idle" || entry.isStreamingActive) {
        throw new DeliverToSessionError(`Session ${target} is running on ${entry.providerId}`, "provider_mismatch");
      }
      entry.providerId = input.providerId;
    }
    if (input.permissionMode && !entry.permissionMode) entry.permissionMode = input.permissionMode;
    if (input.expectedMode) {
      const now = chatTargetMode(target, entry.providerId).mode;
      if (now !== input.expectedMode) {
        if (entry.clients.size === 0 && !entry.isStreamingActive) startCleanupTimer(target);
        throw new DeliverToSessionError(
          `The chat would now run it in "${now}" rather than "${input.expectedMode}", the mode the user approved; ask again.`, "failed",
        );
      }
    }

    // Whose turn this is from now on, as for any message: another session's, never the user's.
    const previousOrigin = entry.turnOrigin;
    entry.turnOrigin = "session";
    const result = await submitToSession(target, entry, content, {
      origin: "session",
      clientMessageId,
      priority: input.priority ?? "next",
      receivedAt,
      supersedePendingApproval: false,
      // No device drew this message itself: every one showing the session draws it once it is in.
      echoOnHandOff: true,
    });
    if (!result.ok) {
      entry.turnOrigin = previousOrigin;
      // A socketless entry made for this delivery would otherwise stay in the registry for good.
      if (entry.clients.size === 0 && !entry.isStreamingActive) startCleanupTimer(target);
      log.warn(`session=${target} delivery from session=${fromSession.sessionId} failed: ${result.error}`);
      throw new DeliverToSessionError(result.error, result.error.includes("still starting") ? "busy" : "failed");
    }
    log.info(`session=${target} message from session=${fromSession.sessionId} ${result.delivered}`);
    // Server-side listeners hear this message as they hear one a device typed.
    chatLifecycle.emit("user_message", {
      sessionId: target, text: content, origin: "session", imageCount: 0,
      projectName: entry.projectName ?? input.projectName, providerId: entry.providerId,
    });
    const turnBinding = recentBindings.get(clientMessageId);
    return { delivered: result.delivered, targetSessionId: target, clientMessageId, content, ...(turnBinding ? { turnBinding } : {}) };
  });
}

/** How many AI-created sessions of the project have a turn in flight. */
export function runningSpawnedCount(projectName: string): number {
  return countSpawned(listRunningSessions(projectName).map((s) => s.sessionId));
}

/** A session tool created a session: every browser's session list adds it without a reload. */
export function announceSessionCreated(event: Omit<SessionCreatedEvent, "type">): void {
  broadcastGlobalEvent({ type: SESSION_CREATED_EVENT, ...event } satisfies SessionCreatedEvent);
}

/** These sessions gained a link (a spawn, a first message between two sessions). */
export function announceSessionLinkChanged(projectName: string, sessionIds: string[]): void {
  broadcastGlobalEvent({ type: SESSION_LINK_CHANGED_EVENT, projectName, sessionIds });
}

/** A create, pair-limit or escalation card appeared in, or left, a session. */
export function announceCollabApproval(event: Omit<SessionCollabApprovalEvent, "type">): void {
  broadcastGlobalEvent({ type: SESSION_COLLAB_APPROVAL_EVENT, ...event } satisfies SessionCollabApprovalEvent);
}
