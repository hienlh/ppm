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
 * answer. So the blocks are joined, lines that only confirm a tool call dropped
 * ({@link isConfirmationBlock}), short asides dropped only beside a longer real block
 * ({@link isThrowawayBlock}); a turn that wrote nothing but confirmations gets no follow-up. Each reply gets at
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
  /** When the user replied (the words were sent), on the tracker's clock. */
  repliedAt: number;
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
  /** The manager chat under its current id: resolved once, then moved by `turn_started` and `migrated`. */
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
 * A short line: one line, under 40 characters, no number and no question. It may be a model's
 * aside around a tool call ("Let me check…") — or the whole answer ("No, it is expensive.",
 * "Được anh."). So it gives way only to a longer real block in the same turn, never on its own.
 */
export function isThrowawayBlock(block: string): boolean {
  const b = block.trim();
  return !b.includes("\n") && b.length < 40 && !/\d/.test(b) && !/[?？]/.test(b);
}

/**
 * A line that only says a tool call was made ("Card sent.", "Đã gửi card.", "Done."): never an
 * answer, so it is dropped wherever it is. Anything else that is short is judged by
 * {@link isThrowawayBlock}, and only beside a longer block.
 */
const CONFIRMATION_RE = new RegExp(
  "^(?:(?:the |a |new )?(?:card|report|decision card)(?: has been| was| is)? (?:sent|filed|created|opened|posted)"
  + "|(?:i(?:'ve| have)? )?(?:sent|filed|opened|created|posted) (?:the |a |it )?(?:new )?(?:card|report)"
  + "|(?:đã )?(?:gửi|tạo|mở|báo)(?: xong)? (?:card|thẻ|báo cáo)(?: mới)?(?: rồi)?(?: ạ| anh)?"
  + "|(?:card|thẻ)(?: mới)? đã (?:được )?(?:gửi|tạo|mở)(?: rồi)?(?: ạ)?"
  + "|done|sent|reported|xong(?: rồi)?(?: ạ)?|đã gửi(?: ạ)?)[\\s.!…]*$",
  "i",
);

export function isConfirmationBlock(block: string): boolean {
  return CONFIRMATION_RE.test(block.trim());
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
 * Not `turn_ended.finalText`: `ws/chat.ts` keeps its own copy of a turn's last text for the
 * notification and `session_status` (`entry.finalText`, from the start of the turn, only after its
 * last tool call, cut to `FINAL_TEXT_KEEP`). A card reply needs a different cut — from where the
 * words went in, every block rather than the last, and room for `CARD_FOLLOWUP_MAX_CHARS` — so the
 * text is gathered here a second time rather than stretching that one to serve both.
 *
 * The answer in what a reply gathered. With no tool call it is the whole text, however short.
 * Around tool calls: lines that only confirm a tool call go; short lines go only when a longer real
 * block is there to be the answer; with none, the last remaining block is it — a lost short answer
 * costs more than a stray aside. When they do not fit what the user is shown, the earliest blocks
 * give way, because the rule puts the answer last.
 */
export function answerOf(c: Collected | null): Buffer {
  if (!c) return { text: "", overflow: false };
  let blocks = c.blocks.map((b) => b.trim()).filter(Boolean);
  if (c.sawTool) {
    const kept = blocks.filter((b) => !isConfirmationBlock(b));
    const real = kept.filter((b) => !isThrowawayBlock(b));
    blocks = real.length > 0 ? real : kept.slice(-1);
  }
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
  /**
   * The chats a reply is followed in. Every streamed event of every chat passes through here, so
   * the hot path asks this set and nothing else: `canonical` is a database lookup (a chain of
   * provider renames), paid once per reply when it is registered and once per card made.
   */
  let watched = new Set<string>();
  const rewatch = (): void => { watched = new Set([...pending.values()].map((p) => p.sessionId)); };
  const live = (p: Pending): boolean => pending.get(p.clientMessageId) === p;
  /** The replies followed in a chat. */
  const inSession = (session: string): Pending[] => [...pending.values()].filter((p) => p.sessionId === session);
  const forget = (p: Pending): void => { if (live(p)) { pending.delete(p.clientMessageId); rewatch(); } };

  function prune(): void {
    const now = deps.now();
    for (const [id, p] of pending) if (now - p.at > maxAgeMs) pending.delete(id);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
    rewatch();
  }

  function finish(p: Pending, buffer: Buffer | undefined, session: string): void {
    if (!live(p)) return;
    forget(p);
    const base = { cardId: p.cardId, origin: p.origin, sessionId: session, newCards: p.newCards, repliedAt: p.at };
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
      const session = p.sessionId;
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
        cardId: input.cardId, clientMessageId: input.clientMessageId, origin: input.origin, sessionId: deps.canonical(input.sessionId),
        // Gathered from the start of the send, in case the words open a turn before it returns.
        delivered: null, bound: false, collect: collected(), endedBeforeAttach: null, judged: false, at: deps.now(), newCards: [],
      };
      pending.set(p.clientMessageId, p);
      rewatch();
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
            p.turnAtInsert = deps.turnId(p.sessionId);
          }
        },
        abandon() {
          forget(p);
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
          rewatch();
        }
        return;
      }
      if (!watched.has(sessionId) || ev.parentToolUseId || (ev.type !== "text" && ev.type !== "tool_use")) return;
      for (const p of inSession(sessionId)) {
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
      if (how.turnStillRunning || !watched.has(sessionId)) return;
      const session = sessionId;
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

    /**
     * A card was made: one the replied-to manager made while answering goes with the answer. Only
     * while the reply is gathering its turn — named and running, or pushed into the running turn and
     * not judged yet — so a card a schedule's turn made before or after is never named as its.
     */
    onCardCreated(card: { id: string; title: string; sessionId: string | null }): void {
      if (!card.sessionId || pending.size === 0) return;
      const session = watched.has(card.sessionId) ? card.sessionId : deps.canonical(card.sessionId);
      for (const p of pending.values()) {
        if (p.sessionId === session && p.collect && (p.bound || (p.delivered !== null && p.delivered !== "queued"))) {
          p.newCards.push({ id: card.id, title: card.title });
        }
      }
    },

    /** The provider renamed the chat: the replies followed in it follow it. */
    onMigrated(oldSessionId: string, newSessionId: string): void {
      if (!watched.has(oldSessionId)) return;
      for (const p of pending.values()) if (p.sessionId === oldSessionId) p.sessionId = newSessionId;
      rewatch();
    },

    /** Replies still waiting for their answer, for tests and the log. */
    size: (): number => pending.size,

    clear(): void {
      pending.clear();
      rewatch();
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
