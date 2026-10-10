import { resolveMigratedSession } from "../db.service.ts";
import { chatLifecycle, type ChatLifecycle } from "../chat-control/chat-lifecycle.ts";

/**
 * The id `chat_start` hands back for the chat it opened: the one the chat will keep.
 *
 * Codex creates a new chat under a draft id and replaces it with its thread id once the first
 * turn has started its thread — after the message was accepted, so after `chat_start` would have
 * answered. An Assistant told the draft id then hears every later report under the thread id, and
 * cannot tell they are the same chat (in a live trial it disowned the very report it had promised).
 * So for Codex the answer waits for the rename, bounded: a thread that never starts ends its turn,
 * and a slow one runs out the clock. The draft id stays valid either way — every tool resolves it
 * through `resolveMigratedSession` — so a timeout only means the id is not the final one yet.
 */

/** Long enough for a cold Codex app-server to start a thread; the turn itself is not waited for. */
export const CODEX_RENAME_WAIT_MS = 15_000;

export function awaitCanonicalSessionId(
  sessionId: string,
  providerId: string,
  opts: { lifecycle?: ChatLifecycle; timeoutMs?: number; resolve?: (id: string) => string } = {},
): Promise<string> {
  const resolveId = opts.resolve ?? resolveMigratedSession;
  const now = resolveId(sessionId);
  // Only Codex renames a chat it was just given; Claude keeps the id it was created with.
  if (now !== sessionId || providerId !== "codex") return Promise.resolve(now);
  const lifecycle = opts.lifecycle ?? chatLifecycle;
  return new Promise((resolve) => {
    let settled = false;
    const stops: Array<() => void> = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stop of stops) stop();
      resolve(resolveId(sessionId));
    };
    const timer = setTimeout(finish, opts.timeoutMs ?? CODEX_RENAME_WAIT_MS);
    stops.push(
      lifecycle.on("migrated", (p) => { if (p.oldSessionId === sessionId) finish(); }),
      // A turn that ended under the draft id (a thread that failed to start) will not be renamed.
      lifecycle.on("turn_ended", (p) => { if (p.sessionId === sessionId) finish(); }),
    );
  });
}
