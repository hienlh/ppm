import { getSessionDesignSlug, getSessionEffort, getSessionModel, getSessionThinking, setSessionModel, setSessionEffort, setSessionPermissionMode, setSessionThinking } from "../../services/db.service.ts";
import { VALID_EFFORT_VALUES, THINKING_ADAPTIVE } from "../../providers/claude-agent-sdk-query-options.ts";
import { VALID_PERMISSION_MODES } from "../../types/config.ts";
import { validateReply } from "../../shared/chat-reply.ts";
import { validateChatImages } from "../../shared/validate-chat-images.ts";
import { broadcast, type SessionEntry } from "./chat.ts";
import type { HeadlessTurnOpts } from "./chat-headless-turn.ts";

/** Wall-clock budget bounds: below `MIN` a turn could not plausibly finish, above `MAX`
 *  (24h) it is no budget at all, and a huge value would make `setTimeout` fire at once. */
export const MIN_HEADLESS_TIMEOUT_MS = 1_000;
export const MAX_HEADLESS_TIMEOUT_MS = 24 * 60 * 60_000;

/** The content is written to the transcript and replayed to every attached device. */
export const MAX_HEADLESS_CONTENT_CHARS = 1_000_000;

/** How many sessions one caller may have a turn running, starting or queued in at once. */
export const MAX_HEADLESS_TURNS_PER_CALLER = 4;
/** The cap bucket of the REST door, which carries no extension id. */
export const REST_CALLER = "rest";

/** A Claude turn is running on other picks than this message asks for; refused rather than run on the wrong model. */
export const BUSY_DIFFERENT_MODEL = "BUSY_DIFFERENT_MODEL";
/** The idle subprocess a model change would restart still runs a background agent or shell. */
export const BUSY_BACKGROUND_WORK = "BUSY_BACKGROUND_WORK";
/** Another door kept starting this session's consumer for as long as the call waited. */
export const BUSY_STARTING = "BUSY_STARTING";
/** The caller already has `MAX_HEADLESS_TURNS_PER_CALLER` sessions in flight. */
export const TOO_MANY_HEADLESS_TURNS = "TOO_MANY_HEADLESS_TURNS";

/** A refusal with the HTTP status the REST door answers it with; the RPC door sends the message. */
export class HeadlessTurnError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HeadlessTurnError";
  }
}

/**
 * Validate a headless turn's body — the REST route and the extension RPC refuse the same
 * things. Returns a user-facing message for the first violation, or null when valid.
 */
export function validateHeadlessSend(body: Record<string, unknown> | null | undefined): string | null {
  if (!body || typeof body !== "object") return "content is required";
  const { content, timeoutMs, images, permissionMode } = body;
  const hasImages = Array.isArray(images) && images.length > 0;
  if (typeof content !== "string" || (!content.trim() && !hasImages)) return "content is required";
  if (content.length > MAX_HEADLESS_CONTENT_CHARS) return `content too large (max ${MAX_HEADLESS_CONTENT_CHARS} chars)`;
  if (timeoutMs !== undefined && (
    !Number.isInteger(timeoutMs) || (timeoutMs as number) < MIN_HEADLESS_TIMEOUT_MS || (timeoutMs as number) > MAX_HEADLESS_TIMEOUT_MS
  )) {
    return `timeoutMs must be an integer between ${MIN_HEADLESS_TIMEOUT_MS} and ${MAX_HEADLESS_TIMEOUT_MS}`;
  }
  if (permissionMode !== undefined && !VALID_PERMISSION_MODES.includes(permissionMode as typeof VALID_PERMISSION_MODES[number])) {
    return `permissionMode must be one of: ${VALID_PERMISSION_MODES.join(", ")}`;
  }
  if (images !== undefined && !Array.isArray(images)) return "images must be an array";
  return validateChatImages(images as { data: string; mediaType: string }[] | undefined);
}

/** A reply reference must name this very session and provider, as the socket requires. */
export function validateHeadlessReply(opts: HeadlessTurnOpts, sessionId: string): string | null {
  if (opts.replyTo == null) return null;
  const reply = validateReply(opts.replyTo);
  if (!reply || reply.sessionId !== sessionId || reply.providerId !== opts.providerId) return "Invalid reply reference for this session";
  opts.replyTo = reply;
  return null;
}

/** No sender to skip: every attached device is an "other" client and must see the user
 *  line above the assistant stream, as it does for a turn typed on another device. */
export function makeEchoToAttachedClients(entry: SessionEntry, sessionId: string, images?: HeadlessTurnOpts["images"]): (finalContent: string) => void {
  return (finalContent: string) => {
    if (entry.clients.size === 0) return;
    broadcast(sessionId, {
      type: "user_message",
      content: finalContent,
      imageCount: images?.length ?? 0,
      timestamp: new Date().toISOString(),
    });
  };
}

/** The per-turn picks this message carries, normalised to what the session stores. */
export function requestedOverrides(opts: HeadlessTurnOpts): { model?: string; effort?: string; thinking?: number } {
  return {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort && VALID_EFFORT_VALUES.includes(opts.effort as typeof VALID_EFFORT_VALUES[number]) ? { effort: opts.effort } : {}),
    ...(typeof opts.thinking === "boolean" ? { thinking: opts.thinking ? THINKING_ADAPTIVE : 0 } : {}),
  };
}

/**
 * Whether this message asks for a model, effort or thinking other than the session's
 * current ones — what a live Claude subprocess was built with and cannot change in place.
 */
export function overridesDiffer(entry: SessionEntry, sessionId: string, opts: HeadlessTurnOpts): boolean {
  const asked = requestedOverrides(opts);
  if (asked.model !== undefined && asked.model !== (entry.model ?? getSessionModel(sessionId) ?? undefined)) return true;
  if (asked.effort !== undefined && asked.effort !== (getSessionEffort(sessionId) ?? undefined)) return true;
  if (asked.thinking !== undefined && asked.thinking !== (getSessionThinking(sessionId) ?? undefined)) return true;
  return false;
}

/**
 * Persist per-session overrides exactly as the socket does, so a pick made over RPC sticks
 * the way one made in the tab would — for user-typed turns too. The permission mode is kept
 * on the entry like the socket keeps it (and in the row for a design session): the next
 * consumer start takes it, while a live subprocess keeps the mode it was built with.
 */
export function persistHeadlessTurnOverrides(entry: SessionEntry, sessionId: string, opts: HeadlessTurnOpts): void {
  const asked = requestedOverrides(opts);
  if (asked.model) {
    entry.model = asked.model;
    setSessionModel(sessionId, asked.model);
  }
  if (asked.effort) setSessionEffort(sessionId, asked.effort);
  if (asked.thinking !== undefined) setSessionThinking(sessionId, asked.thinking);
  if (opts.permissionMode && VALID_PERMISSION_MODES.includes(opts.permissionMode as typeof VALID_PERMISSION_MODES[number])) {
    entry.permissionMode = opts.permissionMode;
    if (getSessionDesignSlug(sessionId)) setSessionPermissionMode(sessionId, opts.permissionMode);
  }
}
