import { getSessionProjectName, getSessionProvider, getSessionTitle, resolveMigratedSession } from "../db.service.ts";
import { hasHeldLogin } from "../database/connection-login.ts";
import { createLogger } from "../logger.ts";
import { dbAttentionEvents, type DbAttentionBus } from "./db-attention-events.ts";

/**
 * Tells the user that a chat's database tool reached a connection nobody has logged in to since
 * PPM started (its password is asked for, never saved). Without this the AI only reads an error
 * and asks in the chat, which a user away from PPM never sees, so the chat just stops.
 *
 * Told once per connection and chat within `DB_LOGIN_NOTICE_WINDOW_MS`: an AI retrying, or
 * reading several tables, would otherwise send one notice per call. The notice goes out on the
 * attention bus (the PPM Assistant's Telegram bridge) and as an ordinary "Needs approval"
 * notification (push, the notification bot, ntfy). Logging in happens in PPM's Database panel only.
 */

export const DB_LOGIN_NOTICE_WINDOW_MS = 30 * 60_000;

const log = createLogger("db-tools");

export interface DbLoginAttentionDeps {
  events?: Pick<DbAttentionBus, "emit">;
  now?: () => number;
  windowMs?: number;
  /** The id a session goes by now; Codex renames a new chat during its first turn. */
  canonical?: (sessionId: string) => string;
  /** The "Needs approval" notification; none when left out. */
  notify?: (sessionId: string, conn: { id: number; name: string }) => void;
}

export function createDbLoginAttention(deps: DbLoginAttentionDeps = {}) {
  const events = deps.events ?? dbAttentionEvents;
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? DB_LOGIN_NOTICE_WINDOW_MS;
  const canonical = deps.canonical ?? ((sessionId: string) => sessionId);
  /** When each connection-and-chat pair was last told, pruned as it ages. */
  const told = new Map<string, number>();

  /** The user is told, unless this pair was told within the window; true when told now. */
  function loginNeeded(asked: string, conn: { id: number; name: string }): boolean {
    const sessionId = canonical(asked);
    const at = now();
    for (const [key, when] of told) if (at - when >= windowMs) told.delete(key);
    const key = `${conn.id}\u0000${sessionId}`;
    if (told.has(key)) return false;
    told.set(key, at);
    events.emit("login_needed", { sessionId, connectionId: conn.id, connectionName: conn.name });
    try {
      deps.notify?.(sessionId, conn);
    } catch (e) {
      log.warn(`login notification for connection ${conn.id} failed: ${(e as Error).message}`);
    }
    return true;
  }

  return { loginNeeded, size: () => told.size };
}

/** The "Needs approval" notification for a connection waiting on a login, through the usual channels. */
function notifyLoginNeeded(sessionId: string, conn: { id: number; name: string }): void {
  const project = getSessionProjectName(sessionId) ?? "";
  const providerId = getSessionProvider(sessionId) ?? undefined;
  // Imported here: the chat and notification services are heavy, and this module is loaded with the endpoint.
  Promise.all([import("../chat.service.ts"), import("../notification.service.ts")]).then(([{ chatService }, { notificationService }]) => {
    const sessionTitle = getSessionTitle(sessionId) || chatService.getSession(sessionId)?.title || `Session ${sessionId.slice(0, 8)}`;
    return notificationService.broadcast("approval_request", {
      title: "Database login needed",
      body: `${project || "Project"} — AI needs ${conn.name}: log in in PPM's Database panel`,
      project, sessionId, ...(providerId ? { providerId } : {}), sessionTitle,
    }, {
      // Its own slot: the turn usually ends right after, and its "Chat completed" must not replace this.
      ownKey: `db-login:${conn.id}:${sessionId}`,
      // Someone logged in meanwhile: nothing left to tell.
      stillUnseen: () => !hasHeldLogin(conn.id),
    });
  }).catch((e) => {
    log.warn(`login notification for ${sessionId} not sent: ${(e as Error).message}`);
  });
}

export const dbLoginAttention = createDbLoginAttention({ canonical: resolveMigratedSession, notify: notifyLoginNeeded });
