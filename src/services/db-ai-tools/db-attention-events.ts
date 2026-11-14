import { createLogger } from "../logger.ts";
import type { DbExecuteApprovalInput } from "../../shared/db-ai-tools.ts";

/**
 * Moments when a chat's database tool waits on the user, for the channels that can tell them
 * while they are away from PPM (the PPM Assistant's Telegram bridge listens here). These are
 * notices only: the answer — PPM's password, a database login — is given in PPM and nowhere else.
 *
 * - `approval_shown`: a `db_execute` change waits for the user's approval.
 * - `approval_reminder`: the same approval is still waiting, a few minutes before it gives up.
 * - `login_needed`: a tool reached a connection that asks for its password and nobody has logged
 *   in to it since PPM started. Already deduplicated per connection and chat by the sender.
 *
 * Synchronous: a listener only enqueues. A listener that throws is logged and the others still run.
 */
export interface DbAttentionEvents {
  approval_shown: { sessionId: string; requestId: string; input: DbExecuteApprovalInput; expiresAt: number };
  approval_reminder: { sessionId: string; requestId: string; input: DbExecuteApprovalInput; expiresAt: number };
  login_needed: { sessionId: string; connectionId: number; connectionName: string };
}

export type DbAttentionEventName = keyof DbAttentionEvents;

const log = createLogger("db-tools");

export function createDbAttentionEvents() {
  const listeners = new Map<DbAttentionEventName, Set<(payload: never) => void>>();

  /** Subscribes; the returned function unsubscribes. */
  function on<K extends DbAttentionEventName>(name: K, listener: (payload: DbAttentionEvents[K]) => void): () => void {
    let set = listeners.get(name);
    if (!set) listeners.set(name, set = new Set());
    set.add(listener as (payload: never) => void);
    return () => { set!.delete(listener as (payload: never) => void); };
  }

  function emit<K extends DbAttentionEventName>(name: K, payload: DbAttentionEvents[K]): void {
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        (listener as (p: DbAttentionEvents[K]) => void)(payload);
      } catch (e) {
        log.warn(`listener for "${name}" failed (session=${payload.sessionId}): ${(e as Error)?.message ?? e}`);
      }
    }
  }

  return { on, emit };
}

export type DbAttentionBus = ReturnType<typeof createDbAttentionEvents>;

/** The process-wide bus the database tools emit on. */
export const dbAttentionEvents = createDbAttentionEvents();
