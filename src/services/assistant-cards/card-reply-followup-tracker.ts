/**
 * Which manager turn answers a reply the user gave on a card, and what it answered.
 *
 * The user's words reach the manager chat under a `card-…` client id. The turn that read them is
 * the one a provider names with that id (`turn_started` in the chat's stream) — the next turn to
 * end is not it when the words were queued behind a running turn, and the chat may run other turns
 * (a schedule, another session's message) before or between. So a reply is followed by its id:
 * the first turn end after its turn was named carries the answer.
 *
 * A message no provider named (some providers do not name a turn a follow-up joined) is judged as
 * the session tools' waits judge it: after a turn ends, a short grace; if the chat is idle then, the
 * words went into that turn. Words queued behind a turn are never judged that way — they go into a
 * later turn, which is named when it opens, or never (the card is then opened again by the
 * delivery reconciler, and nothing is sent here).
 *
 * The answer is the turn's final text: the top-level text after its last top-level tool call,
 * never tool output, thinking or a subagent's text. Each reply gets at most one follow-up; a turn
 * with no text gets none. Listeners on the chat lifecycle run on its hot path, so everything here
 * only updates memory; `deliver` is handed the result and must not block.
 */
import type { SessionDelivery } from "../../shared/session-collab.ts";
import type { Cancel } from "../assistant-wake/assistant-clock.ts";

/** Where the user replied from, which is where the answer goes back. */
export type FollowupOrigin =
  | { channel: "ppm" }
  | { channel: "telegram"; chatId: string; /** The card's message the user replied to. */ replyTo?: number };

export interface FollowupResult {
  cardId: string;
  origin: FollowupOrigin;
  /** The manager chat, as the turn's events named it. */
  sessionId: string;
  /** The turn's final text, trimmed; never empty. */
  text: string;
  /** More text came than was kept: the rest is only in the chat. */
  overflow: boolean;
  /** Cards the manager made during that turn (a new card asking again, say). */
  newCards: Array<{ id: string; title: string }>;
}

export interface FollowupTrackerDeps {
  canonical(sessionId: string): string;
  /** Whether the session has no turn running now. */
  isIdle(sessionId: string): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): Cancel;
  deliver(result: FollowupResult): void;
  graceMs?: number;
  maxAgeMs?: number;
}

/** What `expect` hands back: how the words went in, or that they never did. */
export interface FollowupHandle {
  attach(delivered: SessionDelivery | undefined): void;
  abandon(): void;
}

interface Buffer { text: string; overflow: boolean }

interface Pending {
  cardId: string;
  clientMessageId: string;
  origin: FollowupOrigin;
  sessionId: string;
  delivered: SessionDelivery | null;
  bound: boolean;
  /** What a turn of the chat ended with while the send had not returned yet. */
  endedBeforeAttach: Buffer | null;
  at: number;
  newCards: Array<{ id: string; title: string }>;
}

/** How long after a turn ends an unnamed reply is judged, so a queued turn can start first. */
export const FOLLOWUP_GRACE_MS = 3_000;
/** A reply whose turn never came is forgotten after this (a manager turn may run for hours). */
export const FOLLOWUP_MAX_AGE_MS = 12 * 60 * 60_000;
/** Text kept per turn; the follow-up shows far less, this only has to tell "cut" from "whole". */
export const FOLLOWUP_BUFFER_MAX = 6_000;
const MAX_PENDING = 200;

export function createFollowupTracker(deps: FollowupTrackerDeps) {
  const pending = new Map<string, Pending>();
  const buffers = new Map<string, Buffer>();
  const graceMs = deps.graceMs ?? FOLLOWUP_GRACE_MS;
  const maxAgeMs = deps.maxAgeMs ?? FOLLOWUP_MAX_AGE_MS;
  const key = (sessionId: string): string => deps.canonical(sessionId);
  const live = (p: Pending): boolean => pending.get(p.clientMessageId) === p;
  /** The turn's text is only gathered for chats a reply is followed in. */
  const watched = (session: string): boolean => [...pending.values()].some((p) => key(p.sessionId) === session);
  const fresh = (session: string): void => { buffers.set(session, { text: "", overflow: false }); };

  function prune(): void {
    const now = deps.now();
    for (const [id, p] of pending) if (now - p.at > maxAgeMs) pending.delete(id);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
    for (const s of [...buffers.keys()]) if (!watched(s)) buffers.delete(s);
  }

  function finish(p: Pending, buffer: Buffer | undefined, session: string): void {
    if (!live(p)) return;
    pending.delete(p.clientMessageId);
    const text = buffer?.text.trim() ?? "";
    if (!text) return;
    deps.deliver({ cardId: p.cardId, origin: p.origin, sessionId: session, text, overflow: buffer!.overflow, newCards: p.newCards });
  }

  /** After the grace, an unnamed reply belongs to the turn that ended if nothing else started. */
  function judgeLater(p: Pending, buffer: Buffer | undefined): void {
    deps.setTimer(() => {
      if (!live(p) || p.bound) return;
      const session = key(p.sessionId);
      if (deps.isIdle(session)) finish(p, buffer, session);
    }, graceMs);
  }

  return {
    /**
     * The user's words are about to be sent to `sessionId` under `clientMessageId`. Registered
     * before the send, so a turn named — or even ended — before the send returns is still theirs.
     */
    expect(input: { cardId: string; clientMessageId: string; origin: FollowupOrigin; sessionId: string }): FollowupHandle {
      prune();
      const p: Pending = {
        cardId: input.cardId, clientMessageId: input.clientMessageId, origin: input.origin, sessionId: input.sessionId,
        delivered: null, bound: false, endedBeforeAttach: null, at: deps.now(), newCards: [],
      };
      const session = key(p.sessionId);
      if (!buffers.has(session)) fresh(session);
      pending.set(p.clientMessageId, p);
      return {
        attach(delivered) {
          if (!live(p)) return;
          p.delivered = delivered ?? "started";
          if (p.bound || p.delivered === "queued") return;
          // The turn the words opened ended before the send returned.
          if (p.endedBeforeAttach && p.delivered === "started") { judgeLater(p, p.endedBeforeAttach); return; }
          // Joined a running turn: the answer is what follows the words, not what came before them
          // (left alone while another reply's named turn is gathering its own answer there).
          const othersBound = [...pending.values()].some((o) => o !== p && o.bound && key(o.sessionId) === session);
          if (p.delivered === "inserted" && !othersBound) fresh(session);
        },
        abandon() {
          if (live(p)) pending.delete(p.clientMessageId);
        },
      };
    },

    /** Every event a chat sends its browsers (`chatLifecycle` `stream`). */
    onStream(sessionId: string, event: unknown): void {
      if (pending.size === 0 || !event || typeof event !== "object") return;
      const ev = event as { type?: unknown; content?: unknown; parentToolUseId?: unknown; clientMessageId?: unknown };
      const session = key(sessionId);
      if (ev.type === "turn_started" && typeof ev.clientMessageId === "string") {
        const p = pending.get(ev.clientMessageId);
        if (p) {
          p.bound = true;
          p.sessionId = sessionId;
          fresh(session);
        }
        return;
      }
      if (ev.parentToolUseId || !watched(session)) return;
      if (ev.type === "text" && typeof ev.content === "string") {
        const b = buffers.get(session) ?? { text: "", overflow: false };
        const text = b.text + ev.content;
        buffers.set(session, text.length > FOLLOWUP_BUFFER_MAX ? { text: text.slice(0, FOLLOWUP_BUFFER_MAX), overflow: true } : { text, overflow: b.overflow });
      } else if (ev.type === "tool_use") {
        // A top-level tool call starts a new block: only the text after the last one is the answer.
        fresh(session);
      }
    },

    /** A chat's turn ended (`chatLifecycle` `turn_ended`). */
    onTurnEnded(sessionId: string, turnStillRunning?: boolean): void {
      if (turnStillRunning || pending.size === 0) return;
      const session = key(sessionId);
      if (!watched(session)) return;
      const buffer = buffers.get(session);
      fresh(session);
      for (const p of [...pending.values()]) {
        if (key(p.sessionId) !== session) continue;
        if (p.bound) finish(p, buffer, session);
        else if (p.delivered === null) p.endedBeforeAttach = buffer ?? { text: "", overflow: false };
        // Unnamed, and not queued behind this turn: it went into this turn if nothing else started.
        else if (p.delivered !== "queued") judgeLater(p, buffer);
      }
    },

    /** A card was made: one the replied-to manager made while answering goes with the answer. */
    onCardCreated(card: { id: string; title: string; sessionId: string | null }): void {
      if (!card.sessionId || pending.size === 0) return;
      const session = key(card.sessionId);
      for (const p of pending.values()) {
        if (key(p.sessionId) === session && (p.bound || (p.delivered !== null && p.delivered !== "queued"))) {
          p.newCards.push({ id: card.id, title: card.title });
        }
      }
    },

    /** The provider renamed the chat: what was gathered under the old id moves with it. */
    onMigrated(oldSessionId: string, newSessionId: string): void {
      const b = buffers.get(oldSessionId);
      if (!b) return;
      buffers.delete(oldSessionId);
      buffers.set(key(newSessionId), b);
    },

    /** Replies still waiting for their answer, for tests and the log. */
    size: (): number => pending.size,

    clear(): void {
      pending.clear();
      buffers.clear();
    },
  };
}

export type FollowupTracker = ReturnType<typeof createFollowupTracker>;

/**
 * The start of `text` that fits `max` characters, never splitting a surrogate pair, and whether
 * anything was left out (`overflow`: the turn already said more than was kept).
 */
export function cutFollowupText(text: string, max: number, overflow = false): { text: string; truncated: boolean } {
  const whole = text.trim();
  if (whole.length <= max) return { text: whole, truncated: overflow };
  let end = max;
  const code = whole.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: whole.slice(0, end).trimEnd(), truncated: true };
}
