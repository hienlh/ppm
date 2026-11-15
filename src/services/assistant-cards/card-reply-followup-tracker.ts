/**
 * Which manager turn answers a reply the user gave on a card, and what it answered.
 *
 * The user's words reach the manager chat under a `card-…` client id. The turn that read them is
 * the one a provider names with that id (`turn_started` in the chat's stream) — the next turn to
 * end is not it when the words were queued behind a running turn, and the chat may run other turns
 * (a schedule, another session's message) before or between. So a reply is followed by its id:
 * the first turn end after its turn was named carries the answer.
 *
 * A message no provider named is judged once, against the first turn end after it went in. Claude
 * names a message only when it opens a turn: one pushed into a running turn is folded in by the
 * CLI and never named. So that turn's answer is kept, and after a short grace it is sent only if
 * the reply's own turn has not been named meanwhile, the chat is idle and its latest turn id is
 * still the one that ended (and the one running when the words went in). Anything else — another
 * turn opened by a schedule, the Assistant or another chat — sends nothing: that turn may answer
 * someone else, and later turns are never judged for the reply (its own `turn_started` can still
 * claim it). Words queued behind a turn are never judged that way — they go into a later turn,
 * which is named when it opens, or never (the card is then opened again by the delivery
 * reconciler, and nothing is sent here).
 *
 * The answer is the turn's top-level text from the reply on, never tool output, thinking or a
 * subagent's text. It is kept per reply as blocks split at each top-level tool call, because the
 * manager is told to open its new card first and answer last, and a model does not always obey:
 * an answer written before the card's tool call, followed by "Card sent.", must still be the
 * answer. So the blocks are joined, one-line acknowledgements dropped when a real block exists
 * ({@link isThrowawayBlock}); a turn that wrote nothing else gets no follow-up. Each reply gets at
 * most one. Listeners on the chat lifecycle run on its hot path, so everything here only updates
 * memory; `deliver` is handed the result and must not block.
 */
import { CARD_FOLLOWUP_MAX_CHARS } from "../../shared/assistant-limits.ts";
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
  /** The turn's answer ({@link answerOf}), trimmed; never empty unless `stopped`. */
  text: string;
  /**
   * The turn the words went into was stopped or failed before it finished: its partial text is not
   * an answer (the words may never have been read), so `text` is empty and nothing is kept on the
   * card — only a reply typed on Telegram is told, since the user waits there for an answer.
   */
  stopped?: true;
  /** More text came than was kept: the rest is only in the chat. */
  overflow: boolean;
  /** Cards the manager made during that turn (a new card asking again, say). */
  newCards: Array<{ id: string; title: string }>;
}

export interface FollowupTrackerDeps {
  canonical(sessionId: string): string;
  /** Whether the session has no turn running now. */
  isIdle(sessionId: string): boolean;
  /** The id of the latest turn the session opened, kept past its end; undefined when unknown. */
  turnId(sessionId: string): string | undefined;
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

/** How long after a turn ends an unnamed reply is judged, so a queued turn can start first. */
export const FOLLOWUP_GRACE_MS = 3_000;
/** A reply whose turn never came is forgotten after this (a manager turn may run for hours). */
export const FOLLOWUP_MAX_AGE_MS = 12 * 60 * 60_000;
/** Text kept per reply; the follow-up shows far less, this only has to tell "cut" from "whole". */
export const FOLLOWUP_BUFFER_MAX = 6_000;
const MAX_PENDING = 200;

/** What a turn said, as it would be sent; `stopped` when it did not end normally. */
interface Buffer { text: string; overflow: boolean; stopped?: true }

/** How a turn ended (`turn_ended`): only `done` carries an answer. */
export type TurnOutcome = "done" | "stopped" | "failed";

/** A reply's own copy of the turn's text, one block per stretch between top-level tool calls. */
interface Collected { blocks: string[]; size: number; sawTool: boolean; overflow: boolean }

interface Pending {
  cardId: string;
  clientMessageId: string;
  origin: FollowupOrigin;
  sessionId: string;
  delivered: SessionDelivery | null;
  bound: boolean;
  /** The turn's text gathered for this reply; null while it is not in a turn (queued). */
  collect: Collected | null;
  /** What a turn of the chat ended with while the send had not returned yet, and that turn's id. */
  endedBeforeAttach: (Buffer & { turnId: string | undefined }) | null;
  /** An unnamed reply was judged against the first turn end after it went in; never again. */
  judged: boolean;
  /** For words pushed into a running turn: that turn's id when they went in. */
  turnAtInsert?: string | undefined;
  at: number;
  newCards: Array<{ id: string; title: string }>;
}

const collected = (): Collected => ({ blocks: [""], size: 0, sawTool: false, overflow: false });

/**
 * A line a model writes after a tool call to say it made it ("Card sent.", "Done — see above"):
 * one short line with no number and no question. Numbers and questions are what an answer to the
 * user's reply is made of, so a block carrying either is kept however short.
 */
export function isThrowawayBlock(block: string): boolean {
  const b = block.trim();
  return !b.includes("\n") && b.length < 40 && !/\d/.test(b) && !/[?？]/.test(b);
}

function append(c: Collected, text: string): void {
  c.blocks[c.blocks.length - 1] += text;
  c.size += text.length;
  // Memory is bounded per reply: the oldest blocks go first, since the answer comes last.
  while (c.size > FOLLOWUP_BUFFER_MAX && c.blocks.length > 1) {
    c.size -= c.blocks.shift()!.length;
    c.overflow = true;
  }
  if (c.size > FOLLOWUP_BUFFER_MAX) {
    c.blocks[0] = c.blocks[0]!.slice(0, FOLLOWUP_BUFFER_MAX);
    c.size = FOLLOWUP_BUFFER_MAX;
    c.overflow = true;
  }
}

/**
 * The answer in what a reply gathered: every block that is not a throwaway line (all of them when
 * the turn made no tool call — a short answer is still the answer), joined. When they do not fit
 * what the user is shown, the earliest blocks give way, because the rule puts the answer last.
 */
export function answerOf(c: Collected | null): Buffer {
  if (!c) return { text: "", overflow: false };
  let blocks = c.blocks.map((b) => b.trim()).filter(Boolean);
  if (c.sawTool) blocks = blocks.filter((b) => !isThrowawayBlock(b));
  let overflow = c.overflow;
  while (blocks.length > 1 && blocks.join("\n\n").length > CARD_FOLLOWUP_MAX_CHARS) {
    blocks.shift();
    overflow = true;
  }
  return { text: blocks.join("\n\n"), overflow };
}

export function createFollowupTracker(deps: FollowupTrackerDeps) {
  const pending = new Map<string, Pending>();
  const graceMs = deps.graceMs ?? FOLLOWUP_GRACE_MS;
  const maxAgeMs = deps.maxAgeMs ?? FOLLOWUP_MAX_AGE_MS;
  const key = (sessionId: string): string => deps.canonical(sessionId);
  const live = (p: Pending): boolean => pending.get(p.clientMessageId) === p;
  /** The replies followed in a chat. */
  const inSession = (session: string): Pending[] => [...pending.values()].filter((p) => key(p.sessionId) === session);

  function prune(): void {
    const now = deps.now();
    for (const [id, p] of pending) if (now - p.at > maxAgeMs) pending.delete(id);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
  }

  function finish(p: Pending, buffer: Buffer | undefined, session: string): void {
    if (!live(p)) return;
    pending.delete(p.clientMessageId);
    const base = { cardId: p.cardId, origin: p.origin, sessionId: session, newCards: p.newCards };
    if (buffer?.stopped) { deps.deliver({ ...base, text: "", overflow: false, stopped: true }); return; }
    const text = buffer?.text.trim() ?? "";
    if (!text) return;
    deps.deliver({ ...base, text, overflow: buffer!.overflow });
  }

  /**
   * The one judgement of an unnamed reply: after the grace, it belongs to the turn that ended only
   * if its own turn was not named meanwhile and nothing else has run since. Otherwise nothing is
   * sent, and it waits (until it ages out) for a `turn_started` that names it.
   */
  function judgeLater(p: Pending, buffer: Buffer, endedTurn: string | undefined): void {
    p.judged = true;
    p.collect = null;
    deps.setTimer(() => {
      if (!live(p) || p.bound) return;
      const session = key(p.sessionId);
      const sameTurn = deps.turnId(session) === endedTurn && (p.delivered !== "inserted" || p.turnAtInsert === endedTurn);
      if (deps.isIdle(session) && sameTurn) finish(p, buffer, session);
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
        // Gathered from the start of the send, in case the words open a turn before it returns.
        delivered: null, bound: false, collect: collected(), endedBeforeAttach: null, judged: false, at: deps.now(), newCards: [],
      };
      pending.set(p.clientMessageId, p);
      return {
        attach(delivered) {
          if (!live(p)) return;
          p.delivered = delivered ?? "started";
          if (p.bound) return;
          // Behind a running turn: nothing is theirs until the turn they open is named.
          if (p.delivered === "queued") { p.collect = null; return; }
          const ended = p.endedBeforeAttach;
          // The turn the words went into ended before the send returned: that end was the first.
          if (ended) {
            if (p.delivered === "inserted") p.turnAtInsert = ended.turnId;
            judgeLater(p, ended, ended.turnId);
            return;
          }
          // Joined a running turn: the answer is what follows the words, not what came before them.
          // Each reply gathers its own copy, so this starts nobody else's over.
          if (p.delivered === "inserted") {
            p.collect = collected();
            p.turnAtInsert = deps.turnId(key(p.sessionId));
          }
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
      if (ev.type === "turn_started" && typeof ev.clientMessageId === "string") {
        const p = pending.get(ev.clientMessageId);
        if (p) {
          p.bound = true;
          p.sessionId = sessionId;
          p.collect = collected();
        }
        return;
      }
      if (ev.parentToolUseId || (ev.type !== "text" && ev.type !== "tool_use")) return;
      for (const p of inSession(key(sessionId))) {
        if (!p.collect) continue;
        if (ev.type === "text" && typeof ev.content === "string") append(p.collect, ev.content);
        else if (ev.type === "tool_use") {
          // A top-level tool call ends a block; the blocks are sorted out when the turn ends.
          p.collect.blocks.push("");
          p.collect.sawTool = true;
        }
      }
    },

    /**
     * A chat's turn ended (`chatLifecycle` `turn_ended`). A builtin answering a message typed into a
     * running turn (`turnStillRunning`) is not its end. A turn stopped or failed has no answer.
     */
    onTurnEnded(sessionId: string, how: { outcome?: TurnOutcome; turnStillRunning?: boolean } = {}): void {
      if (how.turnStillRunning || pending.size === 0) return;
      const session = key(sessionId);
      const stopped = (how.outcome ?? "done") !== "done";
      for (const p of inSession(session)) {
        const buffer: Buffer = stopped ? { text: "", overflow: false, stopped: true } : answerOf(p.collect);
        if (p.bound) { finish(p, buffer, session); continue; }
        // Queued behind this turn, or judged already against an earlier one: not this turn's.
        if (p.delivered === "queued" || p.judged) continue;
        if (p.delivered === null) {
          // Only the first end counts; a later one before the send returns is not theirs.
          p.endedBeforeAttach ??= { ...buffer, turnId: deps.turnId(session) };
          p.collect = null;
        } else {
          // Unnamed, and not queued behind this turn: this is the first end after the words went in.
          judgeLater(p, buffer, deps.turnId(session));
        }
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

    /** The provider renamed the chat: the replies followed in it follow it. */
    onMigrated(oldSessionId: string, newSessionId: string): void {
      for (const p of pending.values()) if (p.sessionId === oldSessionId) p.sessionId = newSessionId;
    },

    /** Replies still waiting for their answer, for tests and the log. */
    size: (): number => pending.size,

    clear(): void {
      pending.clear();
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
