import type { ChatMessage } from "../../types/chat.ts";

/**
 * One window of a session's history, for `GET /sessions/:id/messages`.
 *
 * A chat tab used to receive every message since the last compaction on open, and render
 * every one of them — on a long session that is thousands of bubbles nobody scrolls to.
 * The client now asks for the newest page and fetches older pages as it scrolls up.
 *
 * Windows are index ranges into the provider's full, post-processed list. That list is
 * append-only between turns, so an index handed out for one page still names the same
 * message when the next, older page is asked for.
 */
export interface HistoryPage {
  messages: ChatMessage[];
  /** Index of `messages[0]` in the full list. `0` means nothing older exists. */
  start: number;
  /** Length of the full list. */
  total: number;
  /**
   * How many visible user messages precede the window. The client numbers user messages
   * to find their edit-version group (`userMessageOrdinals`); adding this keeps a window's
   * numbering identical to what the full list would give.
   */
  userOrdinalOffset: number;
  /**
   * The fork/edit anchor of `messages[0]`: the id of the nearest earlier message the
   * client would render, or null when there is none. The client anchors an edit or fork on
   * the PREVIOUS rendered message, which for the first message of a window is not loaded —
   * without this an edit there posted no anchor and the fork came out as an empty session.
   */
  predecessorId: string | null;
}

export interface HistoryPageQuery {
  /** Page size. Absent → the whole list (older clients). */
  limit?: number;
  /** Exclusive end index: the page holds the `limit` messages before it. */
  before?: number;
  /** Return everything from this index to the end (a refetch keeping what is loaded).
   *  When it is past the end, `limit` decides instead. */
  from?: number;
}

/** A user bubble the client renders — the same test `MessageList` filters on. */
function isVisibleUser(m: ChatMessage): boolean {
  return m.role === "user" && !!m.content && m.content.trim().length > 0;
}

/** Any message `MessageList` renders: user bubbles need text, the rest text or events. */
function isRendered(m: ChatMessage): boolean {
  if (m.role === "user") return isVisibleUser(m);
  return (!!m.content && m.content.trim().length > 0) || (m.events?.length ?? 0) > 0;
}

function predecessorOf(all: ChatMessage[], start: number): string | null {
  for (let i = start - 1; i >= 0; i--) {
    const m = all[i]!;
    // The same id the list hands to onFork/onEdit: the SDK's uuid where there is one.
    if (isRendered(m)) return m.sdkUuid ?? m.id ?? null;
  }
  return null;
}

/**
 * A page boundary is moved back to the turn's user message, so one turn is never split
 * across two pages (its copy-all text and file-change tray are computed over the whole
 * turn). The move is capped: a single turn with hundreds of tool calls would otherwise
 * turn a 50-message page into the whole session.
 */
function alignToTurnStart(all: ChatMessage[], start: number, maxExtra: number): number {
  for (let i = start; i >= 0 && start - i <= maxExtra; i--) {
    if (all[i]!.role === "user") return i;
  }
  return start;
}

function clampIndex(n: number | undefined, max: number): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return Math.min(Math.max(0, Math.floor(n)), max);
}

export function pageHistory(all: ChatMessage[], query: HistoryPageQuery): HistoryPage {
  const total = all.length;
  let start = 0;
  let end = total;

  const from = clampIndex(query.from, total);
  const limit = query.limit !== undefined && query.limit > 0 ? Math.floor(query.limit) : undefined;
  // A `from` past the end means the list shrank under the client (a compaction starts a
  // new, shorter segment); answering with an empty slice would leave it showing the old
  // one, so it gets the newest page instead.
  if (from !== undefined && (from < total || total === 0)) {
    start = from;
  } else if (limit !== undefined) {
    end = clampIndex(query.before, total) ?? total;
    start = Math.max(0, end - limit);
    if (start > 0) start = alignToTurnStart(all, start, limit);
  }

  let userOrdinalOffset = 0;
  for (let i = 0; i < start; i++) if (isVisibleUser(all[i]!)) userOrdinalOffset++;

  return { messages: all.slice(start, end), start, total, userOrdinalOffset, predecessorId: predecessorOf(all, start) };
}

/** Parse the paging query string; anything malformed is treated as absent. */
export function parseHistoryPageQuery(q: (name: string) => string | undefined): HistoryPageQuery {
  const num = (name: string) => {
    const raw = q(name);
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return { limit: num("limit"), before: num("before"), from: num("from") };
}
