/**
 * Shell-style recall over a chat session's past user messages.
 *
 * `index` counts back from the newest message (0 = newest, 1 = the one before
 * it, …); -1 means the composer holds a live draft rather than a recalled
 * message. `history` arrives oldest-first, matching transcript order.
 */
export interface HistoryStep {
  index: number;
  text: string;
}

/**
 * Move `delta` steps into the past (+1) or back toward the draft (-1).
 * Returns null when the step would fall outside the history.
 */
export function stepHistory(history: string[], index: number, delta: number): HistoryStep | null {
  if (history.length === 0) return null;
  const next = index + delta;
  if (next < -1 || next >= history.length) return null;
  return { index: next, text: next === -1 ? "" : history[history.length - 1 - next]! };
}
