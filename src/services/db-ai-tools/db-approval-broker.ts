import { randomUUID } from "node:crypto";
import { DB_EXECUTE_APPROVAL, type DbApprovalAnswer, type DbExecuteApprovalInput } from "../../shared/db-ai-tools.ts";
import { checkPpmPassword, ppmPasswordRequired } from "../ppm-password.ts";

/**
 * The server half of `db_execute`'s approval. The call waits here while the chat shows the user
 * what would run (`ws/chat.ts` holds it as the session's pending approval, so a device that
 * connects later sees it too, and sends the "Waiting for approval" notification), and the user
 * answers over HTTP (`POST /api/db/ai-approvals/:requestId`, behind PPM's auth) with PPM's
 * password typed again. A wrong password leaves the approval pending; a decline, the user
 * sending a message or stopping the chat, or nobody answering in time settles it as declined.
 *
 * One approval per session at a time, and a session is known by the id it goes by now: Codex
 * renames a new chat during its first turn, which can be while the approval waits.
 */

export type DbApprovalEvent = { type: "approval_request"; requestId: string; tool: typeof DB_EXECUTE_APPROVAL; input: DbExecuteApprovalInput };

export interface DbApprovalChat {
  /** Show the approval in the session's chat; false when this server has no chat for the session. */
  announce(sessionId: string, event: DbApprovalEvent): boolean;
  /** The approval was answered, or given up on: take it off the session's devices. */
  resolved(sessionId: string, requestId: string, approved: boolean): void;
}

export type DbApprovalOutcome =
  | { approved: true }
  | { approved: false; reason: "declined" | "timeout" | "cancelled" | "no-chat" | "busy"; message: string };

export type DbApprovalAnswerResult =
  | { ok: true; approved: boolean }
  | { ok: false; status: 400 | 403 | 404; error: string };

/** How long the user has to answer. */
export const DB_APPROVAL_WAIT_MS = 10 * 60_000;

interface Pending {
  sessionId: string;
  event: DbApprovalEvent;
  settle: (outcome: DbApprovalOutcome) => void;
}

export function createDbApprovalBroker(opts: {
  chat: () => DbApprovalChat | null;
  /** The id a session goes by now, following a provider's rename; the id itself by default. */
  canonical?: (sessionId: string) => string;
  passwordRequired?: () => boolean;
  checkPassword?: (typed: unknown) => boolean;
}) {
  const canonical = opts.canonical ?? ((sessionId: string) => sessionId);
  const passwordRequired = opts.passwordRequired ?? ppmPasswordRequired;
  const checkPassword = opts.checkPassword ?? checkPpmPassword;
  const pending = new Map<string, Pending>();

  function pendingOf(sessionId: string): [string, Pending] | null {
    const id = canonical(sessionId);
    for (const entry of pending) if (canonical(entry[1].sessionId) === id) return entry;
    return null;
  }

  /**
   * Asks the user to approve `input` and waits for the answer. `signal` is the tool call's own
   * request: a provider that gave up on the call (the user stopped the turn) settles it.
   */
  function request(asked: string, input: Omit<DbExecuteApprovalInput, "passwordRequired">, waitMs = DB_APPROVAL_WAIT_MS, signal?: AbortSignal): Promise<DbApprovalOutcome> {
    const sessionId = canonical(asked);
    if (signal?.aborted) return Promise.resolve({ approved: false, reason: "cancelled", message: "The call was cancelled before the user was asked, so nothing ran." });
    if (pendingOf(sessionId)) {
      return Promise.resolve({ approved: false, reason: "busy", message: "Another change is already waiting for the user's approval in this chat; wait for its answer, then call again." });
    }
    const requestId = randomUUID();
    const event: DbApprovalEvent = { type: "approval_request", requestId, tool: DB_EXECUTE_APPROVAL, input: { ...input, passwordRequired: passwordRequired() } };
    return new Promise<DbApprovalOutcome>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle({ approved: false, reason: "cancelled", message: "The call was cancelled before the user answered, so nothing ran." });
      const settle = (outcome: DbApprovalOutcome): void => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try {
          opts.chat()?.resolved(canonical(entry.sessionId), requestId, outcome.approved);
        } catch (e) {
          console.warn(`[db-tools] clearing approval ${requestId} failed: ${(e as Error).message}`);
        }
        done(outcome);
      };
      pending.set(requestId, { sessionId, event, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      let shown = false;
      try {
        shown = opts.chat()?.announce(sessionId, event) ?? false;
      } catch (e) {
        console.warn(`[db-tools] announcing approval failed for session=${sessionId}: ${(e as Error).message}`);
      }
      if (!shown) {
        settle({
          approved: false, reason: "no-chat",
          message: "This chat is not open in PPM's web UI, so the user cannot be asked to approve the change. Nothing ran; give the user the SQL to run themselves.",
        });
        return;
      }
      timer = setTimeout(() => settle({
        approved: false, reason: "timeout",
        message: `The user did not answer within ${Math.round(waitMs / 60_000)} minutes, so nothing ran.`,
      }), waitMs);
    });
  }

  /** The user's answer, from the approval card. A wrong password leaves the approval pending. */
  function answer(requestId: string, body: Partial<DbApprovalAnswer> | null): DbApprovalAnswerResult {
    const entry = pending.get(requestId);
    if (!entry) return { ok: false, status: 404, error: "This approval is no longer waiting: it was answered, cancelled or timed out." };
    if (!body || typeof body.approved !== "boolean") return { ok: false, status: 400, error: "approved must be true or false" };
    if (!body.approved) {
      entry.settle({ approved: false, reason: "declined", message: "The user declined the change, so nothing ran." });
      return { ok: true, approved: false };
    }
    if (!checkPassword(body.password)) return { ok: false, status: 403, error: "Wrong password" };
    entry.settle({ approved: true });
    return { ok: true, approved: true };
  }

  /** Declines the session's pending approval, if it has one; true when it had. */
  function cancelSession(sessionId: string, message: string): boolean {
    const found = pendingOf(sessionId);
    if (!found) return false;
    found[1].settle({ approved: false, reason: "cancelled", message });
    return true;
  }

  return {
    request,
    answer,
    cancelSession,
    /** Whether `requestId` is one of these approvals, still pending. */
    has: (requestId: string) => pending.has(requestId),
    /** The session's pending approval as the chat shows it, or null. */
    pendingEvent: (sessionId: string): DbApprovalEvent | null => pendingOf(sessionId)?.[1].event ?? null,
    pendingCount: () => pending.size,
  };
}

let chat: DbApprovalChat | null = null;
let resolveSession: (sessionId: string) => string = (sessionId) => sessionId;

/** `ws/chat.ts` owns the chats; it registers how to show an approval and how to follow a renamed session. */
export function setDbApprovalChat(fn: DbApprovalChat | null, canonical?: (sessionId: string) => string): void {
  chat = fn;
  resolveSession = canonical ?? ((sessionId) => sessionId);
}

export const dbApprovalBroker = createDbApprovalBroker({
  chat: () => chat,
  canonical: (sessionId) => resolveSession(sessionId),
});
