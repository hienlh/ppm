/**
 * The permission mode the server holds for a chat, and how a chat tab reconciles its own
 * with it.
 *
 * Every chat remembers its permission mode on the server, and a message sent with no mode
 * runs in that stored mode. A chat created somewhere else — the PPM Assistant's `chat_start`,
 * another device — reaches a tab whose metadata holds no mode at all, so the tab learns the
 * chat's mode from the connect greeting (`session_state`). Without that, the composer showed
 * its own fallback ("Bypass permissions") over a chat the user had approved as "Ask before
 * edits", and a mode left over in the tab would have been sent over the stored one.
 */
import type { PermissionMode } from "../../types/config";

// A type-only tie to the server's list: a value import would pull the whole config module
// into the browser bundle. The record type fails to compile if a mode is added or renamed.
const KNOWN_MODES: Record<PermissionMode, true> = { default: true, acceptEdits: true, plan: true, bypassPermissions: true };

export interface SessionPermissionState {
  /** The chat the greeting described: a greeting never speaks for the next chat in the tab. */
  sessionId: string | null;
  /** The mode stored for the chat, or null when the server stores none. */
  stored: string | null;
  /** What a message with no mode runs in when nothing is stored. Shown, never sent. */
  fallback?: string;
}

function knownMode(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(KNOWN_MODES, value) ? value : null;
}

/** Reads the permission fields of a connect greeting; anything unrecognised counts as absent. */
export function sessionPermissionFromGreeting(
  greeting: { permissionMode?: unknown; defaultPermissionMode?: unknown },
  sessionId: string | null,
): SessionPermissionState {
  const fallback = knownMode(greeting.defaultPermissionMode);
  return { sessionId, stored: knownMode(greeting.permissionMode), ...(fallback ? { fallback } : {}) };
}

/**
 * The stored mode a tab should take over, or null to keep its own.
 *
 * The server's stored mode wins over whatever the tab carries — a mode left in its metadata
 * from an earlier run, or none — because the tab sends its mode with every message and the
 * server stores what it is sent. The one exception is a mode the user picked by hand in this
 * tab for this very chat and has not yet sent: a reconnect greeting still carries the older
 * stored mode, and must not undo the pick.
 */
export function storedPermissionToAdopt(
  server: SessionPermissionState | null,
  sessionId: string | null,
  current: string | undefined,
  pickedForSession: string | null | undefined,
): string | null {
  if (!server || !sessionId || server.sessionId !== sessionId || !server.stored) return null;
  if (pickedForSession === sessionId) return null;
  return server.stored === current ? null : server.stored;
}

/**
 * The mode the composer's chip shows: the tab's own, else the server's fallback for this chat,
 * else nothing — an unknown mode is never displayed as one it may not be.
 */
export function shownPermissionMode(
  current: string | undefined,
  server: SessionPermissionState | null,
  sessionId: string | null,
): string | undefined {
  if (current) return current;
  if (server && sessionId && server.sessionId === sessionId) return server.stored ?? server.fallback;
  return undefined;
}
