import { chatService } from "../../services/chat.service.ts";
import { createLogger } from "../../services/logger.ts";
import { resolveMigratedSession } from "../../services/db.service.ts";
import { bufferAndBroadcast, type ExtensionTurnSpec, type SessionEntry } from "./chat.ts";
import { REST_CALLER } from "./chat-headless-turn-helpers.ts";
import type { HeadlessTurnOpts } from "./chat-headless-turn.ts";

const log = createLogger("chat-headless");

/** Default wall-clock budget: nobody is watching to cancel a turn that never finishes. */
export const DEFAULT_HEADLESS_TIMEOUT_MS = 30 * 60_000;

/**
 * What an extension's turn is: its door, its caller, whether it may push "Chat completed",
 * and a wall-clock budget armed when the turn starts and tied to that turn's end — not to the
 * consumer's, which for a real provider only ends when the session is torn down.
 */
export function extensionTurn(sessionId: string, opts: HeadlessTurnOpts): ExtensionTurnSpec {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS;
  return {
    extensionId: opts.extensionId ?? REST_CALLER,
    notifyOnDone: opts.notifyOnDone === true,
    onStart: (entry) => armBudget(entry, sessionId, timeoutMs),
  };
}

function armBudget(entry: SessionEntry, sessionId: string, timeoutMs: number): void {
  let budgetTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    budgetTimer = undefined;
    if (entry.phase === "idle") return;
    // Codex renames a session during its first turn: the entry and its clients live under the new id.
    const liveId = resolveMigratedSession(sessionId);
    log.warn(`session=${liveId} headless turn cancelled: exceeded ${timeoutMs}ms wall-clock budget`);
    chatService.abortQuery(entry.providerId, liveId, "headless_timeout", "extension");
    bufferAndBroadcast(liveId, {
      type: "error",
      message: `Headless turn cancelled: exceeded the ${Math.round(timeoutMs / 1000)}s wall-clock budget`,
    });
  }, timeoutMs);
  (entry.onTurnEnd ??= new Set()).add(() => {
    if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = undefined; }
  });
}
