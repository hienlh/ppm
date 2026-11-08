/**
 * The history window: a block of a session's turns shown on their own, after a jump to a turn the
 * live list has not loaded.
 *
 * It is a state of its own, never spliced into the live messages. The live list assumes its array
 * ends at the newest message — streaming appends to it, the refetch at the end of a turn replaces
 * everything from an index to the end, and the reconnect replay trims by that same assumption — so
 * a block from the middle of the session placed in it would be torn by any of the three. Kept
 * apart, the live chat keeps streaming underneath untouched, and the window only has to know when
 * the live list has caught up with it (`canMergeToLive`).
 *
 * Pure: the reducer and the merge check, unit-tested on their own.
 */
import type { ChatMessage } from "../../types/chat";

/** Most turns the window keeps drawn; past this it drops turns from the far end. */
export const MAX_WINDOW_TURNS = 30;

export interface WindowTurn {
  turnId: string;
  n: number;
  status: "complete" | "running";
}

/** One answer of `GET /chat/sessions/:id/turn-window`. */
export interface TurnWindowPage {
  sessionId: string;
  turns: WindowTurn[];
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  latestTurnId: string | null;
}

export type LoadDirection = "older" | "newer";

export interface WindowView {
  mode: "window";
  turns: WindowTurn[];
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  /** The turn the jump asked for: landed on once, after the first layout. */
  targetTurnId: string;
  /** Bumped by every jump into the window, so asking for the same turn again lands again. */
  landing: number;
  latestTurnId: string | null;
  /** The page that last failed and why, so the sentinels stop asking until the reader retries. */
  loadError: { direction: LoadDirection; message: string } | null;
}

export type HistoryView = { mode: "live" } | WindowView;

export const LIVE_VIEW: HistoryView = { mode: "live" };

export type HistoryWindowAction =
  | { type: "enter"; page: TurnWindowPage; targetTurnId: string }
  | { type: "loading"; direction: LoadDirection }
  | { type: "loaded"; direction: LoadDirection; page: TurnWindowPage }
  | { type: "failed"; direction: LoadDirection; error: string }
  | { type: "exit" };

/**
 * The turn each message belongs to. A compaction marker carries no turn of its own; it sits
 * inside the turn it interrupted, so it goes with the message before it.
 */
function turnOfEach(messages: readonly ChatMessage[]): (string | undefined)[] {
  let current: string | undefined;
  return messages.map((m) => (current = m.turnId ?? current));
}

/** The messages of the turns in `keep`, in their order. */
function messagesOf(messages: readonly ChatMessage[], keep: ReadonlySet<string>): ChatMessage[] {
  const turns = turnOfEach(messages);
  return messages.filter((_, i) => turns[i] !== undefined && keep.has(turns[i]!));
}

function enter(page: TurnWindowPage, targetTurnId: string, landing: number): WindowView {
  return {
    mode: "window",
    turns: page.turns,
    messages: page.messages,
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
    loadingOlder: false,
    loadingNewer: false,
    targetTurnId,
    landing,
    latestTurnId: page.latestTurnId,
    loadError: null,
  };
}

/** Adds a page at one end, then drops turns past the cap from the other end. */
function grow(view: WindowView, direction: LoadDirection, page: TurnWindowPage): WindowView {
  const have = new Set(view.turns.map((t) => t.turnId));
  const fresh = page.turns.filter((t) => !have.has(t.turnId));
  const freshMessages = messagesOf(page.messages, new Set(fresh.map((t) => t.turnId)));
  let turns = direction === "older" ? [...fresh, ...view.turns] : [...view.turns, ...fresh];
  let messages = direction === "older" ? [...freshMessages, ...view.messages] : [...view.messages, ...freshMessages];
  let { hasOlder, hasNewer } = view;
  if (direction === "older") hasOlder = page.hasOlder;
  else hasNewer = page.hasNewer;
  if (turns.length > MAX_WINDOW_TURNS) {
    // Loading upward drops from the bottom and the reverse: the far end is what the reader left.
    turns = direction === "older" ? turns.slice(0, MAX_WINDOW_TURNS) : turns.slice(turns.length - MAX_WINDOW_TURNS);
    messages = messagesOf(messages, new Set(turns.map((t) => t.turnId)));
    if (direction === "older") hasNewer = true;
    else hasOlder = true;
  }
  return {
    ...view,
    turns,
    messages,
    hasOlder,
    hasNewer,
    loadingOlder: direction === "older" ? false : view.loadingOlder,
    loadingNewer: direction === "newer" ? false : view.loadingNewer,
    latestTurnId: page.latestTurnId,
  };
}

export function historyWindowReducer(view: HistoryView, action: HistoryWindowAction): HistoryView {
  switch (action.type) {
    case "enter":
      return enter(action.page, action.targetTurnId, view.mode === "window" ? view.landing + 1 : 1);
    case "exit":
      return LIVE_VIEW;
    case "loading":
      if (view.mode !== "window") return view;
      return action.direction === "older"
        ? { ...view, loadingOlder: true, loadError: null }
        : { ...view, loadingNewer: true, loadError: null };
    case "loaded":
      return view.mode === "window" ? grow(view, action.direction, action.page) : view;
    case "failed":
      if (view.mode !== "window") return view;
      return action.direction === "older"
        ? { ...view, loadingOlder: false, loadError: { direction: "older", message: action.error } }
        : { ...view, loadingNewer: false, loadError: { direction: "newer", message: action.error } };
  }
}

/**
 * Whether the live list now holds everything the window shows at its bottom, so the reader can be
 * handed back to it without losing anything.
 *
 * That needs the window's last turn in the live list whole: its first message there, and the live
 * list past its end — either a later turn has started, or it is the session's newest turn and
 * nothing is streaming. A turn the live list is still streaming is not whole, and neither is one
 * whose start the live list has not loaded. Matched by turn id, never by message id: a Codex
 * message is named by its position in whichever view parsed it, so the two lists' ids differ.
 */
export function canMergeToLive(view: WindowView, live: readonly ChatMessage[], liveStreaming: boolean): boolean {
  const last = view.turns[view.turns.length - 1];
  if (!last) return false;
  const start = live.findIndex((m) => m.turnId === last.turnId);
  if (start === -1 || live[start]!.role !== "user") return false;
  for (let i = start + 1; i < live.length; i++) {
    const m = live[i]!;
    // A later turn: stamped with another id, or a prompt sent here that is not stamped yet.
    if (m.turnId ? m.turnId !== last.turnId : m.role === "user") return true;
  }
  return !liveStreaming && last.turnId === view.latestTurnId;
}
