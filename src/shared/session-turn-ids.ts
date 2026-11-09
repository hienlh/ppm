/**
 * The shapes a session id and a turn id may take when they arrive from outside — a tab, a pasted
 * link, a tool call. Shared so the browser, the message codec and the server check the same thing.
 */

/** A chat session id as Claude or Codex writes it (and PPM's own draft ids). */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A turn id as either provider writes it — Claude: the prompt's `promptId`, or `u:<uuid>` when it
 * has none; Codex: the native `turn_id`.
 */
export const TURN_ID_RE = /^(u:)?[A-Za-z0-9-]{8,64}$/;
