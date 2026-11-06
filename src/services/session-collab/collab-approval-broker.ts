import { randomUUID } from "node:crypto";
import {
  SESSION_COLLAB_APPROVAL, isSessionCollabAnswer, sessionCollabAnswersFor,
  type SessionCollabAnswer, type SessionCollabApprovalInput, type SessionCollabApprovalRequest,
} from "../../shared/session-collab.ts";
import { COLLAB_APPROVAL_WAIT_MS } from "./session-collab-tool.ts";

/**
 * The cards a session tool waits on before it acts: creating a session, messaging past the pair
 * limit, and messaging a session with more permissions than the sender's. The call waits here
 * while the asking session's chat shows the card in its one approval slot (`ws/chat.ts`, which
 * queues it behind a provider's own approval rather than replacing it), and the user answers over
 * HTTP (`POST /api/sessions-collab/approvals/:requestId`, behind PPM's auth) — never over the chat
 * socket. Nobody answering in time, the user writing instead, or the turn being stopped all settle
 * it as not allowed. One card per session at a time; sessions are known by their canonical id.
 */

export interface CollabApprovalChat {
  /** Show the card in the session's chat; false when this server has no chat for the session. */
  announce(sessionId: string, event: SessionCollabApprovalRequest): boolean;
  /** The card was answered, or given up on: take it off the session's devices. */
  resolved(sessionId: string, requestId: string, answer: SessionCollabAnswer | null): void;
}

export type CollabApprovalOutcome =
  | { allowed: true; answer: "allow_once" | "allow_session" }
  | { allowed: false; reason: "denied" | "timeout" | "cancelled" | "no-chat" | "busy"; message: string };

export type CollabApprovalAnswerResult =
  | { ok: true; answer: SessionCollabAnswer }
  | { ok: false; status: 400 | 404; error: string };

interface Pending {
  sessionId: string;
  event: SessionCollabApprovalRequest;
  settle: (outcome: CollabApprovalOutcome) => void;
}

export function createCollabApprovalBroker(opts: {
  chat: () => CollabApprovalChat | null;
  canonical?: (sessionId: string) => string;
}) {
  const canonical = opts.canonical ?? ((sessionId: string) => sessionId);
  const pending = new Map<string, Pending>();

  function pendingOf(sessionId: string): [string, Pending] | null {
    const id = canonical(sessionId);
    for (const entry of pending) if (canonical(entry[1].sessionId) === id) return entry;
    return null;
  }

  /** Shows `input` as a card in `asked`'s chat and waits for the user's answer. */
  function request(asked: string, input: SessionCollabApprovalInput, signal?: AbortSignal, waitMs = COLLAB_APPROVAL_WAIT_MS): Promise<CollabApprovalOutcome> {
    const sessionId = canonical(asked);
    if (signal?.aborted) return Promise.resolve({ allowed: false, reason: "cancelled", message: "The call was cancelled before the user was asked." });
    if (pendingOf(sessionId)) {
      return Promise.resolve({ allowed: false, reason: "busy", message: "Another request is already waiting for the user's answer in this chat; wait for it, then call again." });
    }
    const requestId = randomUUID();
    const event: SessionCollabApprovalRequest = { type: "approval_request", requestId, tool: SESSION_COLLAB_APPROVAL, input };
    return new Promise<CollabApprovalOutcome>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle({ allowed: false, reason: "cancelled", message: "The call was cancelled before the user answered." });
      const settle = (outcome: CollabApprovalOutcome): void => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try {
          opts.chat()?.resolved(canonical(entry.sessionId), requestId, outcome.allowed ? outcome.answer : outcome.reason === "denied" ? "deny" : null);
        } catch (e) {
          console.warn(`[session-collab] clearing approval ${requestId} failed: ${(e as Error).message}`);
        }
        done(outcome);
      };
      pending.set(requestId, { sessionId, event, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      let shown = false;
      try {
        shown = opts.chat()?.announce(sessionId, event) ?? false;
      } catch (e) {
        console.warn(`[session-collab] announcing approval failed for session=${sessionId}: ${(e as Error).message}`);
      }
      if (!shown) {
        settle({ allowed: false, reason: "no-chat", message: "This chat is not open in PPM, so the user cannot be asked. Nothing was done." });
        return;
      }
      timer = setTimeout(() => settle({
        allowed: false, reason: "timeout", message: `The user did not answer within ${Math.round(waitMs / 60_000)} minutes, so nothing was done.`,
      }), waitMs);
    });
  }

  /** The user's answer from the card. An answer the card does not offer is refused. */
  function answer(requestId: string, body: unknown): CollabApprovalAnswerResult {
    const entry = pending.get(requestId);
    if (!entry) return { ok: false, status: 404, error: "This request is no longer waiting: it was answered, cancelled or timed out." };
    const raw = body && typeof body === "object" ? (body as { answer?: unknown }).answer : undefined;
    if (!isSessionCollabAnswer(raw) || !sessionCollabAnswersFor(entry.event.input.kind).includes(raw)) {
      return { ok: false, status: 400, error: `answer must be one of: ${sessionCollabAnswersFor(entry.event.input.kind).join(", ")}` };
    }
    if (raw === "deny") entry.settle({ allowed: false, reason: "denied", message: "The user said no, so nothing was done. Do not ask again in this turn." });
    else entry.settle({ allowed: true, answer: raw });
    return { ok: true, answer: raw };
  }

  /** Settles the session's pending card as not allowed, if it has one; true when it had. */
  function cancelSession(sessionId: string, message: string): boolean {
    const found = pendingOf(sessionId);
    if (!found) return false;
    found[1].settle({ allowed: false, reason: "cancelled", message });
    return true;
  }

  return {
    request,
    answer,
    cancelSession,
    has: (requestId: string) => pending.has(requestId),
    pendingEvent: (sessionId: string): SessionCollabApprovalRequest | null => pendingOf(sessionId)?.[1].event ?? null,
    pendingCount: () => pending.size,
  };
}

let chat: CollabApprovalChat | null = null;
let resolveSession: (sessionId: string) => string = (sessionId) => sessionId;

/** `ws/chat.ts` owns the chats; it registers how to show a card and how to follow a renamed session. */
export function setCollabApprovalChat(fn: CollabApprovalChat | null, canonical?: (sessionId: string) => string): void {
  chat = fn;
  resolveSession = canonical ?? ((sessionId) => sessionId);
}

export const collabApprovalBroker = createCollabApprovalBroker({
  chat: () => chat,
  canonical: (sessionId) => resolveSession(sessionId),
});
